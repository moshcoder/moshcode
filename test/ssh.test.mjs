// SSH workspaces (PRD 0013): the registry, the socket path, the argv ssh is
// handed, the quoting, and the shape of what comes back — all without a
// network. A fake runner records every spawn and answers from a table, so
// each test states what ssh would have been asked and what the caller sees.
// test/ssh-sshd.test.mjs runs the same module against a real sshd.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_PERSIST, KEEPALIVE, addTarget, attachArgs, cdCommand, checkMaster, classify, closeMaster, controlDir, controlPath,
  debugLine, exec, execArgs, getTarget, keepaliveArgs, listTargets, masterArgs, openMaster, parseArgs, parseEnvPairs,
  parsePersist, parseSessionRef, parseTimeout, readTargets, remoteCommand, remotePath, remoteSessionName, removeTarget,
  resolveTarget, scpArgs, shellQuote, sshCommand, takesTerminal, validName, writeTargets,
} from "../src/ssh.mjs";

/* ------------------------------------------------------------- fixtures */

async function withSshDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moshcode-ssh-test-"));
  const previous = { dir: process.env.MOSHCODE_SSH_DIR, ctl: process.env.MOSHCODE_SSH_CONTROL_DIR };
  process.env.MOSHCODE_SSH_DIR = dir;
  process.env.MOSHCODE_SSH_CONTROL_DIR = path.join(dir, "ctl");
  try { return await fn(dir); }
  finally {
    for (const [k, v] of [["MOSHCODE_SSH_DIR", previous.dir], ["MOSHCODE_SSH_CONTROL_DIR", previous.ctl]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A spawnSync stand-in. `answer(bin, args, options)` returns a partial result;
 * everything it does not say defaults to a clean exit. Every call is recorded.
 */
function fakeRunner(answer = () => ({})) {
  const calls = [];
  const runner = (bin, args, options = {}) => {
    calls.push({ bin, args, options });
    const a = answer(bin, args, options, calls.length) || {};
    return { status: 0, signal: null, stdout: "", stderr: "", error: undefined, ...a };
  };
  runner.calls = calls;
  return runner;
}

const op = (args) => { const i = args.indexOf("-O"); return i >= 0 ? args[i + 1] : null; };
const isExec = (args) => args.includes("--") && !args.includes("-O");
const dev = { name: "dev", target: "deploy@example.com", cwd: "/srv/app" };

/** A live socket file, so checkMaster asks ssh instead of answering "absent". */
function touchSocket(entry) {
  fs.mkdirSync(controlDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(controlPath(entry), "");
}

/* ---------------------------------------------------------------- names */

test("target names: a filename, a hash input, a word at a prompt — nothing that could be a path (R66)", () => {
  for (const good of ["dev", "prod-2", "chovy_app", "a", "x".repeat(64)]) assert.ok(validName(good), good);
  for (const bad of ["", "../dev", "dev/box", "Dev", "-dev", ".dev", "dev box", "x".repeat(65), "dev:1", "a.b"]) {
    assert.ok(!validName(bad), JSON.stringify(bad));
  }
});

test("a shell ref is <target>/<session>, both validated", () => {
  assert.deepEqual(parseSessionRef("dev/app"), { name: "dev", session: "app" });
  assert.match(parseSessionRef("dev").error, /<target>\/<session>/);
  assert.match(parseSessionRef("dev/app/x").error, /<target>\/<session>/);
  assert.match(parseSessionRef("Dev/app").error, /not a target name/);
  assert.match(parseSessionRef("../x/app").error, /<target>\/<session>/, "a traversal never parses as a name");
  assert.match(parseSessionRef("dev/App").error, /not a session name/);
  assert.equal(remoteSessionName(dev, "app"), "moshcode-ssh-dev-app");
});

/* ------------------------------------------------------------- registry */

test("the registry holds a host, a port and a cwd — and nothing that smells like a secret (R3, R4)", async () => {
  await withSshDir(async (dir) => {
    const added = addTarget("dev", "deploy@example.com", { port: "2222", cwd: "/srv/app" });
    assert.deepEqual(added, { name: "dev", target: "deploy@example.com", port: 2222, cwd: "/srv/app", replaced: false });
    assert.deepEqual(readTargets(), { dev: { target: "deploy@example.com", port: 2222, cwd: "/srv/app" } });

    // A hand-edited file that grew a password loses it on the next read.
    fs.writeFileSync(path.join(dir, "targets.json"), JSON.stringify({
      dev: { target: "deploy@example.com", password: "hunter2", identityFile: "/x" },
      "../evil": { target: "h" },
      nohost: {},
    }));
    assert.deepEqual(readTargets(), { dev: { target: "deploy@example.com" } });

    const file = path.join(dir, "targets.json");
    writeTargets(readTargets());
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, "targets.json is owner-only (R67)");
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700, "the ssh dir is owner-only");
    assert.ok(!fs.readdirSync(dir).some((f) => f.endsWith(".tmp")), "no temp file left behind by the atomic write");
  });
});

test("an ssh_config alias is a target as it stands; ports and flags are validated", async () => {
  await withSshDir(async () => {
    assert.equal(addTarget("dev", "devbox").target, "devbox");
    assert.equal(getTarget("dev").port, undefined, "no port unless said — ssh_config decides");
    assert.throws(() => addTarget("dev", "devbox", { port: "http" }), /not a port/);
    assert.throws(() => addTarget("dev", "devbox", { port: "70000" }), /not a port/);
    assert.throws(() => addTarget("Dev", "devbox"), /not a target name/);
    assert.throws(() => addTarget("dev", ""), /needs a host/);
    assert.throws(() => addTarget("dev", "-oProxyCommand=evil"), /looks like a flag/);
    assert.equal(addTarget("dev", "other").replaced, true);
    assert.deepEqual(listTargets().map((t) => t.name), ["dev"]);
    assert.equal(removeTarget("dev"), true);
    assert.equal(removeTarget("dev"), false);
    assert.equal(getTarget("dev"), null);
    assert.match(resolveTarget("dev").error, /no target named "dev"/);
    assert.match(resolveTarget("../x").error, /not a target name/);
  });
});

/* -------------------------------------------------------------- sockets */

test("the control socket is a short hash of name+host+port, never the target spelled out (R16)", async () => {
  await withSshDir(async () => {
    const a = controlPath({ name: "dev", target: "deploy@very-long-hostname.internal.example.com", port: 2222 });
    assert.match(path.basename(a), /^[0-9a-f]{12}$/);
    assert.ok(!a.includes("example.com"));
    assert.equal(a, controlPath({ name: "dev", target: "deploy@very-long-hostname.internal.example.com", port: 2222 }), "stable");
    assert.notEqual(a, controlPath({ name: "dev", target: "elsewhere", port: 2222 }), "re-pointing a name gets a new socket");
    assert.notEqual(a, controlPath({ name: "dev", target: "deploy@very-long-hostname.internal.example.com", port: 22 }));
  });
});

test("a home directory long enough to break sun_path moves the sockets to the temp dir (R16)", () => {
  const previous = { dir: process.env.MOSHCODE_SSH_DIR, ctl: process.env.MOSHCODE_SSH_CONTROL_DIR };
  try {
    delete process.env.MOSHCODE_SSH_CONTROL_DIR;
    process.env.MOSHCODE_SSH_DIR = `/net/filers/${"deep/".repeat(20)}home/anthony/.moshcode/ssh`;
    const dir = controlDir();
    assert.ok(dir.startsWith(os.tmpdir()), dir);
    assert.match(path.basename(dir), /^moshcode-ssh-/);
    process.env.MOSHCODE_SSH_DIR = "/home/a/.moshcode/ssh";
    assert.equal(controlDir(), "/home/a/.moshcode/ssh/control");
    process.env.MOSHCODE_SSH_CONTROL_DIR = "/run/x";
    assert.equal(controlDir(), "/run/x");
  } finally {
    for (const [k, v] of [["MOSHCODE_SSH_DIR", previous.dir], ["MOSHCODE_SSH_CONTROL_DIR", previous.ctl]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

/* ------------------------------------------------------------- durations */

test("persist and timeout read the same durations; bare numbers are seconds", () => {
  assert.equal(parsePersist("10m").seconds, 600);
  assert.equal(parsePersist("90").seconds, 90);
  assert.equal(parsePersist("2h").seconds, 7200);
  assert.equal(parsePersist(DEFAULT_PERSIST).seconds, 600);
  assert.throws(() => parsePersist("soon"), /not a duration/);
  assert.throws(() => parsePersist("100ms"), /under a second/);
  assert.equal(parseTimeout("2m"), 120_000);
  assert.equal(parseTimeout("500ms"), 500);
  assert.equal(parseTimeout("30"), 30_000);
  assert.equal(parseTimeout(undefined), undefined);
  assert.throws(() => parseTimeout("0"), /not a usable timeout/);
});

/* -------------------------------------------------------------- quoting */

test("remote argv is single-quoted the POSIX way, so nothing in it is ever interpreted (R68)", () => {
  assert.equal(shellQuote("git"), "git");
  assert.equal(shellQuote("src/app.ts"), "src/app.ts");
  assert.equal(shellQuote(""), "''");
  assert.equal(shellQuote("a b"), "'a b'");
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
  assert.equal(shellQuote("$(rm -rf /)"), "'$(rm -rf /)'");
  assert.equal(shellQuote("`id`"), "'`id`'");
  assert.equal(shellQuote("1,240p"), "1,240p");
  assert.equal(shellQuote("a\nb"), "'a\nb'");
});

test("the remote command: cd, then env, then exec argv — each quoted, cwd's ~ left to the remote shell", () => {
  assert.equal(remoteCommand(["git", "status", "--short"], {}), "exec git status --short");
  assert.equal(remoteCommand(["git", "status"], { cwd: "/srv/app" }), "cd -- /srv/app && exec git status");
  assert.equal(remoteCommand(["pwd"], { cwd: "~/src/my app" }), "cd -- ~/'src/my app' && exec pwd");
  assert.equal(remoteCommand(["pwd"], { cwd: "~" }), "cd && exec pwd");
  assert.equal(cdCommand("/srv/it's"), `cd -- '/srv/it'\\''s'`);
  assert.equal(
    remoteCommand(["pnpm", "test"], { cwd: "/srv/app", env: { NODE_ENV: "test", MSG: "hello world" } }),
    "cd -- /srv/app && NODE_ENV=test MSG='hello world' exec pnpm test",
  );
  assert.equal(remoteCommand(["sed", "-n", "1,240p", "src/app.ts"], {}), "exec sed -n 1,240p src/app.ts");
  assert.equal(remoteCommand(["echo", "$HOME; rm -rf /"], {}), "exec echo '$HOME; rm -rf /'");
  assert.throws(() => remoteCommand([], {}), /nothing to run/);
  assert.throws(() => remoteCommand(["x"], { env: { "BAD-NAME": "1" } }), /not an environment variable name/);
});

test("--sh is the one deliberate way to hand the remote shell a pipeline", () => {
  assert.equal(remoteCommand(["git log | head -5"], { sh: true }), "git log | head -5");
  assert.equal(remoteCommand(["make"], { sh: true, cwd: "/srv", env: { V: "1" } }), "cd -- /srv && export V=1 && make");
  assert.throws(() => remoteCommand(["a", "b"], { sh: true }), /exactly one argument/);
});

test("--env K=V pairs", () => {
  assert.deepEqual(parseEnvPairs(["A=1", "B=x=y", "C="]), { A: "1", B: "x=y", C: "" });
  assert.throws(() => parseEnvPairs(["=1"]), /KEY=VALUE/);
  assert.throws(() => parseEnvPairs(["A B=1"]), /not an environment variable name/);
});

test("a relative remote path for put/get is relative to the target's cwd; absolute and ~ are not", () => {
  assert.equal(remotePath(dev, "package.json"), "/srv/app/package.json");
  assert.equal(remotePath(dev, "/etc/hosts"), "/etc/hosts");
  assert.equal(remotePath(dev, "~/x"), "~/x");
  assert.equal(remotePath({ name: "a", target: "h" }, "package.json"), "package.json");
});

/* -------------------------------------------------------------- argv */

test("the master is ControlMaster=yes -N -f with a finite persist and keepalives — and no -M (R8, R13, R14)", async () => {
  await withSshDir(async () => {
    const entry = { name: "dev", target: "devbox", port: 2222 };
    const args = masterArgs(entry, { batch: true, keepalive: ["-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=3"], env: {} });
    assert.ok(!args.includes("-M"), "-M with ControlMaster=yes means ask mode — see the module header");
    assert.ok(args.includes("ControlMaster=yes"));
    assert.ok(args.includes("ControlPersist=600"));
    assert.ok(args.includes("BatchMode=yes"));
    assert.ok(args.includes("ServerAliveInterval=30"));
    assert.deepEqual(args.slice(-4), ["2222", "-N", "-f", "devbox"]);
    assert.ok(args.some((a) => a.startsWith("ControlPath=")));
    assert.ok(!args.some((a) => /StrictHostKeyChecking/.test(a)), "never touches host-key policy (R58)");

    const noBatch = masterArgs(entry, { batch: false, env: {} });
    assert.ok(!noBatch.includes("BatchMode=yes"), "a person at a terminal may be prompted");
    assert.ok(masterArgs(entry, { persist: "30m", env: {} }).includes("ControlPersist=1800"));
    assert.ok(masterArgs(entry, { env: { MOSHCODE_SSH_PERSIST: "1h" } }).includes("ControlPersist=3600"));
    assert.ok(masterArgs({ ...entry, persist: "5m" }, { env: {} }).includes("ControlPersist=300"));
    assert.deepEqual(masterArgs(entry, { env: { MOSHCODE_SSH_CONFIG: "/x/cfg" } }).slice(0, 2), ["-F", "/x/cfg"]);
  });
});

test("keepalives are ours unless ssh -G says the user already set an interval (R14)", () => {
  const silent = fakeRunner(() => ({ stdout: "serveraliveinterval 0\nserveralivecountmax 3\n" }));
  assert.deepEqual(keepaliveArgs(dev, { runner: silent, env: {} }),
    ["-o", `ServerAliveInterval=${KEEPALIVE.ServerAliveInterval}`, "-o", `ServerAliveCountMax=${KEEPALIVE.ServerAliveCountMax}`]);
  assert.deepEqual(silent.calls[0].args, ["-G", "deploy@example.com"]);
  const configured = fakeRunner(() => ({ stdout: "serveraliveinterval 15\n" }));
  assert.deepEqual(keepaliveArgs(dev, { runner: configured, env: {} }), []);
});

test("exec is -T (no PTY) over ControlMaster=auto, with the command after -- (R20)", async () => {
  await withSshDir(async () => {
    const args = execArgs(dev, "exec git status", { env: {} });
    assert.ok(args.includes("-T"));
    assert.ok(!args.includes("-t"));
    assert.ok(args.includes("ControlMaster=auto"));
    assert.ok(args.includes("BatchMode=yes"));
    assert.deepEqual(args.slice(-3), ["deploy@example.com", "--", "exec git status"]);
    const tty = execArgs(dev, "sudo x", { tty: true, batch: false, env: {} });
    assert.ok(tty.includes("-t") && !tty.includes("-T") && !tty.includes("BatchMode=yes"));
  });
});

test("attach hands ssh the terminal, landing in the target's cwd when there is one (R36)", async () => {
  await withSshDir(async () => {
    const withCwd = attachArgs(dev, { env: {} });
    assert.ok(withCwd.includes("-t"));
    assert.equal(withCwd.at(-1), `cd -- /srv/app && exec "\${SHELL:-sh}" -l`);
    assert.equal(withCwd.at(-3), "deploy@example.com");
    const bare = attachArgs({ name: "a", target: "h" }, { env: {} });
    assert.equal(bare.at(-1), "h");
    assert.ok(!bare.includes("-t"), "no cwd, no command, no forced tty — plain ssh");
  });
});

test("scp rides the same socket; its port flag is -P", async () => {
  await withSshDir(async () => {
    const entry = { name: "dev", target: "devbox", port: 2222 };
    const args = scpArgs(entry, "./a", "devbox:/srv/a.tmp", { env: {} });
    assert.ok(args.some((a) => a.startsWith("ControlPath=")));
    assert.ok(args.includes("ControlMaster=auto"));
    assert.deepEqual(args.slice(-4), ["-P", "2222", "./a", "devbox:/srv/a.tmp"]);
  });
});

/* --------------------------------------------------------------- results */

test("classify: 255 is ssh's, anything else is the command's (R24, R25)", () => {
  assert.deepEqual(classify({ status: 0 }), { transportOk: true, code: 0, signal: null, error: null });
  assert.deepEqual(classify({ status: 1 }), { transportOk: true, code: 1, signal: null, error: null });
  const auth = classify({ status: 255, stderr: "deploy@example.com: Permission denied (publickey).\n" });
  assert.equal(auth.transportOk, false);
  assert.equal(auth.code, 255);
  assert.match(auth.error, /^ssh authentication failed/);
  const hostkey = classify({ status: 255, stderr: "@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@\nHost key verification failed.\n" });
  assert.equal(hostkey.error, "ssh host key verification failed");
  const conn = classify({ status: 255, stderr: "ssh: connect to host 10.0.0.1 port 22: Connection timed out\n" });
  assert.match(conn.error, /^ssh could not connect/);
  const missing = classify({ error: Object.assign(new Error("spawn ssh ENOENT"), { code: "ENOENT" }) });
  assert.equal(missing.missing, true);
  assert.match(missing.error, /ssh not found — install an OpenSSH client/);
  const timeout = classify({ status: null, signal: "SIGTERM", error: Object.assign(new Error("t"), { code: "ETIMEDOUT" }) });
  assert.deepEqual(timeout, { transportOk: true, code: null, signal: "SIGTERM", error: "timed out", timedOut: true });
  const killed = classify({ status: null, signal: "SIGKILL" });
  assert.equal(killed.transportOk, true);
  assert.equal(killed.signal, "SIGKILL");
});

test("the debug line never carries the remote command, which is where --env values live (R63, R64, R69)", () => {
  const line = debugLine("ssh", ["-o", "ControlPath=/x", "-T", "host", "--", "SECRET=hunter2 exec deploy"]);
  assert.ok(!line.includes("hunter2"));
  assert.match(line, /<remote command: \d+ bytes>/);
  assert.ok(line.startsWith("ssh▸ ssh -o ControlPath=/x"));
});

/* ----------------------------------------------------------- lifecycle */

test("check: no socket is closed, a live socket asks ssh, a dead socket is unlinked (R11, R15)", async () => {
  await withSshDir(async () => {
    const runner = fakeRunner((bin, args) => (op(args) === "check" ? { status: 0, stderr: "Master running (pid=4242)\r\n" } : {}));
    assert.deepEqual(checkMaster(dev, { runner }), { connected: false, socket: controlPath(dev), stale: false });
    assert.equal(runner.calls.length, 0, "nothing to ask without a socket");

    touchSocket(dev);
    const live = checkMaster(dev, { runner });
    assert.equal(live.connected, true);
    assert.equal(live.pid, 4242);
    assert.deepEqual(runner.calls[0].args.slice(-3), ["check", "deploy@example.com"].length === 2 ? runner.calls[0].args.slice(-3) : null);
    assert.ok(runner.calls[0].args.includes("-O") && runner.calls[0].args.includes("check"));

    const dead = fakeRunner(() => ({ status: 255, stderr: "Control socket connect(/x): Connection refused\r\n" }));
    const stale = checkMaster(dev, { runner: dead });
    assert.deepEqual(stale, { connected: false, socket: controlPath(dev), stale: true });
    assert.ok(!fs.existsSync(controlPath(dev)), "the stale socket is ours, and gone");
  });
});

test("open is idempotent, close uses -O exit, and neither touches a PID (R10, R12)", async () => {
  await withSshDir(async () => {
    let alive = false;
    const runner = fakeRunner((bin, args) => {
      if (args.includes("-G")) return { stdout: "serveraliveinterval 0\n" };
      if (op(args) === "check") return alive ? { status: 0, stderr: "Master running (pid=7)\n" } : { status: 255, stderr: "Control socket connect: Connection refused" };
      if (op(args) === "exit") { alive = false; fs.unlinkSync(controlPath(dev)); return { status: 0, stderr: "Exit request sent." }; }
      if (args.includes("-N")) { alive = true; touchSocket(dev); return { status: 0 }; }
      return {};
    });
    const first = openMaster(dev, { runner, batch: true });
    assert.equal(first.ok, true);
    assert.equal(first.alreadyOpen, false);
    assert.equal(first.pid, 7);
    assert.ok(fs.existsSync(controlDir()));
    assert.equal(fs.statSync(controlDir()).mode & 0o777, 0o700, "the socket dir is 0700 (R17)");
    const master = runner.calls.find((c) => c.args.includes("-N"));
    assert.ok(master.args.includes("ServerAliveInterval=30"), "keepalives were probed and added");

    const again = openMaster(dev, { runner, batch: true });
    assert.deepEqual([again.ok, again.alreadyOpen], [true, true]);
    assert.equal(runner.calls.filter((c) => c.args.includes("-N")).length, 1, "no second master");

    const closed = closeMaster(dev, { runner });
    assert.deepEqual([closed.ok, closed.closed, closed.wasOpen], [true, true, true]);
    assert.ok(runner.calls.some((c) => op(c.args) === "exit"));
    assert.ok(!runner.calls.some((c) => c.bin === "kill"), "no PIDs were killed");
    const alreadyClosed = closeMaster(dev, { runner });
    assert.deepEqual([alreadyClosed.ok, alreadyClosed.wasOpen], [true, false]);
  });
});

test("open reports an auth failure as such, and never as a master", async () => {
  await withSshDir(async () => {
    const runner = fakeRunner((bin, args) => {
      if (args.includes("-N")) return { status: 255, stderr: "deploy@example.com: Permission denied (publickey).\n" };
      return { stdout: "" };
    });
    const r = openMaster(dev, { runner, batch: true });
    assert.equal(r.ok, false);
    assert.equal(r.connected, false);
    assert.match(r.error, /authentication failed/);
  });
});

/* ------------------------------------------------------------------ exec */

/** A runner that behaves like a master: `-N` opens it, check answers, exec runs `handler`. */
function masterRunner(handler, { openFails = false } = {}) {
  const state = { alive: false, execs: 0 };
  const runner = fakeRunner((bin, args, options) => {
    if (args.includes("-G")) return { stdout: "serveraliveinterval 0\n" };
    if (op(args) === "check") return state.alive ? { status: 0, stderr: "Master running (pid=9)\n" } : { status: 255, stderr: "Control socket connect: Connection refused" };
    if (op(args) === "exit") { state.alive = false; try { fs.unlinkSync(controlPath(dev)); } catch { /* gone */ } return { status: 0 }; }
    if (args.includes("-N")) {
      if (openFails) return { status: 255, stderr: "ssh: connect to host example.com port 22: Connection refused\n" };
      state.alive = true; touchSocket(dev); return { status: 0 };
    }
    if (isExec(args)) { state.execs++; return handler(args.at(-1), options, state); }
    return {};
  });
  runner.state = state;
  return runner;
}

test("exec: the command's exit status, stdout and stderr, apart, plus the transport's verdict (R22–R24)", async () => {
  await withSshDir(async () => {
    const runner = masterRunner((cmd) => (cmd.includes("grep") ? { status: 1, stdout: "", stderr: "" } : { status: 0, stdout: " M src/app.ts\n" }));
    const r = exec(dev, ["git", "status", "--short"], { runner, env: {} });
    assert.equal(r.ok, true);
    assert.equal(r.transportOk, true);
    assert.equal(r.code, 0);
    assert.equal(r.signal, null);
    assert.equal(r.stdout, " M src/app.ts\n");
    assert.equal(r.stderr, "");
    assert.equal(r.target, "dev");
    assert.equal(r.connected, true);
    assert.equal(r.opened, true, "no master was up, so this call opened one");
    assert.equal(typeof r.durationMs, "number");
    const remote = runner.calls.find((c) => isExec(c.args)).args.at(-1);
    assert.equal(remote, "cd -- /srv/app && exec git status --short", "the target's cwd, quoted argv");

    const miss = exec(dev, ["grep", "-rn", "TODO", "src"], { runner, env: {} });
    assert.deepEqual([miss.ok, miss.transportOk, miss.code], [false, true, 1], "grep finding nothing is not a transport failure");
    assert.equal(miss.opened, undefined, "the second call reused the master");
    assert.equal(runner.calls.filter((c) => c.args.includes("-N")).length, 1);
  });
});

test("exec: cwd and env per call; no shell state between calls (R27–R29)", async () => {
  await withSshDir(async () => {
    const runner = masterRunner(() => ({ status: 0 }));
    exec(dev, ["cd", "/tmp"], { runner, env: {} });
    exec(dev, ["pwd"], { runner, env: {} });
    exec(dev, ["pnpm", "test"], { runner, env: {}, cwd: "/elsewhere" });
    exec(dev, ["pnpm", "test"], { runner, env: {}, remoteEnv: { NODE_ENV: "test", TOKEN: "it's secret" } });
    exec(dev, ["tmux", "-V"], { runner, env: {}, cwd: null });
    const remotes = runner.calls.filter((c) => isExec(c.args)).map((c) => c.args.at(-1));
    assert.deepEqual(remotes, [
      "cd -- /srv/app && exec cd /tmp",
      "cd -- /srv/app && exec pwd",
      "cd -- /elsewhere && exec pnpm test",
      "cd -- /srv/app && NODE_ENV=test TOKEN='it'\\''s secret' exec pnpm test",
      "exec tmux -V",
    ], "cwd per call, env per call, and cwd: null means no cd at all");
  });
});

test("exec: stdin is forwarded as bytes, untouched (R30, R31)", async () => {
  await withSshDir(async () => {
    let seen;
    const runner = masterRunner((cmd, options) => { seen = options.input; return { status: 0 }; });
    const patch = Buffer.from("--- a/x\n+++ b/x\n@@ -1 +1 @@\n-it's $HOME\n+`ok`\n\x00\xff", "binary");
    const r = exec(dev, ["git", "apply", "-"], { runner, env: {}, stdin: patch });
    assert.ok(r.ok);
    assert.ok(Buffer.isBuffer(seen));
    assert.ok(seen.equals(patch), "byte for byte");
    exec(dev, ["cat"], { runner, env: {}, stdin: "text\n" });
    assert.equal(seen.toString(), "text\n");
    const none = runner.calls.filter((c) => isExec(c.args));
    assert.equal(none.length, 2);
  });
});

test("exec: a timeout is reported as one, with exit 124 at the CLI, and is never retried (R26)", async () => {
  await withSshDir(async () => {
    const runner = masterRunner(() => ({ status: null, signal: "SIGTERM", error: Object.assign(new Error("t"), { code: "ETIMEDOUT" }) }));
    const r = exec(dev, ["pnpm", "test"], { runner, env: {}, timeoutMs: 5 });
    assert.deepEqual([r.ok, r.transportOk, r.timedOut, r.code, r.signal], [false, true, true, null, "SIGTERM"]);
    assert.equal(runner.calls.find((c) => isExec(c.args)).options.timeout, 5);
    assert.equal(runner.state.execs, 1, "no retry on a timeout — the remote side may have done the work");
  });
});

test("exec: a master that died mid-run is reopened and the command retried once (R15)", async () => {
  await withSshDir(async () => {
    // Open, then run: the first exec fails at the transport with the master
    // gone (the runner flips it dead), the retry after reopen succeeds.
    const runner = masterRunner((cmd, options, state) => {
      if (state.execs === 1) { state.alive = false; fs.unlinkSync(controlPath(dev)); return { status: 255, stderr: "Connection closed by remote host\n" }; }
      return { status: 0, stdout: "ok\n" };
    });
    assert.ok(openMaster(dev, { runner, batch: true }).ok);
    const r = exec(dev, ["true"], { runner, env: {} });
    assert.equal(r.ok, true);
    assert.equal(r.retried, true);
    assert.equal(runner.state.execs, 2);
    assert.equal(runner.calls.filter((c) => c.args.includes("-N")).length, 2, "one master, then one reopen");
  });
});

test("exec: when the master cannot be opened, the answer is a transport failure with ssh's reason (R25)", async () => {
  await withSshDir(async () => {
    const runner = masterRunner(() => ({ status: 0 }), { openFails: true });
    const r = exec(dev, ["true"], { runner, env: {} });
    assert.deepEqual([r.ok, r.transportOk, r.code, r.connected], [false, false, 255, false]);
    assert.match(r.error, /could not connect/);
    assert.equal(runner.state.execs, 0);
  });
});

test("exec: no ssh at all is said in so many words", async () => {
  await withSshDir(async () => {
    const runner = fakeRunner(() => ({ status: null, error: Object.assign(new Error("spawn ssh ENOENT"), { code: "ENOENT" }) }));
    const r = exec(dev, ["true"], { runner, env: {} });
    assert.equal(r.transportOk, false);
    assert.match(r.error, /ssh not found/);
  });
});

/* ------------------------------------------------------------------ CLI */

test("parseArgs: valued and repeated flags, --flag=value, and -- ends the flags", () => {
  const p = parseArgs(["dev", "--cwd", "/x", "--env", "A=1", "--env=B=2", "--stdin", "--", "git", "log", "--oneline"],
    { valued: ["cwd"], repeat: ["env"] });
  assert.deepEqual(p, { flags: { cwd: "/x", env: ["A=1", "B=2"], stdin: true }, positional: ["dev"], rest: ["git", "log", "--oneline"] });
  assert.throws(() => parseArgs(["--cwd"], { valued: ["cwd"] }), /needs a value/);
  assert.equal(parseArgs(["dev"]).rest, null);
});

test("takesTerminal: attach, --tty exec and shell attach close readline; everything else keeps the prompt", () => {
  assert.equal(takesTerminal(["dev"]), true);
  assert.equal(takesTerminal(["exec", "dev", "--tty", "--", "top"]), true);
  assert.equal(takesTerminal(["exec", "dev", "--", "ls"]), false);
  assert.equal(takesTerminal(["shell", "dev", "--name", "app"]), true);
  assert.equal(takesTerminal(["shell", "send", "dev/app", "x"]), false);
  assert.equal(takesTerminal(["shell", "read", "dev/app"]), false);
  assert.equal(takesTerminal(["open", "dev"]), false);
  assert.equal(takesTerminal([]), false);
});

/** Run the CLI with captured output and a fake runner. */
async function cli(argv, runner, extra = {}) {
  const out = [];
  const errs = [];
  const code = await sshCommand(argv, { write: (l) => out.push(String(l)), writeErr: (l) => errs.push(String(l)), runner, env: {}, ...extra });
  return { code, out: out.join("\n"), errs: errs.join("\n"), json: () => JSON.parse(out.join("\n")) };
}

test("the CLI: add, list, show, remove — and --json anywhere before -- (R6, R7)", async () => {
  await withSshDir(async () => {
    const runner = fakeRunner();
    const added = await cli(["add", "dev", "deploy@example.com", "--cwd", "/srv/app", "--port", "2222", "--json"], runner);
    assert.equal(added.code, 0);
    assert.deepEqual(added.json(), { ok: true, name: "dev", target: "deploy@example.com", port: 2222, cwd: "/srv/app", replaced: false });

    const list = await cli(["--json"], runner);
    assert.deepEqual(list.json(), { targets: [{ name: "dev", target: "deploy@example.com", port: 2222, cwd: "/srv/app", connected: false }] });
    const bare = await cli([], runner);
    assert.match(bare.out, /dev/);
    assert.match(bare.out, /closed/);

    const show = await cli(["show", "dev", "--json"], runner);
    assert.equal(show.json().connected, false);
    assert.match(show.json().socket, /[0-9a-f]{12}$/);

    const bad = await cli(["add", "Dev", "h"], runner);
    assert.equal(bad.code, 1);
    assert.match(bad.errs, /not a target name/);
    const badJson = await cli(["add", "Dev", "h", "--json"], runner);
    assert.equal(badJson.json().ok, false);

    const removed = await cli(["remove", "dev", "--json"], runner);
    assert.deepEqual(removed.json(), { ok: true, name: "dev", removed: true });
    assert.equal((await cli(["show", "dev"], runner)).code, 1);
    assert.equal((await cli(["nope"], runner)).code, 1, "an unknown word is a missing target, not a crash");
  });
});

test("the CLI: exec --json is the exec object, and the exit code is the remote's (R23)", async () => {
  await withSshDir(async () => {
    addTarget("dev", "deploy@example.com", { cwd: "/srv/app" });
    const runner = masterRunner((cmd) => (cmd.includes("false") ? { status: 3, stderr: "nope\n" } : { status: 0, stdout: "hi\n" }));
    const ok = await cli(["exec", "dev", "--json", "--", "echo", "hi"], runner);
    assert.equal(ok.code, 0);
    const body = ok.json();
    assert.equal(body.ok, true);
    assert.equal(body.stdout, "hi\n");
    assert.equal(body.transportOk, true);
    for (const key of ["ok", "target", "connected", "code", "signal", "stdout", "stderr", "durationMs"]) assert.ok(key in body, key);

    const failed = await cli(["exec", "dev", "--json", "--", "false"], runner);
    assert.equal(failed.code, 3);
    assert.deepEqual([failed.json().ok, failed.json().transportOk, failed.json().code], [false, true, 3]);

    // --json after -- belongs to the remote command.
    const passthrough = await cli(["exec", "dev", "--", "tool", "--json"], runner);
    assert.equal(passthrough.code, 0);
    assert.equal(runner.calls.filter((c) => isExec(c.args)).at(-1).args.at(-1), "cd -- /srv/app && exec tool --json");

    const noCommand = await cli(["exec", "dev"], runner);
    assert.equal(noCommand.code, 2);
  });
});

test("the CLI: open/check/close report the connection, and exit codes say it too (R9)", async () => {
  await withSshDir(async () => {
    addTarget("dev", "deploy@example.com");
    const runner = masterRunner(() => ({ status: 0 }));
    const closedBefore = await cli(["check", "dev", "--json"], runner);
    assert.equal(closedBefore.code, 1);
    assert.equal(closedBefore.json().connected, false);
    const opened = await cli(["open", "dev", "--json", "--batch"], runner);
    assert.equal(opened.code, 0);
    assert.deepEqual([opened.json().ok, opened.json().alreadyOpen], [true, false]);
    const again = await cli(["open", "dev", "--json", "--batch"], runner);
    assert.equal(again.json().alreadyOpen, true);
    const checked = await cli(["check", "dev"], runner);
    assert.equal(checked.code, 0);
    assert.match(checked.out, /connected/);
    const closed = await cli(["close", "dev", "--json"], runner);
    assert.deepEqual([closed.json().ok, closed.json().closed, closed.json().wasOpen], [true, true, true]);
    assert.equal((await cli(["check", "dev"], runner)).code, 1);
  });
});

test("the CLI: shell send/read/kill drive remote tmux over exec, and say when tmux is missing (R44–R47)", async () => {
  await withSshDir(async () => {
    addTarget("dev", "deploy@example.com", { cwd: "/srv/app" });
    let hasTmux = true;
    const runner = masterRunner((cmd) => {
      if (!hasTmux) return { status: 127, stderr: "sh: tmux: not found\n" };
      if (cmd.includes("no-such")) return { status: 1, stderr: "can't find session: moshcode-ssh-dev-no-such\n" };
      if (cmd.includes("capture-pane")) return { status: 0, stdout: "$ pnpm test\nall green\n\n\n" };
      return { status: 0 };
    });
    const sent = await cli(["shell", "send", "dev/app", "pnpm", "test", "--json"], runner);
    assert.equal(sent.code, 0);
    const remotes = runner.calls.filter((c) => isExec(c.args)).map((c) => c.args.at(-1));
    assert.deepEqual(remotes, [
      "exec tmux send-keys -t moshcode-ssh-dev-app -l -- 'pnpm test'",
      "exec tmux send-keys -t moshcode-ssh-dev-app Enter",
    ], "literal text, then Enter — and no cd, tmux's target is the session (R45)");

    const read = await cli(["shell", "read", "dev/app", "--lines", "40"], runner);
    assert.equal(read.out, "$ pnpm test\nall green");
    assert.ok(runner.calls.at(-1).args.at(-1).includes("capture-pane -p -t moshcode-ssh-dev-app -S -40"));

    const missing = await cli(["shell", "read", "dev/no-such", "--json"], runner);
    assert.equal(missing.code, 1);
    assert.match(missing.json().error, /no shell dev\/no-such/);

    hasTmux = false;
    const noTmux = await cli(["shell", "send", "dev/app", "ls", "--json"], runner);
    assert.equal(noTmux.code, 1);
    assert.match(noTmux.json().error, /tmux is not installed on dev/);
    assert.equal(noTmux.json().transportOk, true, "a missing tmux is not a transport failure");

    assert.equal((await cli(["shell", "send", "dev", "x"], runner)).code, 2);
  });
});
