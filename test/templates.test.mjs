// The template installer.
//
// Most of this is ordinary scaffolding, but two parts are not: `install <url>`
// takes a stranger's URL, and the thing it writes is a directory of systemd
// units. A unit written to a path of the archive's choosing is a root shell on
// the next boot, so the path checks below are the security tests, not tidiness.
import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  BUNDLED_DIR,
  applyInstall,
  classifySource,
  installPlan,
  listTemplates,
  parseInstallArgs,
  safeEntry,
  templateCommand,
} from "../src/templates.mjs";

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), "moshcode-template-test-"));

test("the bundled templates are listed with what they are for", async () => {
  const templates = await listTemplates();
  const names = templates.map((t) => t.name);
  assert.ok(names.includes("bun-caddy-sqlite"), `got ${names.join(", ")}`);
  assert.ok(names.includes("caddy-static"));
  for (const template of templates) {
    assert.ok(template.description.length > 0, `${template.name} has no description`);
  }
});

test("an archive member that escapes the target is refused", () => {
  // Each of these writes outside the directory the user chose.
  for (const evil of [
    "/etc/systemd/system/rooted.service",
    "../../../etc/systemd/system/rooted.service",
    "deploy/../../../../root/.ssh/authorized_keys",
    "..\\..\\windows\\system32\\evil.dll",
    "C:\\windows\\evil.dll",
  ]) {
    assert.equal(safeEntry(evil), false, evil);
  }
  for (const fine of ["Caddyfile", "deploy/unit.service", "src/a/b/c.ts", "a..b/c"]) {
    assert.equal(safeEntry(fine), true, fine);
  }
});

test("sources are told apart, and a name can never be a path", () => {
  assert.deepEqual(classifySource("bun-caddy-sqlite"), { kind: "bundled", name: "bun-caddy-sqlite" });
  assert.equal(classifySource("https://example.com/x.tar.gz").kind, "tarball");
  assert.equal(classifySource("https://example.com/x.tgz").kind, "tarball");
  assert.equal(classifySource("https://github.com/o/r.git").kind, "git");
  assert.equal(classifySource("git@github.com:o/r.git").kind, "git");
  assert.deepEqual(classifySource("owner/repo"), { kind: "git", url: "https://github.com/owner/repo.git" });
  assert.equal(classifySource("").kind, "none");

  // The whole point: a "name" carrying a path separator is never resolved
  // against the bundled directory.
  for (const sneaky of ["../../../etc/passwd", "/etc/passwd", "a/../b"]) {
    assert.notEqual(classifySource(sneaky).kind, "bundled", sneaky);
  }
});

test("--into consumes its argument rather than donating it as the name", () => {
  assert.deepEqual(parseInstallArgs(["--into", "/srv/site", "caddy-static"]),
    { spec: "caddy-static", into: "/srv/site", force: false });
  assert.deepEqual(parseInstallArgs(["caddy-static", "--into", "/srv/site"]),
    { spec: "caddy-static", into: "/srv/site", force: false });
  assert.deepEqual(parseInstallArgs(["caddy-static", "--into=/srv/site", "--force"]),
    { spec: "caddy-static", into: "/srv/site", force: true });
  assert.deepEqual(parseInstallArgs([]), { spec: null, into: null, force: false });
});

test("the manifest describes the copy without being part of it", async () => {
  const into = await tmp();
  try {
    const { files } = await installPlan(path.join(BUNDLED_DIR, "caddy-static"), into);
    assert.ok(files.length > 0);
    assert.ok(!files.includes("template.json"), "template.json must not be installed");
    assert.ok(files.includes("Caddyfile"));
  } finally {
    await fs.rm(into, { recursive: true, force: true });
  }
});

test("an install that would clobber something writes nothing at all", async () => {
  const into = await tmp();
  try {
    const from = path.join(BUNDLED_DIR, "caddy-static");
    await fs.writeFile(path.join(into, "Caddyfile"), "mine, do not touch\n");

    const plan = await installPlan(from, into);
    assert.deepEqual(plan.conflicts, ["Caddyfile"]);

    const code = await templateCommand(["install", "caddy-static", "--into", into], () => {});
    assert.equal(code, 1, "refused");
    assert.equal(await fs.readFile(path.join(into, "Caddyfile"), "utf8"), "mine, do not touch\n");
    // A partial install is the failure worth preventing: nothing else landed.
    assert.deepEqual(await fs.readdir(into), ["Caddyfile"]);
  } finally {
    await fs.rm(into, { recursive: true, force: true });
  }
});

test("--force overwrites, and only then", async () => {
  const into = await tmp();
  try {
    await fs.writeFile(path.join(into, "Caddyfile"), "mine\n");
    const code = await templateCommand(["install", "caddy-static", "--into", into, "--force"], () => {});
    assert.equal(code, 0);
    assert.notEqual(await fs.readFile(path.join(into, "Caddyfile"), "utf8"), "mine\n");
  } finally {
    await fs.rm(into, { recursive: true, force: true });
  }
});

test("installing lays the tree out where the README says it is", async () => {
  const into = await tmp();
  try {
    const code = await templateCommand(["install", "bun-caddy-sqlite", "--into", into], () => {});
    assert.equal(code, 0);
    for (const expected of [
      "Caddyfile",
      "package.json",
      "src/server.ts",
      "src/db.ts",
      "deploy/moshpit-service.service",
      "deploy/moshcode-dns.service",
    ]) {
      await fs.access(path.join(into, expected));
    }
  } finally {
    await fs.rm(into, { recursive: true, force: true });
  }
});

test("a template nobody bundled is a message, not a stack trace", async () => {
  const lines = [];
  const code = await templateCommand(["install", "no-such-template"], (l) => lines.push(l));
  assert.equal(code, 1);
  assert.match(lines.join("\n"), /no bundled template/);
});

test("the Caddyfiles keep the scheme that stops Caddy chasing a certificate", async () => {
  // Dropping `http://` makes Caddy try to provision a cert for an ending no CA
  // will issue for, and the site never comes up. Easy to "tidy away" later.
  for (const template of ["bun-caddy-sqlite", "caddy-static"]) {
    const caddyfile = await fs.readFile(path.join(BUNDLED_DIR, template, "Caddyfile"), "utf8");
    assert.match(caddyfile, /^http:\/\/\{\$MOSHPIT_NAME/m, template);
  }
});

test("the service binds loopback, so nothing is published without a name in front", async () => {
  const server = await fs.readFile(path.join(BUNDLED_DIR, "bun-caddy-sqlite", "src", "server.ts"), "utf8");
  assert.match(server, /HOST \|\| "127\.0\.0\.1"/);
});
