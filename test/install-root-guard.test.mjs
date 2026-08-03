// install.sh derives every path from $HOME. Under sudo that is /root, mode
// 0700, so a sudo-install puts the payload and both wrappers somewhere the
// user who typed the command cannot read. Nothing fails at install time — it
// surfaces much later as `permission denied` on a binary that looks installed,
// which is a genuinely confusing place to land.
//
// These tests drive the real install.sh rather than a copy of its logic. `id`
// is shadowed on PATH so the script can be run through its root branch without
// root, and the guard is asserted to fire before any download happens: curl and
// tar are shadowed too, and a call to either fails the test.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// import.meta.dirname needs Node 20.11+; this installer supports Node 18.
const INSTALL_SH = fileURLToPath(new URL("../install.sh", import.meta.url));

const scratch = [];

/** A PATH dir where `id -u` reports `uid`, and curl/tar are landmines. */
function fakeBin(uid) {
  const dir = mkdtempSync(join(tmpdir(), "moshcode-guard-"));
  scratch.push(dir);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "id"), `#!/bin/sh\n[ "$1" = "-u" ] && echo ${uid} && exit 0\nexec /usr/bin/id "$@"\n`);
  for (const tool of ["curl", "tar"]) {
    writeFileSync(join(bin, tool), `#!/bin/sh\necho "REACHED_${tool.toUpperCase()}" >&2\nexit 99\n`);
  }
  for (const f of ["id", "curl", "tar"]) chmodSync(join(bin, f), 0o755);
  return { dir, bin };
}

function runInstall(uid, env = {}) {
  const { bin } = fakeBin(uid);
  try {
    const out = execFileSync("sh", [INSTALL_SH, "install"], {
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        HOME: "/root",
        NO_COLOR: "1",
        ...env,
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, output: out };
  } catch (error) {
    return {
      code: error.status,
      output: `${error.stdout ?? ""}${error.stderr ?? ""}`,
    };
  }
}

test("sudo installs are refused before anything is downloaded", () => {
  const { code, output } = runInstall(0, { SUDO_USER: "anthony" });

  assert.notEqual(code, 0, "a sudo install must not report success");
  assert.match(output, /don't install moshcode with sudo/);
  // The whole point is that it stops early: reaching the network would mean it
  // had already committed to a root-owned install.
  assert.doesNotMatch(output, /REACHED_CURL|REACHED_TAR/);
});

test("the refusal says what to run instead, for both intents", () => {
  const { output } = runInstall(0, { SUDO_USER: "anthony" });

  // The ordinary fix, and the escape hatch for a deliberate system-wide install.
  assert.match(output, /curl -fsSL https:\/\/moshcoding\.com\/install\.sh \| sh/);
  assert.match(output, /MOSHCODE_ALLOW_ROOT=1/);
  assert.match(output, /anthony/, "it should name the user who would be locked out");
});

test("a bare root shell still installs — only sudo-from-a-user is the trap", () => {
  // Containers and CI images run as root with no SUDO_USER; refusing there
  // would break a legitimate install for no reason. It should get past the
  // guard and fail later, on the shadowed curl.
  const { output } = runInstall(0);

  assert.doesNotMatch(output, /don't install moshcode with sudo/);
  assert.match(output, /REACHED_CURL/);
});

test("MOSHCODE_ALLOW_ROOT overrides the refusal", () => {
  const { output } = runInstall(0, { SUDO_USER: "anthony", MOSHCODE_ALLOW_ROOT: "1" });

  assert.doesNotMatch(output, /don't install moshcode with sudo/);
  assert.match(output, /installing as root/);
  assert.match(output, /REACHED_CURL/);
});

test("a normal user is unaffected", () => {
  const { output } = runInstall(1000, { SUDO_USER: "anthony" });

  // Even with SUDO_USER set (a plain shell inherits it after any sudo call),
  // a non-root uid must never trip the guard.
  assert.doesNotMatch(output, /don't install moshcode with sudo/);
  assert.match(output, /REACHED_CURL/);
});

test("help output stops at the header and does not leak shell code", () => {
  const out = execFileSync("sh", [INSTALL_SH, "help"], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });

  assert.match(out, /Do not install this with sudo/);
  assert.doesNotMatch(out, /set -eu/, "the help range should end at the header comments");
});

test("the sudo note is documented in the header, not only in the error", () => {
  const source = readFileSync(INSTALL_SH, "utf8");
  const header = source.slice(0, source.indexOf("set -eu"));

  assert.match(header, /MOSHCODE_ALLOW_ROOT/);
  assert.match(header, /sudo/);
});

test.after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});
