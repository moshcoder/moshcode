// `moshcode deploy` — which names it takes, what it parses, and the exact
// commands it would run.
//
// spawn, exists and has are injected throughout, so nothing here touches the
// network or a real server: these are about the command, not dev3.
import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_HOST, deployCommand, deployName, parseArgs, plan } from "../src/deploy.mjs";

const quiet = () => {};

test("deployName takes Moshpit names and refuses anything that is not one", () => {
  assert.equal(deployName("Shop.Blue."), "shop.blue");
  assert.equal(deployName("ad.network.pit.world"), "ad.network.pit.world");
  for (const bad of ["", "blue", "blue..eggs", ".blue", "-a.b", "a-.b", "a.b/c", "a.b;rm", "a b.c", "a.b$(x)"]) {
    assert.equal(deployName(bad), null, bad);
  }
});

test("parseArgs: defaults, env, flags in any position", () => {
  const a = parseArgs(["blue.eggs"], {});
  assert.deepEqual([a.name, a.dir, a.host, a.user, a.dryRun, a.error], ["blue.eggs", ".", DEFAULT_HOST, "", false, null]);

  const b = parseArgs(["--dry-run", "shop.blue", "site", "--host", "box.example", "--user=anna"], {});
  assert.deepEqual([b.name, b.dir, b.host, b.user, b.dryRun], ["shop.blue", "site", "box.example", "anna", true]);

  const c = parseArgs(["blue.eggs"], { MOSHCODE_DEPLOY_HOST: "other.box", MOSHCODE_DEPLOY_USER: "bo" });
  assert.deepEqual([c.host, c.user], ["other.box", "bo"]);

  assert.equal(parseArgs([], {}).help, true);
  assert.match(parseArgs(["blue"], {}).error, /not a Moshpit name/);
  assert.match(parseArgs(["a.b", "x", "y"], {}).error, /too many/);
  assert.match(parseArgs(["a.b", "--host"], {}).error, /needs a value/);
  assert.match(parseArgs(["a.b", "--host", "-oProxyCommand=x"], {}).error, /needs a value/);
  assert.match(parseArgs(["a.b", "--user", "x;y"], {}).error, /not a user/);
  assert.match(parseArgs(["a.b", "--host=-oProxyCommand"], {}).error, /not a host/);
  assert.match(parseArgs(["a.b", "--wat"], {}).error, /unknown flag/);
});

test("plan: a plain folder is the site and lands in public/", () => {
  const p = plan({ name: "shop.blue", dir: "site", host: "dev3.profullstack.com" }, { hasPublic: false });
  assert.equal(p.dest, "dev3.profullstack.com");
  const [prepare, upload, run] = p.steps;
  assert.deepEqual(prepare.argv.slice(0, 2), ["ssh", "dev3.profullstack.com"]);
  assert.match(prepare.argv[2], /mkdir -p 'apps\/shop\.blue\/public\/'/);
  assert.deepEqual(upload.argv.slice(0, 3), ["rsync", "-az", "--delete"]);
  for (const x of [".git", "node_modules", ".env", ".env.*", ".DS_Store"]) assert.ok(upload.argv.includes(x), x);
  assert.deepEqual(upload.argv.slice(-2), ["site/", "dev3.profullstack.com:apps/shop.blue/public/"]);
  assert.match(run.argv[2], /^cd 'apps\/shop\.blue' && if \[ -x deploy\.sh \]/);
  assert.match(run.argv[2], /exec "\$g" --name 'shop\.blue' -- \.\/deploy\.sh; else exec \.\/deploy\.sh/);
  assert.deepEqual(p.urls, ["https://shop.blue/", "https://shop.blue.pit.world/"]);
});

test("plan: a folder with public/ is an app and goes up whole, as user@host", () => {
  const p = plan({ name: "blue.eggs", dir: "app/", host: "box", user: "anna" }, { hasPublic: true });
  assert.deepEqual(p.steps[1].argv.slice(-2), ["app/", "anna@box:apps/blue.eggs/"]);
  assert.equal(p.steps[0].argv[1], "anna@box");
});

test("--dry-run prints the commands and runs nothing", async () => {
  const lines = [];
  let spawned = 0;
  const code = await deployCommand(["shop.blue", "site", "--dry-run"], {
    out: (s) => lines.push(s), err: quiet, env: {}, exists: (p) => p === "site", spawn: () => { spawned += 1; },
  });
  assert.equal(code, 0);
  assert.equal(spawned, 0);
  assert.equal(lines.length, 3);
  assert.match(lines[1], /^rsync -az --delete .* site\/ dev3\.profullstack\.com:apps\/shop\.blue\/public\/$/);
});

test("runs prepare, upload, deploy.sh in order and flags a first deploy", async () => {
  const calls = [];
  const lines = [];
  const code = await deployCommand(["shop.blue", "site", "--json"], {
    out: (s) => lines.push(s), err: quiet, env: {}, exists: (p) => p === "site", has: () => true,
    spawn: (bin, args) => { calls.push(bin); return { status: 0, stdout: calls.length === 1 ? "new\n" : "" }; },
  });
  assert.equal(code, 0);
  assert.deepEqual(calls, ["ssh", "rsync", "ssh"]);
  const result = JSON.parse(lines.at(-1));
  assert.equal(result.firstDeploy, true);
  assert.deepEqual(result.urls, ["https://shop.blue/", "https://shop.blue.pit.world/"]);
});

test("the failing step's exit code is the command's, and later steps do not run", async () => {
  const calls = [];
  const code = await deployCommand(["shop.blue"], {
    out: quiet, err: quiet, env: {}, exists: () => true, has: () => true,
    spawn: (bin) => { calls.push(bin); return { status: calls.length === 2 ? 23 : 0, stdout: "existing" }; },
  });
  assert.equal(code, 23);
  assert.deepEqual(calls, ["ssh", "rsync"]);
});

test("missing rsync is a clear error, not a spawn failure", async () => {
  const errors = [];
  const code = await deployCommand(["shop.blue"], {
    out: quiet, err: (s) => errors.push(s), env: {}, exists: () => true, has: (bin) => bin !== "rsync", spawn: () => assert.fail("ran"),
  });
  assert.equal(code, 127);
  assert.match(errors[0], /rsync is not installed/);
});

test("a folder that is not there stops before anything runs", async () => {
  const errors = [];
  const code = await deployCommand(["shop.blue", "nope"], { out: quiet, err: (s) => errors.push(s), env: {}, exists: () => false });
  assert.equal(code, 1);
  assert.match(errors[0], /no such folder: nope/);
});
