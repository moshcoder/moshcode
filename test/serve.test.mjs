// Serving a Moshpit name from this machine.
//
// The config is four lines and every one is a line people get wrong the same
// way. These tests are mostly about the traps, not the templating.
import test from "node:test";
import assert from "node:assert/strict";

import { caddySite, detectServer, nginxSite, servePlan, serveCommand } from "../src/serve.mjs";

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
