// install.sh and runtime dependencies. moshcode was dependency-free ESM until
// 0.96.0 and the installer was built on that: it unpacks the source tarball and
// stops. From 0.96.0 package.json lists @profullstack/synconfig, the tarball
// carries no node_modules, and every install or upgrade through this script
// produced a CLI that died on its first import. These tests drive the real
// install.sh against a tarball built here, with curl and npm shadowed on PATH:
// curl serves the fixture, npm records how it was called.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const INSTALL_SH = fileURLToPath(new URL("../install.sh", import.meta.url));
const scratch = [];
const cleanup = () => { for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true }); };

/** A release tarball the way codeload serves one: moshcode-<ref>/ on top. */
function tarball(root, pkg) {
  const src = join(root, "moshcode-v9.9.9");
  mkdirSync(join(src, "bin"), { recursive: true });
  writeFileSync(join(src, "bin", "moshcode.mjs"), "console.log('fake moshcode');\n");
  writeFileSync(join(src, "package.json"), JSON.stringify(pkg, null, 2));
  const file = join(root, "moshcode.tgz");
  execFileSync("tar", ["-czf", file, "-C", root, "moshcode-v9.9.9"]);
  return file;
}

function shadow(bin, name, body) {
  writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
}

/**
 * Run `sh install.sh install` in a fresh HOME. `npmExit` is what the shadowed
 * npm returns; `pkg` is the package.json the fixture tarball carries.
 */
function runInstall({ pkg, npmExit = 0 }) {
  const root = mkdtempSync(join(tmpdir(), "moshcode-deps-"));
  scratch.push(root);
  const home = join(root, "home");
  const bin = join(root, "bin");
  mkdirSync(home); mkdirSync(bin);
  const tgz = tarball(root, pkg);
  const record = join(root, "npm-args.txt");
  shadow(bin, "curl", `case "$*" in
  *api.github.com*) printf '{"tag_name":"v9.9.9"}' ;;
  *codeload.github.com*) cat "${tgz}" ;;
  *) exit 22 ;;
esac`);
  shadow(bin, "npm", `printf '%s\\n%s\\n' "$PWD" "$*" > "${record}"; exit ${npmExit}`);
  // Node itself first, by its real path: a version manager's shim would try to
  // resolve a Node for the fresh HOME and fail before install.sh even runs.
  const PATH = `${bin}:${dirname(process.execPath)}:${process.env.PATH}`;
  let code = 0, output = "";
  try {
    output = execFileSync("sh", [INSTALL_SH, "install"], {
      env: { PATH, HOME: home, MOSHCODE_HOME: join(home, ".moshcode"), MOSHCODE_NO_PROXY: "1", NO_COLOR: "1" },
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    code = error.status;
    output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }
  const npm = existsSync(record) ? readFileSync(record, "utf8").split("\n") : null;
  return { code, output, home, npm };
}

test("a package.json with dependencies gets `npm install --omit=dev` inside MOSHCODE_HOME", () => {
  try {
    const r = runInstall({ pkg: { name: "moshcode", version: "9.9.9", dependencies: { "@profullstack/synconfig": "^0.1.1" } } });
    assert.equal(r.code, 0, r.output);
    assert.ok(r.npm, "npm was never called — the CLI would die on its first import");
    assert.equal(realpathSync(r.npm[0]), realpathSync(join(r.home, ".moshcode")), "dependencies must land in the install dir");
    assert.match(r.npm[1], /^install --omit=dev\b/);
    assert.match(r.output, /dependencies installed/);
  } finally { cleanup(); }
});

test("a dependency-free package.json never reaches for npm", () => {
  // devDependencies alone must not count: the word "dependencies" is in it.
  try {
    const r = runInstall({ pkg: { name: "moshcode", version: "9.9.9", devDependencies: { "some-linter": "1.0.0" } } });
    assert.equal(r.code, 0, r.output);
    assert.equal(r.npm, null, "npm was called for a package with nothing to install");
    assert.doesNotMatch(r.output, /runtime dependencies/);
  } finally { cleanup(); }
});

test("a failed npm install fails the install loudly instead of leaving a CLI that cannot start", () => {
  try {
    const r = runInstall({ pkg: { name: "moshcode", version: "9.9.9", dependencies: { "@profullstack/synconfig": "^0.1.1" } }, npmExit: 1 });
    assert.notEqual(r.code, 0, "install.sh reported success with the dependencies missing");
    assert.match(r.output, /npm install failed/);
    assert.match(r.output, /would not start/);
  } finally { cleanup(); }
});
