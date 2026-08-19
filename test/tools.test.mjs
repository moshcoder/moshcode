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
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";

import { isInstalled } from "../src/engines.mjs";
import { TOOLS, resolveTool, retry, toolList, toolUpgradeSpec } from "../src/tools.mjs";

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
        // After the spread, or the real one wins. A throwaway home, because a
        // successful install is allowed to write one: a tool that offers pit
        // aliases has them adopted into ~/.moshcode/aliases.json at the end of
        // it. Without this the suite edits the aliases of whoever runs it.
        HOME: tempDir("moshcode-home-"),
        USERPROFILE: undefined,
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
  assert.deepEqual(resolveTool("c0upons"), ["c0upons", TOOLS.c0upons]);
  assert.deepEqual(TOOLS.c0upons.install, {
    cmd: "sh",
    args: ["-c", "curl -fsSL https://c0upons.com/install.sh | sh"],
  });
  // The c0upons CLI replaces its own binary, so upgrades skip the installer.
  assert.deepEqual(TOOLS.c0upons.upgrade, { cmd: "c0upons", args: ["upgrade"] });
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
  assert.match(toolList(), /c0upons/);
  assert.match(toolList(), /secrets/);
});

test("cloud CLIs resolve and are listed as workflow tools", () => {
  for (const key of ["railway", "gh", "supabase", "doppler", "doctl", "turso", "tailscale"]) {
    assert.deepEqual(resolveTool(key), [key, TOOLS[key]]);
    assert.equal(TOOLS[key].bin, key);
    assert.match(toolList(), new RegExp(key));
  }
  // Case-insensitive, like the other tools.
  assert.deepEqual(resolveTool("GH"), ["gh", TOOLS.gh]);
});

test("Alpaca is a workflow tool installed from its official Go command", () => {
  assert.deepEqual(resolveTool("ALPACA"), ["alpaca", TOOLS.alpaca]);
  assert.deepEqual(TOOLS.alpaca.install, {
    cmd: "go",
    args: ["install", "github.com/alpacahq/cli/cmd/alpaca@latest"],
  });
  assert.deepEqual(TOOLS.alpaca.binDirs, [path.join(homedir(), "go", "bin")]);
  assert.match(toolList(), /alpaca/);
});

test("install alpaca delegates to the official Go package", async () => {
  const root = tempDir("moshcode-install-alpaca-");
  const nativeBin = path.join(root, "bin");
  const capture = path.join(root, "go-args.json");
  mkdirSync(nativeBin);
  writeExecutable(nativeBin, "go", `
import fs from "node:fs";
fs.writeFileSync(process.env.GO_CAPTURE, JSON.stringify(process.argv.slice(2)));
`);

  const result = await run(["install", "alpaca"], {
    binDir: nativeBin,
    env: { GO_CAPTURE: capture },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(capture, "utf8")), [
    "install", "github.com/alpacahq/cli/cmd/alpaca@latest",
  ]);
});

test("install alpaca explains a missing Go prerequisite", async () => {
  const emptyPath = tempDir("moshcode-install-alpaca-no-go-");
  const result = await run(["install", "alpaca"], { env: { PATH: emptyPath } });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /install failed/);
  assert.match(result.stderr, /Go is required to install Alpaca/);
  assert.match(result.stderr, /moshcode install alpaca/);
});

test("railway installs from the official npm package", () => {
  // Railway's shell installer needs bash process substitution, which does not
  // survive `sh -c`, so the npm package is the portable path.
  assert.deepEqual(TOOLS.railway.install, {
    cmd: "npm",
    args: ["install", "-g", "@railway/cli"],
  });
});

test("MCPJam is a workflow tool installed from its official npm package", () => {
  assert.deepEqual(resolveTool("MCPJAM"), ["mcpjam", TOOLS.mcpjam]);
  assert.equal(TOOLS.mcpjam.bin, "mcpjam");
  assert.deepEqual(TOOLS.mcpjam.install, {
    cmd: "npm",
    args: ["install", "-g", "@mcpjam/cli"],
  });
  // No self-updater: `npm install -g` is idempotent, so re-running the install
  // IS the upgrade. Asserted so adding one later is a deliberate change.
  assert.equal(TOOLS.mcpjam.upgrade, undefined);
  assert.deepEqual(toolUpgradeSpec(TOOLS.mcpjam), TOOLS.mcpjam.install);
  assert.match(toolList(), /mcpjam/);
});

test("BufferOverride is a workflow tool installed from its official npm package", () => {
  // Keyed `bo` rather than `bufferoverride`: the binary, the pit command and
  // the product's own documentation all say `bo`.
  assert.deepEqual(resolveTool("BO"), ["bo", TOOLS.bo]);
  assert.equal(TOOLS.bo.bin, "bo");
  assert.deepEqual(TOOLS.bo.install, {
    cmd: "npm",
    args: ["install", "-g", "@profullstack/bufferoverride"],
  });
  // Same reasoning as mcpjam: `npm install -g` is idempotent, so re-running the
  // install IS the upgrade. Asserted so adding one later is deliberate.
  assert.equal(TOOLS.bo.upgrade, undefined);
  assert.deepEqual(toolUpgradeSpec(TOOLS.bo), TOOLS.bo.install);
  assert.match(toolList(), /bo /);
  assert.match(toolList(), /BufferOverride/);
});

test("install bo delegates to the official npm package", async () => {
  const root = tempDir("moshcode-install-bo-");
  const nativeBin = path.join(root, "bin");
  const capture = path.join(root, "npm-args.json");
  mkdirSync(nativeBin);
  writeExecutable(nativeBin, "npm", `
import fs from "node:fs";
fs.writeFileSync(process.env.NPM_CAPTURE, JSON.stringify(process.argv.slice(2)));
`);

  const result = await run(["install", "bo"], {
    binDir: nativeBin,
    env: { NPM_CAPTURE: capture },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(capture, "utf8")), [
    "install", "-g", "@profullstack/bufferoverride",
  ]);
});

test("install mcpjam delegates to the official npm package", async () => {
  const root = tempDir("moshcode-install-mcpjam-");
  const nativeBin = path.join(root, "bin");
  const capture = path.join(root, "npm-args.json");
  mkdirSync(nativeBin);
  writeExecutable(nativeBin, "npm", `
import fs from "node:fs";
fs.writeFileSync(process.env.NPM_CAPTURE, JSON.stringify(process.argv.slice(2)));
`);

  const result = await run(["install", "mcpjam"], {
    binDir: nativeBin,
    env: { NPM_CAPTURE: capture },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(capture, "utf8")), [
    "install", "-g", "@mcpjam/cli",
  ]);
});

test("Alchemy is a workflow tool installed from its official npm package", () => {
  assert.deepEqual(resolveTool("ALCHEMY"), ["alchemy", TOOLS.alchemy]);
  // The package's bin is named `alchemy`, so the pit word and the binary it
  // launches are the same — no product/binary split like secrets → logicsrc.
  assert.equal(TOOLS.alchemy.bin, "alchemy");
  assert.deepEqual(TOOLS.alchemy.install, {
    cmd: "npm",
    args: ["install", "-g", "@alchemy/cli"],
  });
  // `npm install -g` is idempotent, so the install IS the upgrade. Asserted so
  // adding a self-updater later is a deliberate change.
  assert.equal(TOOLS.alchemy.upgrade, undefined);
  assert.deepEqual(toolUpgradeSpec(TOOLS.alchemy), TOOLS.alchemy.install);
  // Global npm installs land on PATH, so there is nothing for binDirs to cover.
  assert.equal(TOOLS.alchemy.binDirs, undefined);
  assert.match(toolList(), /alchemy/);
});

test("install alchemy delegates to the official npm package", async () => {
  const root = tempDir("moshcode-install-alchemy-");
  const nativeBin = path.join(root, "bin");
  const capture = path.join(root, "npm-args.json");
  mkdirSync(nativeBin);
  writeExecutable(nativeBin, "npm", `
import fs from "node:fs";
fs.writeFileSync(process.env.NPM_CAPTURE, JSON.stringify(process.argv.slice(2)));
`);

  const result = await run(["install", "alchemy"], {
    binDir: nativeBin,
    env: { NPM_CAPTURE: capture },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(capture, "utf8")), [
    "install", "-g", "@alchemy/cli",
  ]);
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

test("turso installs from its official script", () => {
  // https://github.com/tursodatabase/turso-cli — unpacks to $HOME/.turso and
  // appends it to the shell profile, so it lands on PATH for the next shell.
  assert.deepEqual(TOOLS.turso.install, {
    cmd: "bash",
    args: ["-c", "curl -sSfL https://get.tur.so/install.sh | bash"],
  });
  // Re-running the installer fetches the latest, so no separate upgrade spec.
  assert.equal(TOOLS.turso.upgrade, undefined);
  // That profile append only takes effect in the NEXT shell, so PATH alone shows
  // turso missing in the session that installed it — binDirs is what makes
  // `/tools` and `/turso` see the binary the installer just dropped.
  assert.deepEqual(TOOLS.turso.binDirs, [path.join(homedir(), ".turso")]);
});

test("tool status finds a binary in the tool's own install dir", () => {
  // Same shape as turso's ~/.turso: a dir the installer owns that PATH misses.
  const dir = tempDir("moshcode-tool-bindirs-");
  const bin = path.join(dir, "moshcode-fake-tool");
  writeFileSync(bin, "#!/bin/sh\nexit 0\n");
  chmodSync(bin, 0o755);
  assert.equal(isInstalled("moshcode-fake-tool"), false);
  assert.equal(isInstalled("moshcode-fake-tool", [dir]), true);
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

test("Coral installs from its official script and re-runs it to upgrade", () => {
  assert.deepEqual(resolveTool("CORAL"), ["coral", TOOLS.coral]);
  assert.equal(TOOLS.coral.bin, "coral");
  assert.deepEqual(TOOLS.coral.install, {
    cmd: "bash",
    args: ["-c", "curl -fsSL https://withcoral.com/install.sh | bash"],
  });
  // Coral ships no self-updater, so re-running the installer IS the upgrade —
  // asserted here so adding one later is a deliberate change, not a silent one.
  assert.equal(TOOLS.coral.upgrade, undefined);
  assert.deepEqual(toolUpgradeSpec(TOOLS.coral), TOOLS.coral.install);
  assert.match(toolList(), /coral/);
});

test("cli-tools probes its dispatcher and updates through it", () => {
  assert.deepEqual(resolveTool("CLI-TOOLS"), ["cli-tools", TOOLS["cli-tools"]]);

  // This tool is a set of commands, not one binary. Probing the dispatcher is
  // what makes "installed" mean the whole set rather than one of eight names
  // happening to exist — several of which (gh-prs, tcfeed) a contributor may
  // already have from an older checkout.
  assert.equal(TOOLS["cli-tools"].bin, "cli-tools");

  // The installer symlinks into ~/.local/bin and appends nothing to PATH, so
  // without binDirs the shell that ran the install reports it missing.
  assert.ok(TOOLS["cli-tools"].binDirs.some((dir) => dir.endsWith(path.join(".local", "bin"))));

  // Its own updater, not the installer: re-running that would re-clone for
  // someone whose checkout lives elsewhere.
  assert.deepEqual(toolUpgradeSpec(TOOLS["cli-tools"]), { cmd: "cli-tools", args: ["update"] });
  assert.match(toolList(), /cli-tools/);
});

test("Spinifex installs the spx host platform and re-runs the script to upgrade", () => {
  assert.deepEqual(resolveTool("SPINIFEX"), ["spinifex", TOOLS.spinifex]);
  // The product is Spinifex; the binary is spx. Getting this backwards makes
  // `moshcode tools` report an installed platform as missing.
  assert.equal(TOOLS.spinifex.bin, "spx");
  assert.deepEqual(TOOLS.spinifex.install, {
    cmd: "bash",
    args: ["-c", "curl -fsSL https://install.mulgadc.com | INSTALL_SPINIFEX_SKIP_NEWGRP=1 bash"],
  });
  // The installer ends with `exec newgrp` on a TTY, which would replace the
  // install with an interactive subshell and never return to the pit.
  assert.match(TOOLS.spinifex.install.args[1], /INSTALL_SPINIFEX_SKIP_NEWGRP=1/);
  // The vendor script is bash, not POSIX sh.
  assert.equal(TOOLS.spinifex.install.cmd, "bash");
  // Re-running the installer IS the documented update path, so no upgrade key.
  assert.equal(TOOLS.spinifex.upgrade, undefined);
  assert.deepEqual(toolUpgradeSpec(TOOLS.spinifex), TOOLS.spinifex.install);
  assert.match(toolList(), /spinifex/);
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
  ["c0upons", "sh", "curl -fsSL https://c0upons.com/install.sh | sh"],
  ["coral", "bash", "curl -fsSL https://withcoral.com/install.sh | bash"],
  ["spinifex", "bash", "curl -fsSL https://install.mulgadc.com | INSTALL_SPINIFEX_SKIP_NEWGRP=1 bash"],
  [
    "cli-tools",
    "sh",
    "curl -fsSL https://raw.githubusercontent.com/profullstack/cli-tools/master/install.sh | sh",
  ],
]) {
  test(`install ${name} delegates to its official install script`, async () => {
    const root = tempDir("moshcode-install-");
    const nativeBin = path.join(root, "bin");
    const capture = path.join(root, "shell-args.json");
    mkdirSync(nativeBin);
    // First invocation only. The spy stands in for the shell itself, so
    // anything else the run reaches for a shell would overwrite it — a tool
    // that offers pit aliases is asked for them once the install succeeds, and
    // its own shebang lands right back here. The install is what this asserts,
    // and the install is what runs first.
    writeExecutable(nativeBin, shell, `
import fs from "node:fs";
if (!fs.existsSync(process.env.SHELL_CAPTURE)) {
  fs.writeFileSync(process.env.SHELL_CAPTURE, JSON.stringify(process.argv.slice(2)));
}
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
