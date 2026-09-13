// install.sh must never replace the operator's config directory. The
// moshcoding.com installer keeps the package under ~/.moshcode/pkg and uses
// ~/.moshcode for aliases.json, credentials.json, herd/ and the rest; this
// installer replaces $MOSHCODE_HOME wholesale. Run by hand on a box the other
// one set up, it removed every alias, the account login and the herd's
// ledger in one rm -rf (seen 2026-09-13). Same harness as install-deps: the
// real script, a tarball built here, curl and npm shadowed.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const INSTALL_SH = fileURLToPath(new URL("../install.sh", import.meta.url));
const scratch = [];
const cleanup = () => { for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true }); };

function shadow(bin, name, body) {
  writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
}

/** Run the installer into a HOME whose ~/.moshcode is prepared by `seed`. */
function runInstall(seed) {
  const root = mkdtempSync(join(tmpdir(), "moshcode-cfg-"));
  scratch.push(root);
  const home = join(root, "home");
  const bin = join(root, "bin");
  const cfg = join(home, ".moshcode");
  mkdirSync(cfg, { recursive: true }); mkdirSync(bin);
  seed(cfg);
  const src = join(root, "moshcode-v9.9.9");
  mkdirSync(join(src, "bin"), { recursive: true });
  writeFileSync(join(src, "bin", "moshcode.mjs"), "console.log('fake');\n");
  writeFileSync(join(src, "package.json"), JSON.stringify({ name: "moshcode", version: "9.9.9" }));
  const tgz = join(root, "moshcode.tgz");
  execFileSync("tar", ["-czf", tgz, "-C", root, "moshcode-v9.9.9"]);
  shadow(bin, "curl", `case "$*" in
  *api.github.com*) printf '{"tag_name":"v9.9.9"}' ;;
  *codeload.github.com*) cat "${tgz}" ;;
  *) exit 22 ;;
esac`);
  shadow(bin, "npm", "exit 0");
  const PATH = `${bin}:${dirname(process.execPath)}:${process.env.PATH}`;
  let code = 0, output = "";
  try {
    output = execFileSync("sh", [INSTALL_SH, "install"], {
      env: { PATH, HOME: home, MOSHCODE_NO_PROXY: "1", NO_COLOR: "1" },
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) { code = error.status; output = `${error.stdout ?? ""}${error.stderr ?? ""}`; }
  const wrapper = existsSync(join(home, ".local/bin/moshcode")) ? readFileSync(join(home, ".local/bin/moshcode"), "utf8") : "";
  return { code, output, cfg, wrapper };
}

test("a ~/.moshcode that holds the operator's files is kept, and the package goes under pkg/", () => {
  try {
    const r = runInstall((cfg) => {
      writeFileSync(join(cfg, "aliases.json"), '{"deploy":"railway up"}');
      writeFileSync(join(cfg, "credentials.json"), '{"token":"secret"}');
      mkdirSync(join(cfg, "herd")); writeFileSync(join(cfg, "herd", "rules.json"), "{}");
    });
    assert.equal(r.code, 0, r.output);
    assert.equal(readFileSync(join(r.cfg, "aliases.json"), "utf8"), '{"deploy":"railway up"}', "the aliases were replaced");
    assert.ok(existsSync(join(r.cfg, "credentials.json")), "the account login was removed");
    assert.ok(existsSync(join(r.cfg, "herd", "rules.json")), "the herd's files were removed");
    assert.ok(existsSync(join(r.cfg, "pkg", "bin", "moshcode.mjs")), "the package did not land under pkg/");
    assert.match(r.wrapper, /\.moshcode\/pkg\/bin\/moshcode\.mjs/, "the wrapper must point at the package under pkg/");
    assert.match(r.output, /holds your settings/);
  } finally { cleanup(); }
});

test("a ~/.moshcode that already has a pkg/ package is upgraded in place", () => {
  try {
    const r = runInstall((cfg) => {
      mkdirSync(join(cfg, "pkg", "bin"), { recursive: true });
      writeFileSync(join(cfg, "pkg", "bin", "moshcode.mjs"), "console.log('old');\n");
      writeFileSync(join(cfg, "news.opml"), "<opml/>");
    });
    assert.equal(r.code, 0, r.output);
    assert.equal(readFileSync(join(r.cfg, "pkg", "bin", "moshcode.mjs"), "utf8"), "console.log('fake');\n", "pkg/ was not replaced with the new package");
    assert.ok(existsSync(join(r.cfg, "news.opml")), "a file beside pkg/ was removed");
  } finally { cleanup(); }
});

test("an empty or package-only ~/.moshcode keeps today's flat layout", () => {
  // The layout this installer has always produced, and what `moshcode
  // upgrade` expects when it exports MOSHCODE_HOME to the dir it runs from.
  try {
    const r = runInstall(() => {});
    assert.equal(r.code, 0, r.output);
    assert.ok(existsSync(join(r.cfg, "bin", "moshcode.mjs")), "the flat layout was abandoned for a fresh install");
    assert.ok(!existsSync(join(r.cfg, "pkg")), "pkg/ appeared with nothing to protect");
    assert.doesNotMatch(r.output, /holds your settings/);
  } finally { cleanup(); }
});
