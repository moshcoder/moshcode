import assert from "node:assert/strict";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";

import { TOOLS, resolveTool, retry, toolList } from "../src/tools.mjs";

const BIN = fileURLToPath(new URL("../bin/moshcode.mjs", import.meta.url));

function tempDir(prefix = "moshcode-tools-") {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function writeExecutable(dir, name, source) {
  const file = path.join(dir, name);
  writeFileSync(file, `#!/usr/bin/env node\n${source}`);
  chmodSync(file, 0o755);
  return file;
}

function run(args, { binDir, cwd, input = "", env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const ioDir = tempDir("moshcode-stdio-");
    const stdinFile = path.join(ioDir, "stdin");
    const stdoutFile = path.join(ioDir, "stdout");
    const stderrFile = path.join(ioDir, "stderr");
    writeFileSync(stdinFile, input);
    const stdin = openSync(stdinFile, "r");
    const stdout = openSync(stdoutFile, "w");
    const stderr = openSync(stderrFile, "w");
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd,
      stdio: [stdin, stdout, stderr],
      env: {
        ...process.env,
        ...env,
        PATH: binDir
          ? `${binDir}${path.delimiter}${env.PATH ?? process.env.PATH ?? ""}`
          : env.PATH ?? process.env.PATH,
      },
    });
    let failed = false;
    child.on("error", (error) => { failed = true; reject(error); });
    child.on("close", (status, signal) => {
      for (const fd of [stdin, stdout, stderr]) closeSync(fd);
      if (!failed) resolve({
        status,
        signal,
        stdout: readFileSync(stdoutFile, "utf8"),
        stderr: readFileSync(stderrFile, "utf8"),
      });
    });
  });
}

test("tool registry uses the official native CLI packages", () => {
  assert.deepEqual(resolveTool("UGIG"), ["ugig", TOOLS.ugig]);
  assert.deepEqual(resolveTool("coinpay"), ["coinpay", TOOLS.coinpay]);
  assert.deepEqual(resolveTool("c0mpute"), ["c0mpute", TOOLS.c0mpute]);
  assert.equal(resolveTool("claude"), null);
  assert.deepEqual(TOOLS.ugig.install, {
    cmd: "bash",
    args: ["-c", "curl -fsSL https://ugig.net/install.sh | bash"],
  });
  assert.deepEqual(TOOLS.coinpay.install, {
    cmd: "sh",
    args: ["-c", "curl -fsSL https://coinpayportal.com/install.sh | sh"],
  });
  assert.deepEqual(TOOLS.c0mpute.install, {
    cmd: "sh",
    args: ["-c", "curl -fsSL https://c0mpute.com/install.sh | sh"],
  });
  assert.deepEqual(resolveTool("secrets"), ["secrets", TOOLS.secrets]);
  // /secrets wraps the `logicsrc` binary and ships via its own install script.
  assert.equal(TOOLS.secrets.bin, process.env.LOGICSRC_BIN || "logicsrc");
  assert.deepEqual(TOOLS.secrets.install, {
    cmd: "sh",
    args: ["-c", "curl -fsSL https://logicsrc.com/install.sh | sh"],
  });
  assert.match(toolList(), /ugig/);
  assert.match(toolList(), /coinpay/);
  assert.match(toolList(), /c0mpute/);
  assert.match(toolList(), /secrets/);
});

test("cloud CLIs resolve and are listed as workflow tools", () => {
  for (const key of ["railway", "gh", "supabase", "doppler", "doctl", "tailscale"]) {
    assert.deepEqual(resolveTool(key), [key, TOOLS[key]]);
    assert.equal(TOOLS[key].bin, key);
    assert.match(toolList(), new RegExp(key));
  }
  // Case-insensitive, like the other tools.
  assert.deepEqual(resolveTool("GH"), ["gh", TOOLS.gh]);
});

test("railway installs from the official npm package", () => {
  // Railway's shell installer needs bash process substitution, which does not
  // survive `sh -c`, so the npm package is the portable path.
  assert.deepEqual(TOOLS.railway.install, {
    cmd: "npm",
    args: ["install", "-g", "@railway/cli"],
  });
});

test("doppler installs user-local and updates natively", () => {
  // --install-path keeps the binary out of /usr/local/bin, so no sudo prompt.
  const [flag, script] = TOOLS.doppler.install.args;
  assert.equal(TOOLS.doppler.install.cmd, "sh");
  assert.equal(flag, "-c");
  assert.match(script, /cli\.doppler\.com\/install\.sh/);
  assert.match(script, /--install-path "\$HOME\/\.local\/bin"/);
  assert.doesNotMatch(script, /sudo/);
  assert.deepEqual(TOOLS.doppler.upgrade, { cmd: "doppler", args: ["update"] });
});

test("tailscale uses the official installer and native updater", () => {
  // tailscale is a system daemon, so unlike gh/supabase/doctl it goes through
  // the vendor script + package manager rather than a user-local binary drop.
  assert.deepEqual(TOOLS.tailscale.install, {
    cmd: "sh",
    args: ["-c", "curl -fsSL https://tailscale.com/install.sh | sh"],
  });
  assert.deepEqual(TOOLS.tailscale.upgrade, { cmd: "tailscale", args: ["update"] });
});

test("release-only CLIs install via the bundled downloader", () => {
  // gh, supabase, and doctl publish no cross-platform install script, so their
  // spec runs src/release-install.mjs on this node, not a vendor URL.
  for (const key of ["gh", "supabase", "doctl"]) {
    const { cmd, args } = TOOLS[key].install;
    assert.equal(cmd, process.execPath);
    assert.match(args[0], /release-install\.mjs$/);
    assert.ok(existsSync(args[0]), `${args[0]} should exist — it is spawned by \`moshcode install ${key}\``);
    assert.equal(args[1], key);
  }
});

test("every tool exposes an install spec and a passthrough binary", () => {
  for (const [key, tool] of Object.entries(TOOLS)) {
    assert.ok(tool.bin, `${key} needs a bin to pass through to`);
    assert.ok(tool.desc, `${key} needs a description for \`moshcode tools\``);
    assert.equal(typeof tool.install?.cmd, "string", `${key} needs an install spec`);
    assert.ok(Array.isArray(tool.install?.args), `${key} install spec needs args`);
  }
});

for (const name of ["ugig", "coinpay"]) {
  test(`moshcode ${name} transparently passes process state and exit code`, async () => {
    const root = tempDir();
    const nativeBin = path.join(root, "bin");
    const cwd = path.join(root, "work tree");
    mkdirSync(nativeBin);
    mkdirSync(cwd);
    writeExecutable(nativeBin, name, `
import fs from "node:fs";
const input = fs.readFileSync(0, "utf8");
process.stdout.write(JSON.stringify({
  argv: process.argv.slice(2),
  input,
  cwd: process.cwd(),
  marker: process.env.MOSHCODE_TOOL_TEST,
}));
process.stderr.write("native stderr");
process.exit(23);
`);

    const result = await run([name, "--json", "two words", "--flag=value"], {
      binDir: nativeBin,
      cwd,
      input: "native stdin",
      env: { MOSHCODE_TOOL_TEST: "preserved" },
    });

    assert.equal(result.status, 23);
    assert.equal(result.signal, null);
    assert.deepEqual(JSON.parse(result.stdout), {
      argv: ["--json", "two words", "--flag=value"],
      input: "native stdin",
      // The child reports process.cwd() — the resolved physical path, while
      // `cwd` may pass through a symlink (macOS: /var → /private/var), so
      // compare against the real path, not the symlinked spelling.
      cwd: realpathSync(cwd),
      marker: "preserved",
    });
    assert.equal(result.stderr, "native stderr");
  });
}

test("missing native tool produces an actionable error", async () => {
  const emptyPath = tempDir("moshcode-empty-path-");
  const result = await run(["ugig", "gigs", "list"], {
    env: { PATH: emptyPath },
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /ugig isn't installed/);
  assert.match(result.stderr, /moshcode install ugig/);
});

test("tools status reports native executables found on PATH", async () => {
  const nativeBin = tempDir("moshcode-status-");
  writeExecutable(nativeBin, "ugig", "");
  writeExecutable(nativeBin, "coinpay", "");

  const result = await run(["tools"], { binDir: nativeBin });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /● ugig/);
  assert.match(result.stdout, /● coinpay/);
});

// Neither tool is on npm — `install <tool>` runs the tool's official install
// script through a shell. The fake shell captures its argv instead of actually
// piping curl to a real shell.
for (const [name, shell, script] of [
  ["ugig", "bash", "curl -fsSL https://ugig.net/install.sh | bash"],
  ["coinpay", "sh", "curl -fsSL https://coinpayportal.com/install.sh | sh"],
  ["c0mpute", "sh", "curl -fsSL https://c0mpute.com/install.sh | sh"],
]) {
  test(`install ${name} delegates to its official install script`, async () => {
    const root = tempDir("moshcode-install-");
    const nativeBin = path.join(root, "bin");
    const capture = path.join(root, "shell-args.json");
    mkdirSync(nativeBin);
    writeExecutable(nativeBin, shell, `
import fs from "node:fs";
fs.writeFileSync(process.env.SHELL_CAPTURE, JSON.stringify(process.argv.slice(2)));
`);

    const result = await run(["install", name], {
      binDir: nativeBin,
      env: { SHELL_CAPTURE: capture },
    });

    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(readFileSync(capture, "utf8")), ["-c", script]);
  });
}

test("tool lookup ignores inherited Object.prototype members", () => {
  // TOOLS is a plain object literal: `TOOLS.constructor` is truthy but is not a
  // tool, so resolving it would hand a bin-less, install-less entry downstream.
  assert.equal(resolveTool("constructor"), null);
  assert.equal(resolveTool("__proto__"), null);
  assert.equal(resolveTool("valueOf"), null);
});

test("moshcode install reports an Object.prototype name as unknown", async () => {
  const result = await run(["install", "constructor"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /usage: moshcode install <engine\|tool>/);
  assert.doesNotMatch(result.stderr, /TypeError/);
});

test("retry rejects non-positive attempt limits", async () => {
  let calls = 0;

  await assert.rejects(
    retry(() => { calls++; }, 0, 1),
    /maxAttempts must be a positive integer/,
  );
  assert.equal(calls, 0);
});

test("retry retries until a later attempt succeeds", async () => {
  let calls = 0;
  const result = await retry(() => {
    calls++;
    if (calls < 2) throw new Error("not yet");
    return "ok";
  }, 2, 1);

  assert.equal(result, "ok");
  assert.equal(calls, 2);
});
