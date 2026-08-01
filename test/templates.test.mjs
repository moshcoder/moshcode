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

/* --------------------------------------------- every template, held to the bar */

// Written as a loop over whatever is bundled rather than a list of names, so a
// template added later is held to this without anyone remembering to add it.
// The gap that prompted these: caddy-static shipped without a README while the
// installer told everyone to "start with README.md".

test("every bundled template has a README, since the installer sends people to it", async () => {
  const templates = await listTemplates();
  assert.ok(templates.length > 0, "no templates found at all");
  for (const { name } of templates) {
    const readme = path.join(BUNDLED_DIR, name, "README.md");
    const body = await fs.readFile(readme, "utf8").catch(() => null);
    assert.ok(body, `${name} has no README.md`);
    assert.ok(body.trim().length > 200, `${name}'s README is a stub`);
    assert.match(body, new RegExp(`^# ${name}$`, "m"), `${name}'s README does not name it`);
  }
});

test("every manifest names itself and says what it is for", async () => {
  for (const { name } of await listTemplates()) {
    const raw = await fs.readFile(path.join(BUNDLED_DIR, name, "template.json"), "utf8");
    const manifest = JSON.parse(raw);
    assert.equal(manifest.name, name, `${name}/template.json disagrees with its directory`);
    assert.ok(manifest.description?.length > 20, `${name} needs a real description`);
    assert.ok(manifest.vars?.MOSHPIT_NAME, `${name} does not document MOSHPIT_NAME`);
  }
});

test("every template documents the two things people get wrong", async () => {
  // The resolver split and the no-HTTPS limit are the two facts that turn a
  // working stack into a broken one when they are missing.
  for (const { name } of await listTemplates()) {
    const readme = await fs.readFile(path.join(BUNDLED_DIR, name, "README.md"), "utf8");
    assert.match(readme, /moshcode dns enable/, `${name} never tells visitors to enable the resolver`);
    assert.match(readme, /No HTTPS/i, `${name} does not warn that there is no HTTPS`);
  }
});

test("every bundled systemd unit is installable", async () => {
  for (const { name } of await listTemplates()) {
    const deploy = path.join(BUNDLED_DIR, name, "deploy");
    const units = await fs.readdir(deploy).catch(() => []);
    assert.ok(units.length > 0, `${name} ships no units`);
    for (const unit of units.filter((u) => u.endsWith(".service"))) {
      const body = await fs.readFile(path.join(deploy, unit), "utf8");
      // A unit missing [Install] enables without error and then never starts
      // on boot, which is exactly the failure these units exist to prevent.
      for (const section of ["[Unit]", "[Service]", "[Install]"]) {
        assert.ok(body.includes(section), `${name}/${unit} has no ${section}`);
      }
      assert.match(body, /^ExecStart=/m, `${name}/${unit} has no ExecStart`);
      assert.match(body, /^WantedBy=/m, `${name}/${unit} would not start on boot`);
    }
  }
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
