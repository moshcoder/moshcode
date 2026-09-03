// SSH workspaces against a real sshd (PRD 0013, test plan "Integration").
//
// An ephemeral, non-root sshd on a loopback port with keys generated for this
// run, and a private ssh_config the module is pointed at through
// MOSHCODE_SSH_CONFIG — so the target is an ssh_config alias (R5), the host
// key goes into a throwaway known_hosts, and nothing here touches ~/.ssh.
//
// Skipped, not failed, where sshd or ssh-keygen is missing or the daemon
// cannot bind: the module is still covered by test/ssh.test.mjs, and a CI
// image without an ssh server is not a bug in moshcode.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import {
  addTarget, bench, checkMaster, closeMaster, controlPath, exec, get, getTarget, openMaster, put, remoteHasTmux,
  shellKill, shellList, shellRead, shellSend, sshCommand,
} from "../src/ssh.mjs";

const SSHD = ["/usr/sbin/sshd", "/usr/local/sbin/sshd", "/opt/homebrew/sbin/sshd"].find((p) => fs.existsSync(p));
const have = (bin) => spawnSync("sh", ["-c", `command -v ${bin}`], { stdio: "ignore" }).status === 0;
const CAN_RUN = Boolean(SSHD) && have("ssh-keygen") && have("ssh") && process.platform !== "win32" && !process.env.MOSHCODE_SKIP_SSHD_TESTS;

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.on("error", reject);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

const waitFor = async (fn, { tries = 50, everyMs = 100 } = {}) => {
  for (let i = 0; i < tries; i++) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return false;
};

/** Everything an sshd needs, in one temp dir, torn down together. */
async function startSshd() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moshcode-sshd-"));
  fs.chmodSync(dir, 0o700);
  const gen = (name) => spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", path.join(dir, name)], { stdio: "ignore" });
  gen("hostkey");
  gen("clientkey");
  gen("otherkey"); // authorised nowhere — the auth-failure case
  fs.copyFileSync(path.join(dir, "clientkey.pub"), path.join(dir, "authorized_keys"));
  fs.chmodSync(path.join(dir, "authorized_keys"), 0o600);
  const port = await freePort();
  // OpenSSH 9.8+ penalises a source address after repeated auth failures and
  // resets its later connections — exactly what the auth-failure tests below
  // provoke, from 127.0.0.1, against the tests after them. Older daemons
  // refuse to start on an option they do not know, so it is version-gated.
  const version = /OpenSSH_(\d+)\.(\d+)/.exec(String(spawnSync("ssh", ["-V"], { encoding: "utf8" }).stderr || ""));
  const penalties = version && (Number(version[1]) > 9 || (Number(version[1]) === 9 && Number(version[2]) >= 8));
  fs.writeFileSync(path.join(dir, "sshd_config"), [
    ...(penalties ? ["PerSourcePenalties no"] : []),
    `Port ${port}`,
    "ListenAddress 127.0.0.1",
    `HostKey ${path.join(dir, "hostkey")}`,
    `AuthorizedKeysFile ${path.join(dir, "authorized_keys")}`,
    "PidFile none",
    "StrictModes no",
    "UsePAM no",
    "PasswordAuthentication no",
    "KbdInteractiveAuthentication no",
    "PubkeyAuthentication yes",
    "LogLevel ERROR",
    "Subsystem sftp internal-sftp",
    "",
  ].join("\n"));
  const daemon = spawn(SSHD, ["-f", path.join(dir, "sshd_config"), "-D", "-e"], { stdio: ["ignore", "ignore", "pipe"] });
  let log = "";
  daemon.stderr.on("data", (d) => { log += d; });
  const up = await waitFor(() => new Promise((resolve) => {
    if (daemon.exitCode !== null) return resolve(false);
    const s = net.connect(port, "127.0.0.1");
    s.on("connect", () => { s.destroy(); resolve(true); });
    s.on("error", () => resolve(false));
  }));
  const user = os.userInfo().username;
  const config = path.join(dir, "ssh_config");
  const host = (name, key) => [
    `Host ${name}`,
    "  HostName 127.0.0.1",
    `  Port ${port}`,
    `  User ${user}`,
    `  IdentityFile ${path.join(dir, key)}`,
    "  IdentitiesOnly yes",
    `  UserKnownHostsFile ${path.join(dir, "known_hosts")}`,
    "  StrictHostKeyChecking accept-new",
    "  LogLevel ERROR",
  ].join("\n");
  fs.writeFileSync(config, `${host("itest", "clientkey")}\n${host("itest-badkey", "otherkey")}\n`);
  return {
    dir, port, config, daemon, log: () => log, up,
    stop() {
      try { daemon.kill("SIGTERM"); } catch { /* already gone */ }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

// One daemon for the file: sshd startup is the slow part, and every test
// below wants the same one. The env points the module at a registry and a
// socket dir inside the daemon's temp dir, so nothing of the user's is read.
let sshd;
let env;
const saved = {};
const ENV_KEYS = ["MOSHCODE_SSH_DIR", "MOSHCODE_SSH_CONTROL_DIR", "MOSHCODE_SSH_CONFIG", "MOSHCODE_SSH_PERSIST"];

test.before(async () => {
  if (!CAN_RUN) return;
  sshd = await startSshd();
  if (!sshd.up) { sshd.stop(); sshd = null; return; }
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.MOSHCODE_SSH_DIR = path.join(sshd.dir, "moshcode-ssh");
  process.env.MOSHCODE_SSH_CONTROL_DIR = path.join(sshd.dir, "ctl");
  process.env.MOSHCODE_SSH_CONFIG = sshd.config;
  process.env.MOSHCODE_SSH_PERSIST = "60s";
  env = { ...process.env };
  addTarget("itest", "itest", { cwd: sshd.dir });
  addTarget("badkey", "itest-badkey");
  addTarget("nohost", "127.0.0.1", { port: sshd.port === 1 ? 2 : 1 });
});

test.after(async () => {
  if (!sshd) return;
  for (const name of ["itest", "badkey"]) {
    const entry = getTarget(name);
    if (entry) closeMaster(entry, { env });
  }
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  sshd.stop();
});

const skipUnless = (t) => {
  if (!CAN_RUN) { t.skip("no sshd/ssh-keygen here"); return false; }
  if (!sshd) { t.skip("sshd would not start in this environment"); return false; }
  return true;
};

const itest = () => getTarget("itest");

test("open, check, close: one master, spelled with -O (R8–R12)", (t) => {
  if (!skipUnless(t)) return;
  const entry = itest();
  const opened = openMaster(entry, { env, batch: true });
  assert.equal(opened.ok, true, opened.error);
  assert.equal(opened.alreadyOpen, false);
  assert.ok(opened.pid > 0, "the master reports its pid");
  assert.ok(fs.existsSync(controlPath(entry)), "the socket exists");
  assert.equal(fs.statSync(path.dirname(controlPath(entry))).mode & 0o777, 0o700);

  const again = openMaster(entry, { env, batch: true });
  assert.deepEqual([again.ok, again.alreadyOpen, again.pid], [true, true, opened.pid]);

  const status = checkMaster(entry, { env });
  assert.deepEqual([status.connected, status.pid], [true, opened.pid]);

  const closed = closeMaster(entry, { env });
  assert.deepEqual([closed.ok, closed.closed, closed.wasOpen], [true, true, true]);
  assert.ok(!fs.existsSync(controlPath(entry)), "-O exit took the socket with it");
  assert.equal(checkMaster(entry, { env }).connected, false);
});

test("exec: printf, a failing command, stdin, cwd — separate channels, no shared state (R18–R31)", (t) => {
  if (!skipUnless(t)) return;
  const entry = itest();
  const hello = exec(entry, ["printf", "%s\\n", "hello", "it's $HOME"], { env });
  assert.equal(hello.ok, true, hello.error || hello.stderr);
  assert.equal(hello.stdout, "hello\nit's $HOME\n", "quoting survives the remote shell");
  assert.equal(hello.stderr, "");
  assert.equal(hello.code, 0);
  assert.equal(hello.opened, true, "exec opened the master itself");

  const failing = exec(entry, ["sh", "-c", "echo to-stderr 1>&2; exit 3"], { env });
  assert.deepEqual([failing.ok, failing.transportOk, failing.code, failing.stdout, failing.stderr], [false, true, 3, "", "to-stderr\n"]);
  assert.equal(failing.opened, undefined, "reused");

  const bytes = Buffer.from([0, 1, 2, 255, 10, 13, 0x27, 0x24]);
  const cat = exec(entry, ["cat"], { env, stdin: bytes });
  assert.ok(cat.ok);
  assert.ok(Buffer.from(cat.stdout, "utf8").length >= 8, "stdin came back");
  const text = exec(entry, ["cat"], { env, stdin: "line one\nline two\n" });
  assert.equal(text.stdout, "line one\nline two\n");

  const here = exec(entry, ["pwd"], { env });
  assert.equal(here.stdout.trim(), fs.realpathSync(sshd.dir), "the target's cwd");
  const there = exec(entry, ["pwd"], { env, cwd: os.tmpdir() });
  assert.equal(there.stdout.trim(), fs.realpathSync(os.tmpdir()), "--cwd for this call");
  exec(entry, ["cd", "/"], { env });
  assert.equal(exec(entry, ["pwd"], { env }).stdout.trim(), fs.realpathSync(sshd.dir), "cd in one call does not leak into the next (R29)");

  const withEnv = exec(entry, ["sh", "-c", "echo $MOSHCODE_ITEST"], { env, remoteEnv: { MOSHCODE_ITEST: "set for one call" } });
  assert.equal(withEnv.stdout.trim(), "set for one call");
  assert.equal(exec(entry, ["sh", "-c", "echo x$MOSHCODE_ITEST"], { env }).stdout.trim(), "x", "…and only that call (R28)");

  const piped = exec(entry, ["printf 'a\\nb\\nc\\n' | wc -l"], { env, sh: true });
  assert.equal(piped.stdout.trim(), "3");
});

test("exec: a timeout kills the command and says so (R26)", (t) => {
  if (!skipUnless(t)) return;
  const r = exec(itest(), ["sleep", "30"], { env, timeoutMs: 500 });
  assert.deepEqual([r.ok, r.transportOk, r.timedOut], [false, true, true]);
  assert.ok(r.durationMs < 10_000);
});

test("parallel exec channels over one master (R56)", async (t) => {
  if (!skipUnless(t)) return;
  const entry = itest();
  assert.ok(openMaster(entry, { env, batch: true }).ok);
  const before = checkMaster(entry, { env }).pid;
  // spawnSync blocks, so parallelism here is real processes: the CLI, N at
  // once, all on the same socket — which is exactly how an agent will use it.
  const bin = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "bin", "moshcode.mjs");
  const runs = await Promise.all([1, 2, 3, 4, 5, 6].map((n) => new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, "ssh", "exec", "itest", "--json", "--", "sh", "-c", `sleep 0.2; echo run-${n}`], { env });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.on("close", (code) => resolve({ code, body: JSON.parse(out) }));
  })));
  for (const [i, r] of runs.entries()) {
    assert.equal(r.code, 0);
    assert.equal(r.body.stdout, `run-${i + 1}\n`);
    assert.equal(r.body.transportOk, true);
  }
  assert.equal(checkMaster(entry, { env }).pid, before, "still the one master");
});

test("a master that dies is detected, cleaned up, and reopened on the next command (R15)", (t) => {
  if (!skipUnless(t)) return;
  const entry = itest();
  assert.ok(openMaster(entry, { env, batch: true }).ok);
  const { pid } = checkMaster(entry, { env });
  process.kill(pid, "SIGKILL");
  assert.ok(fs.existsSync(controlPath(entry)), "the socket file is left behind by a killed master");
  const status = checkMaster(entry, { env });
  assert.deepEqual([status.connected, status.stale], [false, true]);
  assert.ok(!fs.existsSync(controlPath(entry)), "…and cleaned up, because it is ours");
  const r = exec(entry, ["echo", "back"], { env });
  assert.equal(r.stdout, "back\n");
  assert.equal(r.opened, true);
  assert.notEqual(checkMaster(entry, { env }).pid, pid, "a new master");
});

test("authentication failure is a transport failure, named (R25)", (t) => {
  if (!skipUnless(t)) return;
  const r = exec(getTarget("badkey"), ["true"], { env });
  assert.deepEqual([r.ok, r.transportOk, r.code], [false, false, 255]);
  assert.match(r.error, /authentication failed/);
  const opened = openMaster(getTarget("badkey"), { env, batch: true });
  assert.equal(opened.ok, false);
  assert.match(opened.error, /authentication failed/);
});

test("nothing listening is a transport failure too, and quickly", (t) => {
  if (!skipUnless(t)) return;
  const started = Date.now();
  const r = exec(getTarget("nohost"), ["true"], { env });
  assert.deepEqual([r.ok, r.transportOk], [false, false]);
  assert.match(r.error, /could not connect|ssh failed/);
  assert.ok(Date.now() - started < 25_000);
});

test("a changed host key is refused, never accepted on our behalf (R58, R59)", (t) => {
  if (!skipUnless(t)) return;
  const known = path.join(sshd.dir, "known_hosts");
  const original = fs.readFileSync(known, "utf8");
  const entry = itest();
  closeMaster(entry, { env });
  try {
    // A different key under the same [host]:port line: the "REMOTE HOST
    // IDENTIFICATION HAS CHANGED" case.
    const otherPub = fs.readFileSync(path.join(sshd.dir, "otherkey.pub"), "utf8").trim().split(" ").slice(0, 2).join(" ");
    fs.writeFileSync(known, original.split("\n").filter(Boolean).map((l) => `${l.split(" ")[0]} ${otherPub}`).join("\n") + "\n");
    const r = exec(entry, ["true"], { env });
    assert.deepEqual([r.ok, r.transportOk], [false, false]);
    assert.match(r.error, /host key verification failed/);
  } finally {
    fs.writeFileSync(known, original);
  }
});

test("put and get ride the same master; put lands atomically (R33, R34)", (t) => {
  if (!skipUnless(t)) return;
  if (!have("scp")) { t.skip("no scp"); return; }
  const entry = itest();
  const local = path.join(sshd.dir, "upload.txt");
  fs.writeFileSync(local, "one file, over the master\n");
  const up = put(entry, local, "landed.txt", { env });
  assert.equal(up.ok, true, up.error);
  assert.equal(up.remote, path.join(sshd.dir, "landed.txt"));
  assert.equal(fs.readFileSync(path.join(sshd.dir, "landed.txt"), "utf8"), "one file, over the master\n");
  assert.ok(!fs.readdirSync(sshd.dir).some((f) => f.includes(".moshcode-") && f.endsWith(".tmp")), "no temp file left on the remote side");
  const back = path.join(sshd.dir, "download.txt");
  const down = get(entry, "landed.txt", back, { env });
  assert.equal(down.ok, true, down.error);
  assert.equal(fs.readFileSync(back, "utf8"), "one file, over the master\n");
  const missing = get(entry, "/no/such/file", back, { env });
  assert.equal(missing.ok, false);
});

test("the CLI end to end: --json exec, exit codes, and stdin from a pipe", async (t) => {
  if (!skipUnless(t)) return;
  const bin = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "bin", "moshcode.mjs");
  const run = (args, input) => spawnSync(process.execPath, [bin, "ssh", ...args], { env, encoding: "utf8", input });
  const ok = run(["exec", "itest", "--json", "--", "echo", "hi"]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).stdout, "hi\n");
  const grep = run(["exec", "itest", "--json", "--", "grep", "zzz-not-here", "sshd_config"]);
  assert.equal(grep.status, 1, "grep's own exit code");
  assert.deepEqual([JSON.parse(grep.stdout).ok, JSON.parse(grep.stdout).transportOk], [false, true]);
  const piped = run(["exec", "itest", "--stdin", "--", "wc", "-c"], "12345");
  assert.equal(piped.stdout.trim(), "5");
  const listed = run(["--json"]);
  const targets = JSON.parse(listed.stdout).targets;
  assert.equal(targets.find((x) => x.name === "itest").connected, true);
  const checked = run(["check", "itest"]);
  assert.equal(checked.status, 0);
  const closed = run(["close", "itest", "--json"]);
  assert.equal(JSON.parse(closed.stdout).closed, true);
  assert.equal(run(["check", "itest"]).status, 1);
  const bad = run(["exec", "badkey", "--json", "--", "true"]);
  assert.equal(bad.status, 255);
  assert.equal(JSON.parse(bad.stdout).transportOk, false);
  const human = run(["exec", "badkey", "--", "true"]);
  assert.match(human.stderr, /authentication failed/);
});

test("bench measures, and the multiplexed side authenticates once", (t) => {
  if (!skipUnless(t)) return;
  const r = bench(itest(), { n: 3, env, batch: true });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.fresh.runs, 3);
  assert.equal(r.multiplexed.runs, 3);
  assert.equal(r.fresh.failures, 0);
  assert.equal(r.multiplexed.failures, 0);
  assert.equal(r.authentications.fresh, 3);
  assert.ok(r.authentications.multiplexed <= 1);
  assert.ok(r.multiplexed.medianMs > 0);
});

test("remote tmux shell: state persists across send, read sees it, kill ends it (R41–R47)", async (t) => {
  if (!skipUnless(t)) return;
  const entry = itest();
  const probe = remoteHasTmux(entry, { env });
  assert.equal(probe.ok, true, probe.error);
  if (!probe.has) { t.skip("no tmux on the (loopback) remote"); return; }
  // A private tmux server, so the test never touches the user's sessions:
  // TMUX_TMPDIR moves tmux's default socket, and the helpers carry it to the
  // remote side as a per-command environment value — the --env mechanism.
  const opts = { env, cwd: null, remoteEnv: { TMUX_TMPDIR: sshd.dir } };
  const session = "moshcode-ssh-itest-app";
  try {
    // shellAttach needs a terminal; create the session the way it would.
    const created = exec(entry, ["tmux", "new-session", "-d", "-s", session, "-c", sshd.dir], opts);
    assert.equal(created.ok, true, created.stderr);
    // Let the shell draw its prompt first: a line editor starting up can
    // discard typeahead, and the herd waits the same way before its first send.
    const prompted = await waitFor(() => { const r = shellRead(entry, "app", { lines: 5, ...opts }); return r.ok && r.screen.trim().length > 0; }, { tries: 200 });
    assert.ok(prompted, "the remote shell came up");

    const sent = shellSend(entry, "app", `cd ${JSON.stringify(os.tmpdir())}`, opts);
    assert.equal(sent.ok, true, sent.error);
    shellSend(entry, "app", "pwd", opts);
    let last = null;
    const seen = await waitFor(() => {
      last = shellRead(entry, "app", { lines: 40, ...opts });
      return last.ok && last.screen.includes(fs.realpathSync(os.tmpdir()));
    }, { tries: 200 });
    assert.ok(seen, `the cd persisted into the next line — that is what a shell session is for; screen was: ${JSON.stringify(last)}`);
    const list = shellList(entry, opts);
    assert.ok(list.ok, list.error);
    assert.ok(list.sessions.some((s) => s.session === "app"));
    const killed = shellKill(entry, "app", opts);
    assert.equal(killed.ok, true, killed.error);
    const after = shellRead(entry, "app", { lines: 5, ...opts });
    assert.equal(after.ok, false);
    assert.match(after.error, /no shell itest\/app/);
  } finally {
    exec(entry, ["tmux", "kill-server"], opts);
  }
});

test("the CLI shell verbs say when tmux is not there, and exec still works (R47)", (t) => {
  if (!skipUnless(t)) return;
  // A PATH with no tmux on it, for the remote command only.
  const entry = itest();
  const r = exec(entry, ["sh", "-c", "PATH=/nonexistent tmux -V"], { env });
  assert.equal(r.code, 127);
  const still = exec(entry, ["echo", "fine"], { env });
  assert.equal(still.stdout, "fine\n");
});
