// The one-line mosh prompt under the session: the line editor, what a typed
// line means, and the geometry it has to keep.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  BAR_HEIGHT, BAR_KEY, BAR_TITLE, HINT, SIDEBAR_TITLE,
  editLine, helpLines, paneRoles, renderPrompt, resolveCommand,
} from "../src/herd-bar.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const hasTmux = (() => {
  try { return spawnSync("tmux", ["-V"], { encoding: "utf8" }).status === 0; }
  catch { return false; }
})();
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

/* --------------------------------------------------------------- the editor */

test("typing accumulates and backspace removes", () => {
  let line = "";
  for (const key of "psx") line = editLine(line, key).line;
  assert.equal(line, "psx");
  assert.equal(editLine(line, "\x7f").line, "ps");
});

test("enter submits, escape abandons the line", () => {
  assert.deepEqual(editLine("ps", "\r"), { line: "ps", action: "submit" });
  const escaped = editLine("half typed", "\x1b");
  assert.equal(escaped.action, "escape");
  assert.equal(escaped.line, "", "escape leaves nothing behind to be submitted later");
});

test("Ctrl-C clears rather than killing the bar", () => {
  // The bar is the way out of a stuck session. If Ctrl-C ended it, the reflex
  // that people reach for first would remove the escape hatch.
  const hit = editLine("kill api", "\x03");
  assert.equal(hit.action, "escape");
  assert.equal(hit.line, "");
});

test("Ctrl-U clears the line and Ctrl-W drops the last word", () => {
  assert.equal(editLine("start claude", "\x15").line, "");
  assert.equal(editLine("start claude", "\x17").line, "start ");
});

test("control bytes are never inserted as text", () => {
  // A stray escape sequence from a resize would otherwise end up in the line
  // and be submitted as a command.
  for (const key of ["\x1b[A", "\x00", "\x1f"]) {
    assert.equal(editLine("ps", key).line, "ps", `${JSON.stringify(key)} leaked into the line`);
  }
});

/* -------------------------------------------------------------- the meaning */

test("attach means show, because a nested client is not a thing", () => {
  // Running the real attach from inside the workspace would ask tmux to start a
  // client inside the client already drawing this pane, which it refuses. In a
  // workspace the word means "put it in the content pane".
  for (const verb of ["attach", "show", "fg"]) {
    assert.deepEqual(resolveCommand(`${verb} api`), { kind: "show", argv: ["api"] });
  }
});

test("detach, exit and quit all leave without killing anything", () => {
  for (const verb of ["detach", "exit", "quit"]) {
    assert.equal(resolveCommand(verb).kind, "detach");
  }
});

test("anything else is passed through to the herd CLI verbatim", () => {
  assert.deepEqual(resolveCommand("  start claude --agent "), {
    kind: "herd", argv: ["start", "claude", "--agent"],
  });
  assert.equal(resolveCommand("ps").kind, "herd");
});

test("an empty line is not a command", () => {
  assert.equal(resolveCommand("").kind, "empty");
  assert.equal(resolveCommand("   ").kind, "empty");
});

/* --------------------------------------------------------------- the prompt */

test("at rest the prompt shows the way out", () => {
  // This is the whole point: the bar is the only thing on screen that is always
  // visible, so the hint has to be on it when nothing is typed.
  const rendered = strip(renderPrompt("", { cols: 80 }));
  assert.match(rendered, /mosh/);
  assert.ok(rendered.includes("detach"), `no way out offered: ${rendered}`);
});

test("the hint gives way to what is being typed", () => {
  const rendered = strip(renderPrompt("start claude", { cols: 80 }));
  assert.match(rendered, /start claude$/);
  assert.ok(!rendered.includes(HINT), "the hint must not fight the input for the row");
});

test("the prompt stays on one line at narrow widths", () => {
  // It is a one-row pane. A prompt wider than the pane wraps, scrolls itself
  // off, and the row goes blank.
  for (const cols of [24, 40, 80]) {
    const rendered = strip(renderPrompt("", { cols }));
    assert.ok(rendered.length <= cols, `${rendered.length} chars in ${cols} columns`);
  }
});

test("help names the key that gets you back here", () => {
  assert.ok(helpLines().some((l) => l.includes(BAR_KEY)), "help must name the jump key");
});

/* ----------------------------------------------------------------- geometry */

test("the sidebar and the bar are told apart by title, not position", (t) => {
  if (!hasTmux) { t.skip("no tmux on this machine"); return; }
  const socket = `moshcode-bartest-${process.pid}`;
  const T = (...args) => spawnSync("tmux", ["-L", socket, ...args], { encoding: "utf8" });
  try {
    T("-f", "/dev/null", "new-session", "-d", "-s", "herd", "-n", "ui", "sh -c 'while read x; do :; done'");
    T("select-pane", "-t", "herd:ui.0", "-T", SIDEBAR_TITLE);
    T("split-window", "-t", "herd:ui", "-f", "-v", "-l", String(BAR_HEIGHT), "sh -c 'while read x; do :; done'");
    const bar = T("list-panes", "-t", "herd:ui", "-F", "#{pane_id}").stdout.trim().split("\n")[1];
    T("select-pane", "-t", bar, "-T", BAR_TITLE);

    const env = { ...process.env, MOSHCODE_HERD_SOCKET: socket };
    const script = `
      const bar = await import(${JSON.stringify(path.join(ROOT, "src", "herd-bar.mjs"))});
      console.log(JSON.stringify(bar.paneRoles("herd:ui", {})));
    `;
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env, encoding: "utf8", cwd: ROOT });
    assert.equal(run.status, 0, run.stderr);
    const roles = JSON.parse(run.stdout.trim().split("\n").pop());
    assert.equal(roles.sidebar?.title, SIDEBAR_TITLE);
    assert.equal(roles.bar?.title, BAR_TITLE);
    assert.equal(roles.content, null, "with no member on screen there is no content pane");
  } finally {
    spawnSync("tmux", ["-L", socket, "kill-server"], { encoding: "utf8" });
  }
});

test("paneRoles is a function of titles alone", () => {
  // No tmux needed: a fake runner proves the classification rather than the
  // plumbing, so the rule stays pinned on machines that skip the live test.
  const runner = () => ({
    status: 0,
    stdout: [`%1\t${SIDEBAR_TITLE}`, "%2\tapi", `%3\t${BAR_TITLE}`].join("\n"),
    stderr: "",
  });
  const roles = paneRoles("herd:ui", { runner });
  assert.equal(roles.sidebar.paneId, "%1");
  assert.equal(roles.content.paneId, "%2");
  assert.equal(roles.bar.paneId, "%3");
});
