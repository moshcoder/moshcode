// `/shorten` at the prompt — what it parses, what it sends, and what it says
// back.
//
// fetch is injected throughout, so these are about the command rather than the
// registry: that a bare URL needs no verb, that the token goes on the wire, and
// that a 401 becomes "run /login" instead of a stack trace over a thing the
// person at the prompt can fix in one line.
import assert from "node:assert/strict";
import test from "node:test";

import { apiToken, parseArgs, shortenCommand } from "../src/shorten.mjs";

const ENV = { MOSHCODE_API_KEY: "mck_test" };

/** A fetch stub that records the call and answers with `reply`. */
function stub(reply, { status = 200 } = {}) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => reply,
    };
  };
  return { impl, calls };
}

// `token` is passed explicitly rather than left to apiToken(): this suite runs
// on machines that are logged in, and letting the command read the real
// ~/.moshcode/credentials.json would make "not logged in" pass or fail
// depending on whose laptop it is.
const run = async (argv, fetchImpl, { env = ENV, token = env.MOSHCODE_API_KEY ?? "" } = {}) => {
  const out = [];
  const errs = [];
  const code = await shortenCommand(argv, {
    out: (s) => out.push(String(s)),
    err: (s) => errs.push(String(s)),
    env,
    token,
    fetchImpl,
  });
  return { code, out: out.join("\n"), err: errs.join("\n") };
};

test("shorten: a bare url needs no verb", () => {
  assert.deepEqual(parseArgs(["https://example.com/x"]),
    { verb: "shorten", url: "https://example.com/x", json: false, name: null });
  assert.equal(parseArgs(["list"]).verb, "list");
  assert.equal(parseArgs(["ls"]).verb, "list");
  assert.deepEqual(parseArgs(["rm", "k7mq2xd"]), { verb: "rm", code: "k7mq2xd", json: false, name: null });
  assert.equal(parseArgs([]).verb, "help");
});

test("shorten: --name and --json are read from anywhere in the line", () => {
  assert.deepEqual(parseArgs(["--name", "blue.eggs", "https://example.com/x", "--json"]),
    { verb: "shorten", url: "https://example.com/x", json: true, name: "blue.eggs" });
  assert.equal(parseArgs(["https://example.com/x", "--name=blue.eggs"]).name, "blue.eggs");
  // The flag must not be mistaken for the URL.
  assert.equal(parseArgs(["--name", "blue.eggs", "https://example.com/x"]).url, "https://example.com/x");
});

test("shorten: the token goes on the wire and the short link comes back", async () => {
  const { impl, calls } = stub(
    { code: "k7mq2xd", url: "https://example.com/x", short: "https://pit.moshcode.sh/f/k7mq2xd", created: true },
    { status: 201 },
  );

  const result = await run(["https://example.com/x"], impl);
  assert.equal(result.code, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://pit.moshcode.sh/api/moshpit/links");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.authorization, "Bearer mck_test");
  assert.deepEqual(calls[0].body, { url: "https://example.com/x" });
  assert.match(result.out, /pit\.moshcode\.sh\/f\/k7mq2xd/);
});

test("shorten: a name is sent only when one was asked for", async () => {
  const { impl, calls } = stub({ code: "k7mq2xd", short: "s", url: "u", created: true }, { status: 201 });
  await run(["https://example.com/x", "--name", "blue.eggs"], impl);
  assert.deepEqual(calls[0].body, { url: "https://example.com/x", name: "blue.eggs" });
});

test("shorten: an existing code says so rather than looking like a fresh mint", async () => {
  const { impl } = stub({ code: "k7mq2xd", short: "https://pit.moshcode.sh/f/k7mq2xd", url: "u", created: false });
  const result = await run(["https://example.com/x"], impl);
  assert.equal(result.code, 0);
  assert.match(result.out, /already shortened/);
});

test("shorten: --json prints the registry's answer verbatim", async () => {
  const reply = { code: "k7mq2xd", url: "https://example.com/x", short: "https://pit.moshcode.sh/f/k7mq2xd", created: true };
  const { impl } = stub(reply, { status: 201 });
  const result = await run(["https://example.com/x", "--json"], impl);
  assert.deepEqual(JSON.parse(result.out), reply);
});

test("shorten: no credentials is an instruction, not an error page", async () => {
  const { impl, calls } = stub({}, { status: 200 });
  const result = await run(["https://example.com/x"], impl, { env: {}, token: "" });
  assert.equal(result.code, 1);
  assert.equal(calls.length, 0, "nothing should reach the network without a token");
  assert.match(result.err, /login/);
});

test("shorten: a rejected token points at /login", async () => {
  const { impl } = stub({ error: "sign in first" }, { status: 401 });
  const result = await run(["https://example.com/x"], impl);
  assert.equal(result.code, 1);
  assert.match(result.err, /\/login/);
});

test("shorten: the registry's refusal is what the person sees", async () => {
  const { impl } = stub({ error: "javascript links cannot be shortened — http(s) only" }, { status: 400 });
  const result = await run(["javascript:alert(1)"], impl);
  assert.equal(result.code, 1);
  assert.match(result.err, /http\(s\) only/);
});

test("shorten: an unreachable registry says so instead of throwing", async () => {
  const impl = async () => { throw new Error("ECONNREFUSED"); };
  const result = await run(["https://example.com/x"], impl);
  assert.equal(result.code, 1);
  assert.match(result.err, /unreachable/);
});

test("shorten list: an empty account gets a nudge, not a blank screen", async () => {
  const { impl, calls } = stub({ links: [] });
  const result = await run(["list"], impl);
  assert.equal(result.code, 0);
  assert.equal(calls[0].init.method ?? "GET", "GET");
  assert.match(result.out, /no short links yet/);
});

test("shorten list: each link shows where it goes and how often it went", async () => {
  const { impl } = stub({
    links: [{ code: "k7mq2xd", short: "https://pit.moshcode.sh/f/k7mq2xd", url: "https://example.com/x", hits: 3, name: "blue.eggs" }],
  });
  const result = await run(["list"], impl);
  assert.match(result.out, /f\/k7mq2xd/);
  assert.match(result.out, /example\.com\/x/);
  assert.match(result.out, /3 hits/);
  assert.match(result.out, /blue\.eggs/);
});

test("shorten rm: deletes by code, and refuses without one", async () => {
  const { impl, calls } = stub({ code: "k7mq2xd", deleted: true });
  const result = await run(["rm", "k7mq2xd"], impl);
  assert.equal(result.code, 0);
  assert.equal(calls[0].url, "https://pit.moshcode.sh/api/moshpit/links/k7mq2xd");
  assert.equal(calls[0].init.method, "DELETE");
  assert.match(result.out, /took down \/f\/k7mq2xd/);

  const missing = await run(["rm"], impl);
  assert.equal(missing.code, 1);
  assert.match(missing.err, /usage/);
});

test("shorten: with no arguments it prints usage and fails", async () => {
  const { impl, calls } = stub({});
  const result = await run([], impl);
  assert.equal(result.code, 1);
  assert.equal(calls.length, 0);
  assert.match(result.out, /\/shorten <url>/);
});

test("shorten: usage is spelled the way the caller reached it", async () => {
  const out = [];
  await shortenCommand([], { out: (s) => out.push(String(s)), err: () => {}, token: "t" });
  assert.match(out.join("\n"), /\/shorten <url>/, "the pit writes its verbs with a slash");

  const cli = [];
  await shortenCommand([], {
    out: (s) => cli.push(String(s)), err: () => {}, token: "t", prefix: "moshcode shorten",
  });
  assert.match(cli.join("\n"), /moshcode shorten <url>/, "the CLI does not");
  assert.ok(!cli.join("\n").includes("/shorten <url>"), "a usage line has to work when pasted back");
});

test("shorten: MOSHCODE_API_KEY wins over stored credentials", () => {
  assert.equal(apiToken({ MOSHCODE_API_KEY: "from-env" }, () => ({ token: "from-disk" })), "from-env");
  assert.equal(apiToken({}, () => ({ token: "from-disk" })), "from-disk");
  assert.equal(apiToken({}, () => null), "");
});
