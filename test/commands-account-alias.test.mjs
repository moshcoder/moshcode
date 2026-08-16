import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// src/auth.mjs resolves the credentials path at import time, so $HOME has to
// move BEFORE the dynamic imports below — the same ordering test/auth.test.mjs
// depends on. This keeps the suite from reading or writing the credentials and
// aliases of whoever is running it.
const HOME = mkdtempSync(join(tmpdir(), "moshcode-script-account-"));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
// Pin the login flow so a test that reaches it can never try to open a browser
// on the machine running the suite.
process.env.MOSHCODE_LOGIN = "device";

const { moshVocabulary } = await import("../src/commands.mjs");
const { saveCreds } = await import("../src/auth.mjs");
const { getAlias } = await import("../src/aliases.mjs");

function createCtx({ dryRun = true } = {}) {
  return {
    dryRun,
    iter: 0,
    stopped: false,
    lines: [],
    out(line) { this.lines.push(line); },
    stop() { this.stopped = true; },
  };
}

function verb(name) {
  const cmd = moshVocabulary().get(name);
  assert.ok(cmd, `expected a ${name}() command in the vocabulary`);
  return cmd.run;
}

/** Run `fn` with globalThis.fetch replaced, restoring it afterwards. */
async function withFetch(fetchImpl, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try { return await fn(); } finally { globalThis.fetch = original; }
}

const jsonResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

// ── the account ────────────────────────────────────────────────────────────

test("whoami() in dry-run stays off the network", async () => {
  const ctx = createCtx();
  const me = await withFetch(
    () => { throw new Error("whoami() must not fetch under --dry-run"); },
    () => verb("whoami")(ctx)
  );

  assert.equal(me.status, "dry_run");
  assert.equal(me.verified, false);
  assert.match(ctx.lines.join("\n"), /would check app\.moshcode\.sh/);
});

test("whoami() hands the verified account back as a value, not printed text", async () => {
  saveCreds({ api: "https://app.moshcode.test", token: "tok", email: "me@example.test", id: "u_1" });
  const ctx = createCtx({ dryRun: false });

  const me = await withFetch(
    async () => jsonResponse(200, { id: "u_1", email: "me@example.test", name: "Mosher", credits: 42 }),
    () => verb("whoami")(ctx)
  );

  // The whole reason this verb is local rather than a cliVerb: a script can
  // branch on the account instead of re-parsing stdout.
  assert.equal(me.verified, true);
  assert.equal(me.user.email, "me@example.test");
  assert.equal(me.user.credits, 42);
});

test("whoami() reports an expired session rather than inventing an account", async () => {
  saveCreds({ api: "https://app.moshcode.test", token: "stale", email: "me@example.test" });
  const me = await withFetch(
    async () => jsonResponse(401, { error: "unauthorized" }),
    () => verb("whoami")(createCtx({ dryRun: false }))
  );

  assert.equal(me.status, "expired");
  assert.equal(me.verified, false);
});

test("login() is a no-op when the account is already verified", async () => {
  saveCreds({ api: "https://app.moshcode.test", token: "tok", email: "me@example.test" });
  const ctx = createCtx({ dryRun: false });

  const r = await withFetch(
    async () => jsonResponse(200, { email: "me@example.test", credits: 7 }),
    () => verb("login")(ctx)
  );

  // `already` is the proof no flow ran: the verified branch returns before
  // loginAuto, so re-running a script cannot throw a browser tab at someone
  // who is already signed in.
  assert.deepEqual(r, { ok: true, email: "me@example.test", already: true });
  assert.match(ctx.lines.join("\n"), /already signed in/);
});

test("login() returns the failure instead of throwing (R8)", async () => {
  saveCreds({ api: "https://app.moshcode.test", token: "stale" });
  const ctx = createCtx({ dryRun: false });

  const r = await withFetch(
    async (url) => {
      if (String(url).endsWith("/api/me")) return jsonResponse(401, { error: "unauthorized" });
      throw new Error("network down");
    },
    () => verb("login")(ctx)
  );

  assert.equal(r.ok, false);
  assert.equal(r.already, false);
  assert.match(r.error, /network down/);
});

test("requireLogin() throws when it cannot authenticate", async () => {
  saveCreds({ api: "https://app.moshcode.test", token: "stale" });

  await withFetch(
    async (url) => {
      if (String(url).endsWith("/api/me")) return jsonResponse(401, { error: "unauthorized" });
      throw new Error("network down");
    },
    () => assert.rejects(
      () => verb("requireLogin")(createCtx({ dryRun: false })),
      /requireLogin\(\) could not authenticate/
    )
  );
});

test("requireLogin() returns the verified user for the script to use", async () => {
  saveCreds({ api: "https://app.moshcode.test", token: "tok", email: "me@example.test", id: "u_1" });

  const user = await withFetch(
    async () => jsonResponse(200, { id: "u_1", email: "me@example.test", credits: 3 }),
    () => verb("requireLogin")(createCtx({ dryRun: false }))
  );

  assert.equal(user.email, "me@example.test");
  assert.equal(user.credits, 3);
});

// ── aliases ────────────────────────────────────────────────────────────────

test("alias() defines, reads, and lists the pit's own shortcuts", async () => {
  const ctx = createCtx({ dryRun: false });

  const set = await verb("alias")(ctx, "gs", "git status");
  assert.equal(set.ok, true);
  assert.equal(set.value, "git status");

  // Written to the same store the pit reads, so a script and the prompt share
  // one vocabulary rather than each keeping their own.
  assert.equal(getAlias("gs"), "git status");
  assert.equal(await verb("alias")(ctx, "gs"), "git status");
  assert.equal((await verb("alias")(ctx)).gs, "git status");
});

test("alias() refuses a name moshcode already owns", async () => {
  const r = await verb("alias")(createCtx({ dryRun: false }), "agents", "git status");

  assert.equal(r.ok, false);
  assert.match(r.error, /already a pit command/);
});

test("unalias() reports a name that was never defined", async () => {
  const r = await verb("unalias")(createCtx({ dryRun: false }), "nope-not-here");
  assert.equal(r.ok, false);
  assert.match(r.error, /no alias named/);
});

test("runAlias() on an undefined alias returns 127 rather than throwing", async () => {
  const r = await verb("runAlias")(createCtx({ dryRun: false }), "nope-not-here");
  assert.deepEqual(r, { ok: false, code: 127 });
});

test("runAlias() routes a pit-command alias to its CLI twin", async () => {
  const ctx = createCtx({ dryRun: false });
  await verb("alias")(ctx, "cc", "/agents claude");

  const dry = createCtx(); // dryRun: true — narrate the argv, spawn nothing
  const r = await verb("runAlias")(dry, "cc");

  assert.equal(r.ok, true);
  assert.match(dry.lines.join("\n"), /would run: moshcode agents claude/);
});

test("runAlias() appends the script's arguments, shell-alias style", async () => {
  const ctx = createCtx({ dryRun: false });
  await verb("alias")(ctx, "gs2", "git status");

  const dry = createCtx();
  await verb("runAlias")(dry, "gs2", "--short");

  // Appended, not substituted: `/gs2 --short` is `git status --short`.
  assert.match(dry.lines.join("\n"), /git status --short/);
});

// ── reading the tools ──────────────────────────────────────────────────────

test("stocksRead() rejects an unusable query before touching the network", async () => {
  await assert.rejects(
    async () => verb("stocksRead")(createCtx({ dryRun: false }), "report", "--limit", "nope"),
    /stocksRead\(\)/
  );
});

test("stocksRead() and cryptoRead() stay off the network under --dry-run", async () => {
  await withFetch(
    () => { throw new Error("*Read() must not fetch under --dry-run"); },
    async () => {
      assert.equal(await verb("stocksRead")(createCtx(), "report", "NVDA"), null);
      assert.equal(await verb("cryptoRead")(createCtx(), "quote", "BTC/USD"), null);
      assert.deepEqual(await verb("newsRead")(createCtx()), []);
    }
  );
});

test("newsRead() rejects a feed list that does not exist", async () => {
  await assert.rejects(
    async () => verb("newsRead")(createCtx({ dryRun: false }), { list: "not-a-real-list" }),
    /no feed list named/
  );
});

// ── the help contract ──────────────────────────────────────────────────────

test("every verb documents its call signature for `moshcode help <verb>`", () => {
  for (const cmd of moshVocabulary().all()) {
    assert.equal(typeof cmd.usage, "string", `${cmd.name}() needs a usage line`);
    assert.ok(cmd.usage.length > 0, `${cmd.name}() needs a usage line`);
    assert.equal(typeof cmd.detail, "string", `${cmd.name}() needs a detail line`);
    assert.ok(cmd.detail.length > 0, `${cmd.name}() needs a detail line`);
  }
});

test("the blocking verbs say so, so scripts know to await them", () => {
  const vocab = moshVocabulary();
  for (const name of ["ask", "herdWait", "whoami", "login", "requireLogin", "stocksRead", "cryptoRead", "newsRead"]) {
    assert.match(vocab.get(name).detail, /needs await/, `${name}() must tell scripts to await it`);
  }
});
