// `moshcode export users [--clean]`: the argument grammar, the CSV it writes,
// and the --clean plumbing through a stub `email-cleaner` on PATH.
//
// The stub stands in for cli-tools' real one with the agreed interface:
// `email-cleaner - --format json --report [flags]`, CSV on stdin, JSON out.
// It also writes down the argv and stdin it got, so the tests can assert what
// moshcode handed over, not just what came back.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  exportCommand, parseExportArgs, matchCleaned, toCsv, rejectedPath, backupBeside,
} from "../src/export-users.mjs";

const BIN = fileURLToPath(new URL("../bin/moshcode.mjs", import.meta.url));

const ROWS = [
  { email: "ann@example.com", display_name: "Ann", created_at: "2026-01-01T00:00:00.000Z", id: "u1", signup_method: "password" },
  { email: "admin@example.com", display_name: "Role, Inc", created_at: "2026-01-02T00:00:00.000Z", id: "u2", signup_method: "password" },
  { email: "bob@gmial.com", display_name: "Bob", created_at: "2026-01-03T00:00:00.000Z", id: "u3", signup_method: "passkey" },
  { email: "tmp@mailinator.com", display_name: "=HYPERLINK()", created_at: "2026-01-04T00:00:00.000Z", id: "u4", signup_method: "coinpay" },
];
const COUNTS = {
  total: 6, with_email: 4, without_email: 2,
  without_email_by_method: { total: 2, password: 0, passkey: 1, coinpay: 1, unknown: 0 },
};

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "moshcode-export-test-"));

/**
 * A stub email-cleaner in its own directory. Keeps ann; rejects admin@ as a
 * role address and mailinator as disposable; bob@gmial.com is valid only when
 * --fix-typos is passed, and then comes back corrected, matched by `row`.
 */
function stubCleaner() {
  const dir = tmp();
  const log = path.join(dir, "calls.json");
  const script = `#!${process.execPath}
const fs = require("node:fs");
let input = "";
process.stdin.on("data", (c) => { input += c; });
process.stdin.on("end", () => {
  const args = process.argv.slice(2);
  fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({ args, input }));
  const lines = input.trim().split("\\n").slice(1);
  const valid = [], invalid = [];
  lines.forEach((line, i) => {
    const email = line.split(",")[0];
    if (email.startsWith("admin@")) invalid.push({ input: email, email, reasons: ["role"] });
    else if (email.endsWith("@mailinator.com")) invalid.push({ input: email, email, reasons: ["disposable", "unlikely"] });
    else if (email.endsWith("@gmial.com")) {
      if (args.includes("--fix-typos")) valid.push({ input: line, email: email.replace("gmial", "gmail"), row: i + 1 });
      else invalid.push({ input: email, email, reasons: ["typo"], suggestion: email.replace("gmial", "gmail") });
    } else valid.push({ input: email, email, name: "x" });
  });
  process.stdout.write(JSON.stringify({ valid, invalid, stats: { total: lines.length } }));
});
`;
  const bin = path.join(dir, "email-cleaner");
  fs.writeFileSync(bin, script, { mode: 0o755 });
  return { dir, calls: () => JSON.parse(fs.readFileSync(log, "utf8")) };
}

const okFetch = (seen = []) => async (url, init) => {
  seen.push({ url, init });
  return { ok: true, status: 200, json: async () => ({ columns: [], users: ROWS, counts: COUNTS }) };
};

function harness(overrides = {}) {
  const lines = [];
  let out = "";
  const seen = [];
  const home = overrides.home || tmp();
  const opts = {
    creds: { token: "mck_test", api: "https://app.example" },
    fetchImpl: okFetch(seen),
    env: { PATH: "" },
    write: (l) => lines.push(l),
    stdout: (t) => { out += t; },
    home,
    cwd: home,
    now: new Date("2026-09-24T10:11:12.345Z"),
    ...overrides,
  };
  return { opts, lines, seen, home, out: () => out };
}

/* ------------------------------------------------------------------ grammar */

test("parseExportArgs: users, --clean, --format, -o, and cleaner flags only after --clean", () => {
  assert.deepEqual(
    (({ subject, clean, format, output, cleanerFlags }) => ({ subject, clean, format, output, cleanerFlags }))(
      parseExportArgs(["users", "--clean", "--no-dns", "--fix-typos", "--format", "json", "-o", "u.json"])),
    { subject: "users", clean: true, format: "json", output: "u.json", cleanerFlags: ["--no-dns", "--fix-typos"] },
  );
  assert.equal(parseExportArgs(["users", "--output=x.csv"]).output, "x.csv");
  assert.match(parseExportArgs([]).error, /usage: export users/);
  assert.match(parseExportArgs(["names"]).error, /only users/);
  assert.match(parseExportArgs(["users", "--no-dns"]).error, /after --clean/);
  assert.match(parseExportArgs(["users", "--format", "xml"]).error, /csv or json/);
  assert.match(parseExportArgs(["users", "-o"]).error, /needs a file name/);
  assert.match(parseExportArgs(["users", "--bogus"]).error, /unknown option --bogus/);
});

test("toCsv quotes commas and neutralises formula-looking names", () => {
  const csv = toCsv(ROWS);
  const lines = csv.trimEnd().split("\n");
  assert.equal(lines[0], "email,display_name,created_at,id,signup_method");
  assert.equal(lines[2], 'admin@example.com,"Role, Inc",2026-01-02T00:00:00.000Z,u2,password');
  assert.equal(lines[4], "tmp@mailinator.com,'=HYPERLINK(),2026-01-04T00:00:00.000Z,u4,coinpay");
  assert.equal(rejectedPath("/x/users.csv"), "/x/users.rejected.csv");
  assert.equal(rejectedPath("/x/users"), "/x/users.rejected.csv");
});

/* ----------------------------------------------------------------- plumbing */

test("--clean without email-cleaner on PATH fails, says to install cli-tools, and fetches nothing", async () => {
  const h = harness();
  const code = await exportCommand(["users", "--clean"], h.opts);
  assert.equal(code, 1);
  assert.equal(h.lines.length, 1, "one line");
  assert.match(h.lines[0], /email-cleaner/);
  assert.match(h.lines[0], /cli-tools/);
  assert.equal(h.seen.length, 0, "no request went out");
  assert.equal(h.out(), "");
});

test("--clean pipes the CSV through email-cleaner and splits kept from rejected", async () => {
  const cleaner = stubCleaner();
  const h = harness({ env: { PATH: cleaner.dir } });
  const code = await exportCommand(["users", "--clean", "--no-dns", "-o", "users.csv"], h.opts);
  assert.equal(code, 0, h.lines.join("\n"));

  // What moshcode handed the cleaner.
  const call = cleaner.calls();
  assert.deepEqual(call.args, ["-", "--format", "json", "--report", "--no-dns"]);
  assert.equal(call.input, toCsv(ROWS));
  assert.equal(h.seen[0].url, "https://app.example/api/admin/users/export?format=json");
  assert.equal(h.seen[0].init.headers.authorization, "Bearer mck_test");

  const file = path.join(h.home, "users.csv");
  const kept = fs.readFileSync(file, "utf8");
  assert.equal(kept, toCsv([ROWS[0]]), "same columns, only the valid rows");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  const rejectedFile = path.join(h.home, "users.rejected.csv");
  const rejected = fs.readFileSync(rejectedFile, "utf8").trimEnd().split("\n");
  assert.equal(rejected[0], "email,display_name,created_at,id,signup_method,reasons,suggestion");
  assert.equal(rejected.length, 4);
  assert.ok(rejected.includes('admin@example.com,"Role, Inc",2026-01-02T00:00:00.000Z,u2,password,role,'));
  assert.ok(rejected.includes("bob@gmial.com,Bob,2026-01-03T00:00:00.000Z,u3,passkey,typo,bob@gmail.com"));
  assert.ok(rejected.includes("tmp@mailinator.com,'=HYPERLINK(),2026-01-04T00:00:00.000Z,u4,coinpay,disposable;unlikely,"));
  assert.equal(fs.statSync(rejectedFile).mode & 0o777, 0o600);

  const summary = h.lines.join("\n");
  assert.match(summary, /exported 4 users with an email \(2 without one: 1 passkey, 1 coinpay; 6 accounts in all\)/);
  assert.match(summary, /cleaned: total 4, kept 1, rejected 3 \(/);
  for (const reason of ["role 1", "disposable 1", "unlikely 1", "typo 1"]) assert.ok(summary.includes(reason), reason);
  assert.ok(!/[\w.]+@[\w.]+/.test(summary.replace(/\S*\/\S*/g, "")), "the summary names no address");
  assert.equal(h.out(), "", "nothing on stdout when writing a file");
});

test("--fix-typos is passed through and the corrected address replaces the typo", async () => {
  const cleaner = stubCleaner();
  const h = harness({ env: { PATH: cleaner.dir } });
  const code = await exportCommand(["users", "--clean", "--fix-typos"], h.opts);
  assert.equal(code, 0, h.lines.join("\n"));
  assert.ok(cleaner.calls().args.includes("--fix-typos"));
  const lines = h.out().trimEnd().split("\n");
  assert.deepEqual(lines, [
    "email,display_name,created_at,id,signup_method",
    "ann@example.com,Ann,2026-01-01T00:00:00.000Z,u1,password",
    "bob@gmail.com,Bob,2026-01-03T00:00:00.000Z,u3,passkey",
  ]);
  assert.equal(fs.existsSync(path.join(h.home, "users.rejected.csv")), false, "no -o, no rejected file");
});

test("the pit writes to ~/.moshcode/exports and never prints an address", async () => {
  const cleaner = stubCleaner();
  const h = harness({ env: { PATH: cleaner.dir }, pit: true });
  const code = await exportCommand(["users", "--clean"], h.opts);
  assert.equal(code, 0);
  const file = path.join(h.home, ".moshcode", "exports", "users-2026-09-24-101112.csv");
  assert.ok(fs.existsSync(file));
  assert.ok(fs.existsSync(path.join(h.home, ".moshcode", "exports", "users-2026-09-24-101112.rejected.csv")));
  assert.equal(h.out(), "");
  const shown = h.lines.join("\n");
  assert.ok(shown.includes(file));
  for (const r of ROWS) assert.ok(!shown.includes(r.email), `the pit showed ${r.email}`);
});

test("plain export: CSV on stdout, JSON on request, and an existing file is backed up", async () => {
  const h = harness();
  assert.equal(await exportCommand(["users"], h.opts), 0);
  assert.equal(h.out(), toCsv(ROWS));

  const j = harness();
  assert.equal(await exportCommand(["users", "--format", "json"], j.opts), 0);
  const body = JSON.parse(j.out());
  assert.equal(body.users.length, 4);
  assert.deepEqual(body.counts, COUNTS);

  const b = harness();
  const file = path.join(b.home, "users.csv");
  fs.writeFileSync(file, "old\n");
  assert.equal(await exportCommand(["users", "-o", "users.csv"], b.opts), 0);
  assert.equal(fs.readFileSync(path.join(b.home, "users.bak-001.csv"), "utf8"), "old\n");
  assert.equal(fs.readFileSync(file, "utf8"), toCsv(ROWS));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, "chmod applies to a file that already existed");
  assert.equal(backupBeside(file), path.join(b.home, "users.bak-002.csv"), "numbers are never reused");
});

test("a non-operator gets the app's refusal, and a logged-out machine is told to log in", async () => {
  const h = harness({ fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({}) }) });
  assert.equal(await exportCommand(["users"], h.opts), 1);
  assert.match(h.lines[0], /not an operator/);
  assert.equal(h.out(), "");

  const n = harness({ creds: null });
  assert.equal(await exportCommand(["users"], n.opts), 1);
  assert.match(n.lines[0], /not logged in/);
});

test("matchCleaned keeps a verdict it cannot place instead of dropping it", () => {
  const r = matchCleaned(ROWS.slice(0, 1), { valid: [{ input: "zed@x.io", email: "zed@x.io" }], invalid: [] });
  assert.equal(r.kept.length, 1);
  assert.equal(r.kept[0].email, "zed@x.io");
  assert.equal(r.unaccounted, 1, "ann got no verdict");
});

test("end to end through the real binary: login creds, the app, a stub cleaner", async () => {
  const cleaner = stubCleaner();
  const home = tmp();
  let auth = null;
  const server = http.createServer((req, res) => {
    auth = req.headers.authorization;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ users: ROWS, counts: COUNTS }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const api = `http://127.0.0.1:${server.address().port}`;
    fs.mkdirSync(path.join(home, ".moshcode"), { recursive: true });
    fs.writeFileSync(path.join(home, ".moshcode", "credentials.json"), JSON.stringify({ api, token: "mck_e2e" }));
    // Async on purpose: a spawnSync would block this process's event loop, and
    // with it the fake app the child is trying to reach.
    const run = await new Promise((resolve) => {
      execFile(process.execPath, [BIN, "export", "users", "--clean", "--allow-role", "-o", "out.csv"], {
        cwd: home, encoding: "utf8", timeout: 30000,
        env: { HOME: home, PATH: cleaner.dir, MOSHCODE_NO_AUTOSYNC: "1", MOSHCODE_API: api },
      }, (error, stdout, stderr) => resolve({ status: error ? (error.code ?? 1) : 0, stdout, stderr }));
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(auth, "Bearer mck_e2e");
    assert.deepEqual(cleaner.calls().args, ["-", "--format", "json", "--report", "--allow-role"]);
    assert.ok(fs.existsSync(path.join(home, "out.csv")));
    assert.ok(fs.existsSync(path.join(home, "out.rejected.csv")));
    assert.equal(run.stdout, "");
    assert.match(run.stderr, /cleaned: total 4/);
  } finally {
    server.close();
  }
});
