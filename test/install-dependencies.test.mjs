import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const source = readFileSync(new URL("../install.sh", import.meta.url), "utf8");
// Run the real payload installer without provisioning runtimes, shell rc files,
// or the optional proxy. Downloads and npm are local fixtures; node/tar are real.
const installer = source.slice(0, source.indexOf('\nCMD=')) + '\nfetch_and_unpack "$MOSHCODE_REF"\n';
const nestedPackage = false;

function fixture(t, { existing = false, npmMode = "install" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "moshcode-dependencies-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, "install with spaces");
  const pkg = nestedPackage ? join(home, "pkg") : home;
  const bin = join(dir, "fake-bin");
  const release = join(dir, "moshcode-fixture");
  mkdirSync(bin);
  mkdirSync(join(release, "bin"), { recursive: true });
  writeFileSync(join(release, "package.json"), JSON.stringify({
    name: "moshcode", version: "0.97.0", type: "module",
    dependencies: { "@profullstack/synconfig": "^0.1.1" },
  }));
  writeFileSync(join(release, "bin/moshcode.mjs"),
    'import { SNAPSHOT_VERSION } from "@profullstack/synconfig";\nconsole.log(`0.97.0 sync=${SNAPSHOT_VERSION}`);\n');
  const archive = join(dir, "release.tar.gz");
  execFileSync("tar", ["-czf", archive, "-C", dir, "moshcode-fixture"]);
  writeFileSync(join(bin, "curl"), '#!/bin/sh\ncat "$TEST_ARCHIVE"\n', { mode: 0o755 });
  writeFileSync(join(bin, "npm"), `#!/bin/sh
printf '%s\n' "$@" > "$TEST_NPM_ARGS"
[ "$TEST_NPM_MODE" != fail ] || exit 42
[ "$TEST_NPM_MODE" != skip ] || exit 0
mkdir -p node_modules/@profullstack/synconfig
printf '%s' '{"type":"module","exports":"./index.js"}' > node_modules/@profullstack/synconfig/package.json
printf '%s' 'export const SNAPSHOT_VERSION = 1;' > node_modules/@profullstack/synconfig/index.js
`, { mode: 0o755 });
  if (existing) {
    mkdirSync(join(pkg, "bin"), { recursive: true });
    writeFileSync(join(pkg, "bin/moshcode.mjs"), 'console.log("old working CLI");\n');
    writeFileSync(join(pkg, "keep-until-success"), "previous installation");
  }
  const npmArgs = join(dir, "npm-args");
  const result = spawnSync("sh", ["-s"], {
    input: installer,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      MOSHCODE_HOME: home,
      MOSHCODE_BIN: join(dir, "wrappers"),
      MOSHCODE_REF: "fixture",
      TEST_ARCHIVE: archive,
      TEST_NPM_ARGS: npmArgs,
      TEST_NPM_MODE: npmMode,
      TMPDIR: dir,
      NO_COLOR: "1",
    },
    timeout: 15000,
  });
  return { result, pkg, npmArgs };
}

test("a fresh archive installs runtime dependencies before its first startup", (t) => {
  const { result, pkg, npmArgs } = fixture(t);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(execFileSync(process.execPath, [join(pkg, "bin/moshcode.mjs"), "--version"], { encoding: "utf8" }).trim(), "0.97.0 sync=1");
  const args = readFileSync(npmArgs, "utf8").trim().split("\n");
  assert.equal(args[0], "install");
  assert.ok(args.includes("--omit=dev"));
  assert.ok(args.includes("--ignore-scripts"));
  assert.ok(args.includes("--package-lock=false"));
});

test("an update replaces the old payload only after dependencies and startup succeed", (t) => {
  const { result, pkg } = fixture(t, { existing: true });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(existsSync(join(pkg, "keep-until-success")), false);
  assert.match(execFileSync(process.execPath, [join(pkg, "bin/moshcode.mjs")], { encoding: "utf8" }), /0\.97\.0 sync=1/);
});

for (const [npmMode, expected] of [["fail", /runtime dependency installation failed/], ["skip", /CLI startup check failed/]]) {
  test(`${npmMode === "fail" ? "a registry failure" : "an unresolved dependency after npm succeeds"} preserves the installed CLI`, (t) => {
    const { result, pkg } = fixture(t, { existing: true, npmMode });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, expected);
    assert.match(result.stderr, /existing installation unchanged/);
    assert.equal(readFileSync(join(pkg, "keep-until-success"), "utf8"), "previous installation");
    assert.equal(execFileSync(process.execPath, [join(pkg, "bin/moshcode.mjs")], { encoding: "utf8" }).trim(), "old working CLI");
  });
}
