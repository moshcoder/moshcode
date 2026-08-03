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
  fetchRemote,
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
    { spec: "caddy-static", into: "/srv/site", force: false, dryRun: false });
  assert.deepEqual(parseInstallArgs(["caddy-static", "--into", "/srv/site"]),
    { spec: "caddy-static", into: "/srv/site", force: false, dryRun: false });
  assert.deepEqual(parseInstallArgs(["--dry-run", "caddy-static", "--into=/srv/site", "--force"]),
    { spec: "caddy-static", into: "/srv/site", force: true, dryRun: true });
  assert.deepEqual(parseInstallArgs(["caddy-static", "--dry-run"]),
    { spec: "caddy-static", into: null, force: false, dryRun: true });
  assert.deepEqual(parseInstallArgs([]), { spec: null, into: null, force: false, dryRun: false });
  assert.match(parseInstallArgs(["caddy-static", "--dryrun"]).error, /unknown option/);
  assert.match(parseInstallArgs(["caddy-static", "--into", "--dry-run"]).error, /requires a directory/);
  assert.match(parseInstallArgs(["caddy-static", "--into="]).error, /requires a directory/);
});

test("invalid safety flags fail before an install can touch the working directory", async () => {
  for (const args of [
    ["install", "caddy-static", "--dryrun"],
    ["install", "caddy-static", "--into", "--dry-run"],
    ["install", "caddy-static", "--into="],
  ]) {
    const cwd = await tmp();
    const lines = [];
    try {
      const code = await templateCommand(args, (line) => lines.push(line), { cwd });
      assert.equal(code, 1, args.join(" "));
      assert.deepEqual(await fs.readdir(cwd), [], args.join(" "));
      assert.match(lines.join("\n"), /unknown option|requires a directory/);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  }
});

test("--dry-run previews an install without creating the target", async () => {
  const parent = await tmp();
  const into = path.join(parent, "site");
  const lines = [];
  try {
    const code = await templateCommand(
      ["install", "caddy-static", "--dry-run", "--into", into],
      (line) => lines.push(line),
    );
    assert.equal(code, 0);
    await assert.rejects(fs.access(into));
    assert.ok(lines.some((line) => line.includes("create  Caddyfile")));
    assert.match(lines.join("\n"), /dry run; nothing was written/);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test("--dry-run reports blocking conflicts without writing any file", async () => {
  const into = await tmp();
  const lines = [];
  try {
    await fs.writeFile(path.join(into, "Caddyfile"), "mine\n");
    const code = await templateCommand(
      ["install", "caddy-static", "--into", into, "--dry-run"],
      (line) => lines.push(line),
    );
    assert.equal(code, 1);
    assert.ok(lines.includes("  overwrite  Caddyfile"));
    assert.match(lines.join("\n"), /would block this install/);
    assert.equal(await fs.readFile(path.join(into, "Caddyfile"), "utf8"), "mine\n");
    assert.deepEqual(await fs.readdir(into), ["Caddyfile"]);
  } finally {
    await fs.rm(into, { recursive: true, force: true });
  }
});

test("--force --dry-run previews overwrites without applying them", async () => {
  const into = await tmp();
  const lines = [];
  try {
    await fs.writeFile(path.join(into, "Caddyfile"), "mine\n");
    const code = await templateCommand(
      ["install", "--dry-run", "caddy-static", "--into", into, "--force"],
      (line) => lines.push(line),
    );
    assert.equal(code, 0);
    assert.ok(lines.includes("  overwrite  Caddyfile"));
    assert.match(lines.join("\n"), /would be written/);
    assert.equal(await fs.readFile(path.join(into, "Caddyfile"), "utf8"), "mine\n");
    assert.deepEqual(await fs.readdir(into), ["Caddyfile"]);
  } finally {
    await fs.rm(into, { recursive: true, force: true });
  }
});

test("tarball fetches expose the whole temporary tree for cleanup", async () => {
  const tmpRoot = await tmp();
  try {
    const fetched = await fetchRemote(
      { kind: "tarball", url: "https://example.test/template.tar.gz" },
      {
        tmpRoot,
        fetchImpl: async () => ({
          ok: true,
          arrayBuffer: async () => Buffer.from("placeholder archive"),
        }),
        runImpl: async (_command, args) => {
          if (args[0] === "-tzf") {
            return { ok: true, code: 0, stdout: "template/README.md\n" };
          }
          const outputIndex = args.indexOf("-C") + 1;
          const output = args[outputIndex];
          await fs.writeFile(path.join(output, "README.md"), "# fetched\n");
          return { ok: true, code: 0, stdout: "" };
        },
      },
    );
    assert.equal(fetched.ok, true);
    assert.equal(fetched.dir, path.join(fetched.cleanupDir, "unpacked"));
    assert.equal(path.dirname(fetched.cleanupDir), tmpRoot);
    await fs.access(path.join(fetched.cleanupDir, "template.tar.gz"));
    await fs.access(path.join(fetched.dir, "README.md"));
    await fs.rm(fetched.cleanupDir, { recursive: true, force: true });
    await assert.rejects(fs.access(fetched.cleanupDir));
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test("remote dry runs remove their fetch workspace and leave the target empty", async () => {
  const cleanupDir = await tmp();
  const from = path.join(cleanupDir, "unpacked");
  const into = await tmp();
  const lines = [];
  await fs.mkdir(from);
  await fs.writeFile(path.join(from, "README.md"), "# remote template\n");
  try {
    const code = await templateCommand(
      ["install", "https://example.test/template.tar.gz", "--dry-run", "--into", into],
      (line) => lines.push(line),
      { fetchRemoteImpl: async () => ({ ok: true, dir: from, cleanupDir }) },
    );
    assert.equal(code, 0);
    assert.deepEqual(await fs.readdir(into), []);
    await assert.rejects(fs.access(cleanupDir));
    assert.match(lines.join("\n"), /dry run; nothing was written/);
  } finally {
    await fs.rm(cleanupDir, { recursive: true, force: true });
    await fs.rm(into, { recursive: true, force: true });
  }
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

test("symbolic links are identified before template files are copied", async (t) => {
  const root = await tmp();
  const from = path.join(root, "from");
  const into = path.join(root, "into");
  const synthetic = path.join(root, "synthetic.txt");
  try {
    await fs.mkdir(from);
    await fs.mkdir(into);
    await fs.writeFile(synthetic, "synthetic test data\n");
    try {
      await fs.symlink(synthetic, path.join(from, "copied.txt"), "file");
    } catch (error) {
      if (error?.code === "EPERM") {
        t.skip("symbolic links require elevated privileges on this Windows host");
        return;
      }
      throw error;
    }

    const plan = await installPlan(from, into);
    assert.deepEqual(plan.files, []);
    assert.deepEqual(plan.unsafe, ["copied.txt"]);
    assert.deepEqual(await fs.readdir(into), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
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
