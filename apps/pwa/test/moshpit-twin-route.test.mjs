// The twin endpoints, over a real socket.
//
// The model has its own tests; these are about the contract a client sees, and
// one of them cannot be checked anywhere else: that publishing a twin does not
// move `prefer`. That is the whole safety property of the feature -- a twin is
// a domain which already answers in the legacy root, so if it fed into
// precedence the pit would start outranking DNS for names DNS gave it -- and it
// lives in the shape of the resolve response rather than in any one function.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
let deps = null;
try {
  deps = { express: require("express"), cookieParser: require("cookie-parser") };
} catch {
  deps = null;
}

const workdir = mkdtempSync(path.join(tmpdir(), "moshcode-twin-route-test-"));
process.env.DATABASE_URL = `file:${path.join(workdir, "test.db")}`;
process.env.SESSION_SECRET = "test-secret";

async function boot() {
  const { migrate } = await import("../src/migrate.mjs");
  await migrate();
  const { run } = await import("../src/db.mjs");
  const { sessionMiddleware, csrfGuard } = await import("../src/lib/session.mjs");
  const { moshpitRouter } = await import("../src/routes/moshpit.mjs");
  const { createApiKey } = await import("../src/lib/apikey.mjs");
  const moshpit = await import("../src/moshpit.mjs");

  await run(`INSERT OR REPLACE INTO users (id, email, display_name, created_at) VALUES ('u1','a@b.c','one',1)`);
  await run(`INSERT INTO moshpit_tlds (tld,user_id,owner_email,created_at) VALUES ('eggs','u1','a@b.c',1)`);
  await run(`INSERT INTO moshpit_names (tld,label,user_id,created_at) VALUES ('eggs','blue','u1',1)`);
  await run(`INSERT INTO moshpit_names (tld,label,user_id,created_at) VALUES ('eggs','bare','u1',1)`);
  const key = (await createApiKey("u1", "cli one")).plaintext;

  const app = deps.express();
  app.use(deps.express.json());
  app.use(deps.express.urlencoded({ extended: false }));
  app.use(deps.cookieParser());
  app.use(sessionMiddleware);
  app.use(csrfGuard);
  app.use(moshpitRouter);

  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (method, url, { body, token = key } = {}) => {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: {
        ...(body ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    let json = null;
    try { json = await res.json(); } catch { json = null; }
    return { status: res.status, body: json };
  };

  return { call, server, moshpit };
}

test("the twin endpoints", { skip: deps ? false : "express not installed" }, async (t) => {
  const { call, server, moshpit } = await boot();
  t.after(() => server.close());

  await t.test("an unclaimed name says so, and offers what is available", async () => {
    const r = await call("GET", "/api/moshpit/twin?name=bare.eggs");
    assert.equal(r.status, 200);
    assert.equal(r.body.twin, null);
    assert.deepEqual(r.body.available, ["bare-eggs.com", "bare-eggs.net", "bare-eggs.org"]);
    assert.equal(r.body.price_usd, moshpit.TWIN_PRICE_USD);
  });

  await t.test("a name this registry does not answer for is a 404", async () => {
    const r = await call("GET", "/api/moshpit/twin?name=example.com");
    assert.equal(r.status, 404);
    assert.equal(r.body.twin, null);
  });

  await t.test("claiming needs the name's holder", async () => {
    const anon = await call("POST", "/api/moshpit/tlds/eggs/twin", { body: { label: "blue", domain: "blueeggs.com" }, token: null });
    assert.equal(anon.status, 401);
  });

  await t.test("a claim comes back with the record to publish", async () => {
    const r = await call("POST", "/api/moshpit/tlds/eggs/twin", { body: { label: "blue", domain: "blueeggs.com" } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.status, "pending");
    assert.equal(r.body.proof.host, "_moshpit.blueeggs.com");
    assert.equal(r.body.proof.type, "TXT");
    assert.match(r.body.proof.value, /^v=moshpit1 name=blue\.eggs token=[0-9a-f]{32}$/);
    // The public view shows the claim but never the challenge.
    const pub = await call("GET", "/api/moshpit/tlds/eggs/twin?label=blue");
    assert.equal(pub.body.status, "pending");
    assert.equal(pub.body.token, undefined);
    // Pending is not served.
    assert.equal((await call("GET", "/api/moshpit/twin?name=blue.eggs")).body.twin, null);
  });

  await t.test("a domain reading as another name's twin is refused", async () => {
    const r = await call("POST", "/api/moshpit/tlds/eggs/twin", { body: { label: "blue", domain: "red-eggs.net" } });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /reads as the twin of red\.eggs/);
  });

  await t.test("an unpublished record is a 202, not a refusal", async () => {
    // `.invalid` never resolves (RFC 2606), so this exercises the real resolver
    // without depending on anything outside the machine. Whether the lookup
    // NXDOMAINs or the resolver is unreachable, both are "wait and retry" and
    // both must read as the same accepted-and-unfinished answer.
    await call("POST", "/api/moshpit/tlds/eggs/twin", { body: { label: "blue", domain: "twintest.invalid", replace: true } });
    const r = await call("POST", "/api/moshpit/tlds/eggs/twin/verify", { body: { label: "blue" } });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    assert.equal(r.body.verified, false);
    assert.ok(r.body.proof?.value, "told again what to publish");
  });

  await t.test("a verified twin is served, and replacing it is a 409", async () => {
    // Verified through the model with a stubbed resolver: the HTTP layer has no
    // seam for DNS, and inventing one only for a test would be a worse design
    // than the one it was checking.
    const claim = await moshpit.claimTwin({ tld: "eggs", label: "blue", userId: "u1", domain: "blueeggs.com", replace: true });
    const proof = moshpit.twinProof({ name: "blue.eggs", token: claim.token });
    const ok = await moshpit.verifyTwin({
      tld: "eggs", label: "blue", userId: "u1",
      resolveTxt: async () => [[proof]],
    });
    assert.equal(ok.ok, true, ok.error);

    const r = await call("GET", "/api/moshpit/twin?name=blue.eggs");
    assert.equal(r.body.twin, "blueeggs.com");
    assert.equal(r.body.proof.host, "_moshpit.blueeggs.com");
    assert.ok(r.body.verified_at);
    // No suggestions once it has one.
    assert.equal(r.body.available, undefined);

    const clash = await call("POST", "/api/moshpit/tlds/eggs/twin", { body: { label: "blue", domain: "somethingelse.com" } });
    assert.equal(clash.status, 409);
    assert.equal(clash.body.replaceable, true);
    assert.equal(clash.body.current, "blueeggs.com");
  });

  await t.test("resolve carries the twin only when asked", async () => {
    const bare = await call("GET", "/api/moshpit/resolve?name=blue.eggs");
    assert.equal(bare.body.twin, undefined, "every DNS query lands here; it does not pay for a second table");

    const asked = await call("GET", "/api/moshpit/resolve?name=blue.eggs&twin=1");
    assert.equal(asked.body.twin, "blueeggs.com");
  });

  await t.test("a twin does not move `prefer`", async () => {
    // The line to hold. A twin already answers in the legacy root, so letting it
    // touch precedence would have the pit outrank DNS for names DNS handed it.
    const backfilled = await call("GET", "/api/moshpit/resolve?name=blue.eggs&twin=1");
    const plain = await call("GET", "/api/moshpit/resolve?name=bare.eggs&twin=1");
    assert.equal(backfilled.body.twin, "blueeggs.com");
    assert.equal(plain.body.twin, undefined, "no twin on this one");
    assert.equal(backfilled.body.prefer, "fallback");
    assert.equal(plain.body.prefer, backfilled.body.prefer,
      "the backfilled name and the bare one prefer the same thing");

    // ...in either mode, and the opt-in is still the only thing that changes it.
    const opted = await call("GET", "/api/moshpit/resolve?name=blue.eggs&twin=1&mode=moshpit");
    assert.equal(opted.body.prefer, "moshpit");
    const optedPlain = await call("GET", "/api/moshpit/resolve?name=bare.eggs&mode=moshpit");
    assert.equal(optedPlain.body.prefer, "moshpit");
  });

  await t.test("removing a twin stops it being served", async () => {
    const r = await call("DELETE", "/api/moshpit/tlds/eggs/twin", { body: { label: "blue" } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await call("GET", "/api/moshpit/twin?name=blue.eggs")).body.twin, null);
    // And saying so twice is a 404, not a second success.
    assert.equal((await call("DELETE", "/api/moshpit/tlds/eggs/twin", { body: { label: "blue" } })).status, 404);
  });
});
