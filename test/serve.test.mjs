// Serving a Moshpit name from this machine.
//
// The config is four lines and every one is a line people get wrong the same
// way. These tests are mostly about the traps, not the templating.
import test from "node:test";
import assert from "node:assert/strict";

import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { caddySite, chooseTemplate, detectServer, nginxSite, servePlan, serveCommand, tlsFor } from "../src/serve.mjs";
import { pinFromCertificate } from "../src/pins.mjs";

/** A throwaway certificate, made here so the test carries no external fixture. */
function certificateFixture() {
  const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), "moshcode-cert-"));
  const crt = path.join(dir, "c.pem");
  execFileSync("openssl", [
    "req", "-x509", "-nodes", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
    "-keyout", path.join(dir, "k.pem"), "-out", crt, "-days", "1", "-subj", "/CN=demo.hacker",
  ], { stdio: "ignore" });
  const pem = fsSync.readFileSync(crt, "utf8");
  fsSync.rmSync(dir, { recursive: true, force: true });
  return pem;
}

test("no HTTPS redirect is ever emitted, for either server", () => {
  // The trap: a box's default vhost usually 301s to https, and for an ending
  // outside the DNS root that is a redirect to a page no certificate can exist
  // for. Through the gateway it is worse — the status is forwarded without the
  // Location header, so a visitor gets a 301 pointing nowhere at all.
  const nginx = nginxSite({ name: "chovy.hacker", root: "/srv/x" });
  assert.doesNotMatch(nginx, /return\s+30[12]/);
  assert.doesNotMatch(nginx, /https:\/\//);
  assert.match(nginx, /^\tserver_name chovy\.hacker;$/m, "exact name is what beats the default vhost");

  // Caddy's version of the same trap is the opposite shape: omit the scheme
  // and it tries to get a certificate, fails, and never serves.
  const caddy = caddySite({ name: "chovy.hacker", root: "/srv/x" });
  assert.match(caddy, /^http:\/\/chovy\.hacker \{$/m);
});

test("both address families are listened on", () => {
  // Resolver users arrive over IPv6 because that is what the name points at;
  // everyone else arrives via the gateway, which fetches server-side. Drop
  // either line and one audience silently loses the site.
  const conf = nginxSite({ name: "blue.eggs", root: "/srv/x" });
  assert.match(conf, /^\tlisten 80;$/m);
  assert.match(conf, /^\tlisten \[::\]:80;$/m);
});

test("a proxy target replaces the root, and forwards the name", () => {
  const conf = nginxSite({ name: "blue.eggs", proxy: 3000 });
  assert.match(conf, /proxy_pass http:\/\/127\.0\.0\.1:3000;/);
  // The app behind the proxy has no other way to know which name was asked for.
  assert.match(conf, /proxy_set_header X-Moshpit-Name \$host;/);
  assert.doesNotMatch(conf, /try_files/);
});

test("installing does not reload unless asked, and validates either way", () => {
  // Installing config and activating it are different decisions: the first is
  // undone by deleting a file, the second changes what a running server does
  // to live traffic.
  const quiet = servePlan({ name: "blue.eggs", server: "nginx", root: "/srv/x" });
  assert.deepEqual(quiet.steps.filter((s) => s.kind === "run").map((s) => s.command), ["nginx"], "checked, not reloaded");

  const plan = servePlan({ name: "blue.eggs", server: "nginx", root: "/srv/x", reload: true });
  const runs = plan.steps.filter((s) => s.kind === "run").map((s) => `${s.command} ${s.args.join(" ")}`);
  // Reloading an unparseable config is how a working box goes down while
  // adding a site to it.
  assert.deepEqual(runs, ["nginx -t", "systemctl reload nginx"]);
  assert.equal(runs.indexOf("nginx -t") < runs.indexOf("systemctl reload nginx"), true);
});

test("the server is whoever holds port 80, not whoever left a config directory", async () => {
  // The case that makes this worth doing: a box carrying /etc/nginx from a
  // package installed years ago while Caddy is the thing answering. Writing
  // nginx config there succeeds at every step and serves nothing, which is the
  // worst outcome available — everything reports success and the site is gone.
  assert.equal(
    await detectServer({
      listeners: async () => 'users:(("caddy",pid=1,fd=3))',
      exists: async (p) => p === "/etc/nginx",
    }),
    "caddy",
  );

  // Something else entirely: say so rather than write a file nothing reads.
  assert.deepEqual(
    await detectServer({ listeners: async () => 'users:(("lighttpd",pid=1,fd=3))', exists: async () => false }),
    { unknown: "lighttpd" },
  );

  // Without privileges `ss` shows the socket and no owner. That is the common
  // case for someone asking what *would* be installed, so it falls back to the
  // filesystem rather than refusing.
  assert.equal(
    await detectServer({ listeners: async () => "LISTEN 0 511 0.0.0.0:80", exists: async (p) => p === "/etc/nginx" }),
    "nginx",
  );

  assert.equal(await detectServer({ listeners: async () => "", exists: async () => false }), null);

  const plan = servePlan({ name: "blue.eggs", server: null, root: "/srv/x" });
  assert.equal(plan.ok, false);
  assert.match(plan.error, /nginx or caddy/);
});

test("nothing is written without --install", async () => {
  const lines = [];
  let wrote = 0;
  const code = await serveCommand(["blue.eggs"], (l) => lines.push(l), {
    detect: async () => "nginx",
    write: async () => { wrote += 1; },
    mkdir: async () => { wrote += 1; },
  });
  assert.equal(code, 0);
  assert.equal(wrote, 0, "planning must not touch the machine");
  assert.match(lines.join("\n"), /nothing written/);
});

test("--install stops at the first failed step", async () => {
  // Half-applying a site config and then reloading is worse than not starting.
  const lines = [];
  const code = await serveCommand(["blue.eggs", "--install"], (l) => lines.push(l), {
    detect: async () => "nginx",
    write: async () => { const e = new Error("denied"); e.code = "EACCES"; throw e; },
    mkdir: async () => {},
  });
  assert.equal(code, 1);
  assert.match(lines.join("\n"), /needs root/);
});

test("a name that is not a Moshpit name is refused before anything else", async () => {
  for (const bad of ["notaname", "a.b.c", "has-dash.eggs", ""]) {
    const lines = [];
    const code = await serveCommand([bad], (l) => lines.push(l), { detect: async () => "nginx" });
    assert.equal(code, 1, bad);
  }
});

test("a fresh site is seeded, because an empty root is a 404 that reads as broken", async () => {
  // The moment someone is trying to tell "the name resolved" from "the install
  // failed" is exactly the moment an empty root answers 404 and refuses to
  // help them tell the difference.
  const plan = servePlan({ name: "blue.eggs", server: "nginx", root: "/srv/x", seed: "/tpl/site" });
  const seed = plan.steps.find((s) => s.kind === "seed");
  assert.ok(seed, "seeded by default");
  assert.equal(seed.from, "/tpl/site");

  // Proxying has no root to seed.
  const proxied = servePlan({ name: "blue.eggs", server: "nginx", proxy: 3000, seed: "/tpl/site" });
  assert.equal(proxied.steps.some((s) => s.kind === "seed"), false);

  // --empty resolves to no seed at all.
  const empty = servePlan({ name: "blue.eggs", server: "nginx", root: "/srv/x", seed: null });
  assert.equal(empty.steps.some((s) => s.kind === "seed"), false);
});

test("an existing site is never seeded over", async () => {
  // Overwriting someone's index.html would be the worst kind of helpful.
  const lines = [];
  let seeded = false;
  await serveCommand(["blue.eggs", "--root", "/etc"], (l) => lines.push(l), {
    detect: async () => "nginx",
    write: async () => {},
    mkdir: async () => {},
    copy: async () => { seeded = true; },
  });
  assert.equal(seeded, false, "/etc is not empty, so nothing is seeded");
  assert.doesNotMatch(lines.join("\n"), /seed /);
});

test("a starter that does not exist is refused, not silently skipped", async () => {
  // The failure this prevents: a typo makes the seed directory missing, the
  // seed step is dropped, and the root is left empty — which is the 404 the
  // seeding exists to prevent, arrived at while reporting success.
  const list = async () => [{ name: "caddy-static" }, { name: "bun-caddy-sqlite" }];

  const typo = await chooseTemplate(["--template", "caddy-statik"], { list });
  assert.equal(typo.ok, false);
  assert.match(typo.error, /no starter called/);
  // Naming the two that do exist is most of the fix: the typo is one letter.
  assert.deepEqual(typo.available, ["caddy-static", "bun-caddy-sqlite"]);

  assert.equal((await chooseTemplate(["--template", "caddy-static"], { list })).template, "caddy-static");
  // No --template at all is still the default starter, and --empty still wins.
  assert.equal((await chooseTemplate([], { list })).template, "caddy-static");
  assert.equal((await chooseTemplate(["--empty"], { list })).template, null);
  assert.equal((await chooseTemplate(["--empty", "--template", "caddy-statik"], { list })).ok, true);
});

test("--template with no value does not read the next flag as the starter", async () => {
  // `site x.y --template --install` took "--install" as the name, found no
  // such directory, seeded nothing — and installed anyway, because --install
  // is matched separately.
  const list = async () => [{ name: "caddy-static" }];
  for (const args of [["--template"], ["--template", "--install"], ["--template", "--empty"]]) {
    const choice = await chooseTemplate(args, { list });
    assert.equal(choice.ok, args.includes("--empty"), JSON.stringify(args));
    if (!choice.ok) assert.match(choice.error, /takes the name of a starter/);
  }
});

test("a starter name cannot climb out of the bundled directory", async () => {
  // templates.mjs already refuses to treat anything with a slash or a dot as a
  // bundled name, for this reason. `site` joined the raw value into a path
  // under examples/templates without that check, so a value with enough ../ in
  // it named a copy source anywhere on the box — and the copy lands in a root a
  // web server is about to publish.
  const list = async () => [{ name: "caddy-static" }];
  for (const bad of ["../../../../etc", "a/b", "./caddy-static", "caddy static"]) {
    const choice = await chooseTemplate(["--template", bad], { list });
    assert.equal(choice.ok, false, bad);
    assert.match(choice.error, /not a starter name/);
  }
});

test("a bad --template stops the install before anything is written", async () => {
  for (const args of [
    ["blue.eggs", "--install", "--template", "caddy-statik"],
    ["blue.eggs", "--install", "--template", "../../../../tmp"],
    ["blue.eggs", "--template", "--install"],
  ]) {
    const lines = [];
    let touched = 0;
    const code = await serveCommand(args, (l) => lines.push(l), {
      detect: async () => "nginx",
      write: async () => { touched += 1; },
      mkdir: async () => { touched += 1; },
      copy: async () => { touched += 1; },
    });
    assert.equal(code, 1, JSON.stringify(args));
    assert.equal(touched, 0, "a starter we cannot find is not a reason to install a site with an empty root");
  }

  // The control: the starter that does exist still seeds.
  const lines = [];
  let seeded = null;
  const code = await serveCommand(["blue.eggs", "--install", "--template", "caddy-static"], (l) => lines.push(l), {
    detect: async () => "nginx",
    write: async () => {},
    mkdir: async () => {},
    copy: async (from) => { seeded = from; },
    // `nginx -t` really runs now, and there is no nginx to run it against here.
    runner: async () => ({ ok: true }),
  });
  assert.equal(code, 0);
  assert.match(String(seeded), /examples\/templates\/caddy-static\/site$/);
});

// ---- TLS, and the pin that makes it verifiable ----------------------------

test("without --tls the config is exactly what it was", () => {
  const conf = nginxSite({ name: "demo.hacker", root: "/srv/demo.hacker" });
  assert.doesNotMatch(conf, /listen 443/, "TLS is opt-in: it writes a key and publishes to the registry");
  assert.match(conf, /^\tlisten 80;$/m);
});

test("with a key, both ports serve the site and neither redirects to the other", () => {
  const conf = nginxSite({
    name: "demo.hacker",
    root: "/srv/demo.hacker",
    tls: { tld: "hacker", key: "/etc/ssl/moshpit/hacker.key", cert: "/etc/ssl/moshpit/hacker.crt", pin: "P".repeat(43) + "=" },
  });

  assert.match(conf, /^\tlisten 80;$/m);
  assert.match(conf, /^\tlisten 443 ssl;$/m);
  assert.match(conf, /ssl_certificate\s+\/etc\/ssl\/moshpit\/hacker\.crt;/);
  // The whole point. A redirect would send stock clients — which cannot verify
  // a pin — to a certificate they must reject, and through the gateway it
  // becomes a 301 with no Location at all.
  assert.doesNotMatch(conf, /return 301/, "port 80 must never redirect to a certificate stock clients cannot verify");
  // Both blocks serve the same root, or one of the two audiences gets nothing.
  assert.equal((conf.match(/root \/srv\/demo\.hacker;/g) || []).length, 2);
});

test("the key is created before the config that references it", () => {
  // nginx refuses to start when a referenced certificate is missing — not
  // just that site, the whole server, taking every other name on the box with
  // it. So ordering here is not tidiness.
  const plan = servePlan({
    name: "demo.hacker",
    server: "nginx",
    root: "/srv/demo.hacker",
    tls: { tld: "hacker", dir: "/etc/ssl/moshpit", key: "/k", cert: "/c", pin: null, create: { cmd: "openssl", args: ["req"] } },
  });

  const kinds = plan.steps.map((s) => s.kind);
  assert.ok(kinds.indexOf("run") < kinds.indexOf("write"), "openssl runs before the config is written");
  assert.equal(kinds[0], "mkdir", "and the directory exists before openssl writes into it");
});

test("the pin is published last, after the key exists", () => {
  // Publishing a pin for a key that failed to generate is worse than no pin:
  // clients would be told to expect a certificate this machine cannot
  // present, which is a hard failure rather than a missing one.
  const plan = servePlan({
    name: "demo.hacker",
    server: "nginx",
    root: "/srv/demo.hacker",
    reload: true,
    tls: { tld: "hacker", dir: "/etc/ssl/moshpit", key: "/k", cert: "/c", pin: "x", create: { cmd: "openssl", args: [] } },
  });

  assert.equal(plan.steps[plan.steps.length - 1].kind, "publish-pin");
  assert.equal(plan.steps[plan.steps.length - 1].tld, "hacker");
});

test("Caddy does not get a TLS block it cannot honour", async () => {
  // Caddy would try to provision from a CA, which is precisely what cannot
  // happen for an ending outside the DNS root.
  const plan = servePlan({
    name: "demo.hacker",
    server: "caddy",
    root: "/srv/demo.hacker",
    tls: { tld: "hacker", dir: "/etc/ssl/moshpit", key: "/k", cert: "/c", pin: "x", create: null },
  });

  assert.equal(plan.tls, null);
  assert.ok(!plan.steps.some((s) => s.kind === "publish-pin"));
});

test("a second name under the same ending reuses the key and its pin", async () => {
  // One key per ending is what the registry stores. The pin is read back off
  // the certificate rather than assumed, so the value published is the one
  // actually being served.
  const cert = certificateFixture();
  const tls = await tlsFor("second.hacker", { dir: "/etc/ssl/moshpit", readFile: async () => cert });

  assert.equal(tls.tld, "hacker");
  assert.equal(tls.create, null, "no new key when the ending already has one");
  assert.equal(tls.pin, pinFromCertificate(cert));
});

test("a run step that cannot execute fails loudly instead of being skipped", async () => {
  // This was silent, and it is how a config gets written referencing a key
  // that was never generated — then reported as live. `nginx -t` never
  // validated and `systemctl reload` never reloaded, so the file on disk was
  // not the config being served, which stays invisible until somebody
  // reloads nginx for an unrelated reason hours later.
  const lines = [];
  const code = await serveCommand(["blue.eggs", "--install"], (l) => lines.push(l), {
    detect: async () => "nginx",
    write: async () => {},
    mkdir: async () => {},
    copy: async () => {},
    runner: null,
  });

  assert.equal(code, 1, "no runner means nothing would take effect — that is a failure, not a success");
  assert.match(lines.join("\n"), /cannot run/);
});

test("a failing command stops the install and says which one", async () => {
  const lines = [];
  const code = await serveCommand(["blue.eggs", "--install"], (l) => lines.push(l), {
    detect: async () => "nginx",
    write: async () => {},
    mkdir: async () => {},
    copy: async () => {},
    runner: async () => ({ ok: false, code: 1, stderr: "nginx: [emerg] cannot load certificate" }),
  });

  assert.equal(code, 1);
  // The reason nginx gave, not just that something failed — that line is the
  // whole diagnosis and hiding it costs an hour.
  assert.match(lines.join("\n"), /cannot load certificate/);
});

test("the pin step prints the ending rather than undefined", async () => {
  const plan = servePlan({
    name: "demo.hacker",
    server: "nginx",
    root: "/srv/demo.hacker",
    tls: { tld: "hacker", dir: "/etc/ssl/moshpit", key: "/k", cert: "/c", pin: "x", create: null },
  });
  const step = plan.steps.find((s) => s.kind === "publish-pin");
  assert.equal(step.path, undefined, "it has no path, which is what printed `undefined`");
  assert.equal(step.tld, "hacker", "so the display has to use this instead");
});
