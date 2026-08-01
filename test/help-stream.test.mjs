// Which stream help lands on.
//
// An unknown verb printing help to stdout is how a help banner ends up inside
// a config file: `moshcode doh --nginx x > site.conf` on a build without that
// verb writes ASCII art where nginx expected directives, and the web server
// stops parsing. That happened.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "moshcode.mjs");

const run = (args) => new Promise((resolve) => {
  execFile(process.execPath, [BIN, ...args], { timeout: 20000 }, (err, stdout, stderr) =>
    resolve({ code: err?.code ?? 0, stdout, stderr }));
});

test("an unknown verb writes nothing to stdout", async () => {
  // The property that matters: a redirect captures nothing, so the file is
  // empty rather than full of help text that the next program tries to parse.
  const { code, stdout, stderr } = await run(["deffinitelynotaverb"]);
  assert.equal(stdout, "", `stdout had ${stdout.length} bytes`);
  assert.match(stderr, /unknown command/);
  assert.notEqual(code, 0, "non-zero, so `&&` stops the chain");
});

test("help that was asked for still goes to stdout", async () => {
  // Otherwise `moshcode help | less` breaks, which is the reason help exists.
  // No-args is deliberately absent: that opens the TUI, not help.
  for (const args of [["help"], ["--help"], ["-h"]]) {
    const { code, stdout } = await run(args);
    assert.match(stdout, /moshcode — metal scripting toolkit/, args.join(" ") || "(no args)");
    assert.equal(code, 0, args.join(" ") || "(no args)");
  }
});
