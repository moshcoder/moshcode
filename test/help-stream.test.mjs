// A wrong verb must not put the help banner on stdout.
//
// The failure this guards against is not cosmetic. `moshcode <verb> > file`
// against a build that predates <verb> writes the banner into `file`, and
// whatever consumes that file fails somewhere far away from the typo — an
// nginx config whose first directive is "moshcode", say, which takes the web
// server down at reload time.
//
// The assertion is on the property (nothing on stdout, non-zero exit), not on
// the wording, so rephrasing the banner does not break it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";

const run = promisify(execFile);
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "moshcode.mjs");

test("an unknown verb writes nothing to stdout and exits non-zero", async () => {
  const failed = await run(process.execPath, [CLI, "notaverb"]).then(
    (ok) => ({ code: 0, ...ok }),
    (err) => err,
  );
  assert.notEqual(failed.code, 0, "an unknown verb must not exit 0");
  assert.equal(failed.stdout, "", "stdout must stay clean so redirection is safe");
  assert.match(failed.stderr, /unknown command/, "the reason belongs on stderr");
  assert.match(failed.stderr, /usage:/, "the banner still gets shown, just not on stdout");
});

test("help asked for goes to stdout", async () => {
  const { stdout, stderr } = await run(process.execPath, [CLI, "--help"]);
  assert.match(stdout, /usage:/, "explicit help is output, not a diagnostic");
  assert.equal(stderr, "", "nothing to complain about when help was requested");
});
