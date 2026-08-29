// /timer and /billing prefer the published CLIs, and fall back when absent.
//
// The behaviour worth pinning is the fallback: a machine that has not installed
// @profullstack/timer must keep working exactly as it did, because upgrading
// moshcode is not consent to lose a command.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DELEGATED, exitCodeOf, externalEnabled, externalFor, installHint } from "../src/business-delegate.mjs";
import { TOOLS } from "../src/tools.mjs";

/** A directory on PATH holding an executable of the given name. */
function fakeBin(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moshcode-bin-"));
  const win = process.platform === "win32";
  const file = path.join(dir, win ? `${name}.cmd` : name);
  fs.writeFileSync(file, win ? "@echo off\r\nexit /b 0\r\n" : "#!/bin/sh\nexit 0\n");
  if (!win) fs.chmodSync(file, 0o755);
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("both commands are published tools moshcode can install", () => {
  for (const key of ["timer", "billing"]) {
    assert.ok(TOOLS[key], `${key} is missing from TOOLS`);
    assert.equal(TOOLS[key].bin, key);
    assert.deepEqual(TOOLS[key].install.args, ["install", "-g", `@profullstack/${key}`]);
  }
});

test("/invoice delegates to the same tool as /billing", () => {
  // They are aliases in the pit, so they must not disagree about where they go.
  assert.equal(DELEGATED.invoice, "billing");
  assert.equal(DELEGATED.billing, "billing");
});

test("with the CLI absent, nothing is delegated and the built-in runs", (t) => {
  const saved = process.env.PATH;
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "moshcode-empty-"));
  process.env.PATH = empty;
  t.after(() => {
    process.env.PATH = saved;
    fs.rmSync(empty, { recursive: true, force: true });
  });
  assert.equal(externalFor("timer"), null);
  assert.equal(externalFor("billing"), null);
});

test("an installed CLI is NOT used until it is switched on", (t) => {
  // The bug this pins. Only half the business layer has an outside home:
  // /client and /rate keep writing ~/.moshcode/business.json, so delegating
  // /billing the moment the package appears on PATH splits one person's
  // records across two stores and their invoice stops existing. It also only
  // breaks on a machine that took the install, so CI stays green while every
  // developer box that installed the tools goes red.
  const savedPath = process.env.PATH;
  const savedFlag = process.env.MOSHCODE_EXTERNAL_BILLING;
  const bin = fakeBin("timer");
  process.env.PATH = bin.dir;
  delete process.env.MOSHCODE_EXTERNAL_BILLING;
  t.after(() => {
    process.env.PATH = savedPath;
    if (savedFlag === undefined) delete process.env.MOSHCODE_EXTERNAL_BILLING;
    else process.env.MOSHCODE_EXTERNAL_BILLING = savedFlag;
    bin.cleanup();
  });
  assert.equal(externalEnabled(), false);
  assert.equal(externalFor("timer"), null, "installed is not the same as chosen");
});

test("MOSHCODE_EXTERNAL_BILLING switches the delegation on", (t) => {
  const savedPath = process.env.PATH;
  const savedFlag = process.env.MOSHCODE_EXTERNAL_BILLING;
  const bin = fakeBin("timer");
  process.env.PATH = bin.dir;
  process.env.MOSHCODE_EXTERNAL_BILLING = "1";
  t.after(() => {
    process.env.PATH = savedPath;
    if (savedFlag === undefined) delete process.env.MOSHCODE_EXTERNAL_BILLING;
    else process.env.MOSHCODE_EXTERNAL_BILLING = savedFlag;
    bin.cleanup();
  });
  assert.equal(externalEnabled(), true);
  const found = externalFor("timer");
  assert.ok(found, "an installed timer should win once asked for");
  assert.equal(found.key, "timer");
});

test("switching it on cannot conjure a CLI that is not installed", (t) => {
  const savedPath = process.env.PATH;
  const savedFlag = process.env.MOSHCODE_EXTERNAL_BILLING;
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "moshcode-empty-"));
  process.env.PATH = empty;
  process.env.MOSHCODE_EXTERNAL_BILLING = "1";
  t.after(() => {
    process.env.PATH = savedPath;
    if (savedFlag === undefined) delete process.env.MOSHCODE_EXTERNAL_BILLING;
    else process.env.MOSHCODE_EXTERNAL_BILLING = savedFlag;
    fs.rmSync(empty, { recursive: true, force: true });
  });
  assert.equal(externalFor("timer"), null, "the built-in still has to run");
});

test("the tip is shown only to somebody who could act on it", (t) => {
  const savedPath = process.env.PATH;
  const savedFlag = process.env.MOSHCODE_EXTERNAL_BILLING;
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "moshcode-empty-"));
  process.env.PATH = empty;
  delete process.env.MOSHCODE_EXTERNAL_BILLING;
  t.after(() => {
    process.env.PATH = savedPath;
    if (savedFlag === undefined) delete process.env.MOSHCODE_EXTERNAL_BILLING;
    else process.env.MOSHCODE_EXTERNAL_BILLING = savedFlag;
    fs.rmSync(empty, { recursive: true, force: true });
  });
  // Not installed: nothing to say. Advertising a variable that would do
  // nothing is worse than silence.
  assert.equal(installHint("timer"), null);

  const bin = fakeBin("timer");
  process.env.PATH = bin.dir;
  t.after(bin.cleanup);
  const hint = installHint("timer");
  assert.match(hint, /MOSHCODE_EXTERNAL_BILLING/);
  assert.match(hint, /billing import/, "it has to name how the records come across");

  process.env.MOSHCODE_EXTERNAL_BILLING = "1";
  assert.equal(installHint("timer"), null, "no nagging once it is on");
});

test("a passthrough result becomes one exit code", () => {
  // openPassthrough resolves { ok, code, signal }, not a number. Assigning that
  // object straight to process.exitCode throws ERR_INVALID_ARG_TYPE *after* the
  // child has printed its output, so a run that actually succeeded ends in a
  // stack trace. That is exactly what happened the first time this was wired.
  assert.equal(exitCodeOf({ ok: true, code: 0, signal: null }), 0);
  assert.equal(exitCodeOf({ ok: false, code: 2, signal: null }), 2);
  assert.equal(exitCodeOf(3), 3, "a bare number passes through");
  // A child killed by a signal reports code: null. Calling that 0 would report
  // an interrupted invoice run as a success.
  assert.equal(exitCodeOf({ ok: false, code: null, signal: "SIGINT" }), 1);
  assert.equal(exitCodeOf({ ok: false, code: null, signal: null }), 1);
  assert.equal(exitCodeOf(undefined), 0);
});

test("a command with no external CLI is never delegated", () => {
  for (const cmd of ["team", "payments", "client", "rate", "", null]) {
    assert.equal(externalFor(cmd), null, String(cmd));
    assert.equal(installHint(cmd), null, String(cmd));
  }
});
