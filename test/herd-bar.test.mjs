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
  editLine, ensureBar, helpLines, paneRoles, removeBar, renderPrompt, resolveCommand, sweepBars,
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

/* ------------------------------------------------------- keeping it tidy */

/** A tmux stand-in that answers each subcommand from a script. */
const fakeTmux = (answers) => {
  const calls = [];
  const runner = (_cmd, args) => {
    const verb = args[2]; // after -L <socket>
    calls.push(args.slice(2));
    const answer = answers[verb];
    const stdout = typeof answer === "function" ? answer(args) : (answer ?? "");
    return { status: 0, stdout, stderr: "" };
  };
  return { runner, calls };
};

test("sweepBars leaves alone any session someone is attached to", () => {
  // A bar belongs to whoever is looking at it. Reaping one out from under
  // another terminal would take away the only way out that terminal has.
  const { runner, calls } = fakeTmux({
    "list-panes": (args) => (args.includes("-a")
      ? [
        `watched\t0\tapi\t1`,
        `watched\t0\t${BAR_TITLE}\t1`,
        `idle\t0\tweb\t0`,
        `idle\t0\t${BAR_TITLE}\t0`,
      ].join("\n")
      : [`%1\tweb`, `%2\t${BAR_TITLE}`].join("\n")),
    "kill-pane": "",
  });
  const removed = sweepBars({ runner });
  assert.equal(removed, 1, "only the unattached session's bar comes out");
  const killed = calls.filter((c) => c[0] === "kill-pane");
  assert.equal(killed.length, 1);
});

test("sweepBars skips the workspace, whose bar is permanent", () => {
  const { runner } = fakeTmux({
    "list-panes": (args) => (args.includes("-a")
      ? [`herd\t0\tapi\t0`, `herd\t0\t${BAR_TITLE}\t0`].join("\n")
      : ""),
  });
  assert.equal(sweepBars({ runner, except: "herd" }), 0);
});

test("a window that is only a bar is left as it is", () => {
  // Nothing to give the pane back to: killing the last pane would take the
  // session, and sweeping is meant to be a tidy-up, not a kill.
  const { runner } = fakeTmux({
    "list-panes": (args) => (args.includes("-a")
      ? [`stale\t0\t${BAR_TITLE}\t0`].join("\n")
      : `%9\t${BAR_TITLE}`),
  });
  assert.equal(sweepBars({ runner }), 0);
});

test("removeBar refuses to empty a window", () => {
  const { runner, calls } = fakeTmux({ "list-panes": `%9\t${BAR_TITLE}`, "kill-pane": "" });
  assert.equal(removeBar("solo:0", { runner }), false);
  assert.equal(calls.filter((c) => c[0] === "kill-pane").length, 0);
});

test("ensureBar does not add a second bar", () => {
  const { runner, calls } = fakeTmux({ "list-panes": `%1\tapi\n%2\t${BAR_TITLE}` });
  const result = ensureBar("api:0", { runner, command: "true" });
  assert.deepEqual(result, { paneId: "%2", created: false });
  assert.equal(calls.filter((c) => c[0] === "split-window").length, 0, "it must not split again");
});

test("a bar under an attached member goes on and comes off cleanly", (t) => {
  if (!hasTmux) { t.skip("no tmux on this machine"); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moshcode-bar-test-"));
  const socket = `moshcode-barlive-${process.pid}`;
  const env = { ...process.env, MOSHCODE_HERD_DIR: dir, MOSHCODE_HERD_SOCKET: socket, MOSHCODE_HERD: "tmux" };

  try {
    const script = `
      const herd = await import(${JSON.stringify(path.join(ROOT, "src", "herd.mjs"))});
      const bar  = await import(${JSON.stringify(path.join(ROOT, "src", "herd-bar.mjs"))});

      for (const n of ["api", "web"]) {
        herd.startSession({ name: n, engine: "test", bin: "sh",
          args: ["-c", "echo MARK-" + n + "; while read x; do :; done"], cwd: process.cwd() });
      }
      await new Promise((r) => setTimeout(r, 900));

      const at = (n) => { const f = herd.paneIndex({}).get(n); return f && f.session + ":" + f.windowId; };
      const heightOf = (n) => herd.tmux(["list-panes", "-t", at(n), "-F", "#{pane_title}:#{pane_height}"]).stdout
        .trim().split("\\n").find((l) => l.startsWith(n + ":"));

      const before = heightOf("api");
      bar.ensureBar(at("api"), { command: "sh -c 'while read x; do :; done'" });
      const withBar = herd.tmux(["list-panes", "-t", at("api"), "-F", "#{pane_title}"]).stdout.trim().split("\\n");
      const twice = bar.ensureBar(at("api"), { command: "sh -c 'while read x; do :; done'" });

      // the member is untouched by the pane arriving beside it
      const stillThere = herd.capture("api", { lines: 20 }).includes("MARK-api");

      bar.removeBar(at("api"), {});
      const after = heightOf("api");

      // and with a bar still up, killing the member must not leave the session
      bar.ensureBar(at("web"), { command: "sh -c 'while read x; do :; done'" });
      herd.killSession("web");
      await new Promise((r) => setTimeout(r, 300));
      const sessions = herd.tmux(["list-sessions", "-F", "#{session_name}"]).stdout.trim().split("\\n").filter(Boolean);

      console.log(JSON.stringify({ before, withBar, twiceCreated: twice.created, stillThere, after, sessions }));
    `;
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env, encoding: "utf8", cwd: ROOT });
    assert.equal(run.status, 0, `bar round trip crashed: ${run.stderr}`);
    const out = JSON.parse(run.stdout.trim().split("\n").pop());

    assert.ok(out.withBar.includes(BAR_TITLE), "the bar must actually arrive");
    assert.equal(out.twiceCreated, false, "a second attach must reuse the bar, not stack another");
    assert.equal(out.stillThere, true, "the member keeps its scrollback while the bar is up");
    // The member gives up a row for the bar and gets it back afterwards; if it
    // does not, every attach shrinks the session a little more.
    assert.equal(out.after, out.before, `member did not get its height back: ${out.before} → ${out.after}`);
    // The orphan: a session outliving the member it was named for.
    assert.ok(!out.sessions.includes("web"), `killing a member with a bar left ${JSON.stringify(out.sessions)}`);
    assert.ok(out.sessions.includes("api"), "the other member must be untouched");
  } finally {
    spawnSync("tmux", ["-L", socket, "kill-server"], { encoding: "utf8" });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the bar stays one row when the window is resized under it", (t) => {
  if (!hasTmux) { t.skip("no tmux on this machine"); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moshcode-barsize-test-"));
  const socket = `moshcode-barsize-${process.pid}`;
  const env = { ...process.env, MOSHCODE_HERD_DIR: dir, MOSHCODE_HERD_SOCKET: socket, MOSHCODE_HERD: "tmux" };

  try {
    const script = `
      const herd = await import(${JSON.stringify(path.join(ROOT, "src", "herd.mjs"))});
      const bar  = await import(${JSON.stringify(path.join(ROOT, "src", "herd-bar.mjs"))});
      const cli  = ${JSON.stringify(path.join(ROOT, "bin", "moshcode.mjs"))};

      herd.startSession({ name: "api", engine: "test", bin: "sh",
        args: ["-c", "while read x; do :; done"], cwd: process.cwd() });
      await new Promise((r) => setTimeout(r, 800));

      const f = herd.paneIndex({}).get("api");
      const at = f.session + ":" + f.windowId;
      herd.tmux(["resize-window", "-t", at, "-x", "80", "-y", "24"]);
      bar.ensureBar(at, { command: process.execPath + " " + cli + " herd bar" });
      await new Promise((r) => setTimeout(r, 2000));
      const small = herd.tmux(["list-panes", "-t", at, "-F", "#{pane_title}:#{pane_height}"]).stdout.trim();

      // the resize that used to stretch it
      herd.tmux(["resize-window", "-t", at, "-x", "120", "-y", "48"]);
      await new Promise((r) => setTimeout(r, 2000));
      const big = herd.tmux(["list-panes", "-t", at, "-F", "#{pane_title}:#{pane_height}"]).stdout.trim();
      const shown = herd.tmux(["capture-pane", "-p", "-t",
        bar.paneRoles(at, {}).bar.paneId]).stdout.trim();

      console.log(JSON.stringify({ small, big, shown }));
    `;
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env, encoding: "utf8", cwd: ROOT });
    assert.equal(run.status, 0, `bar resize check crashed: ${run.stderr}`);
    const out = JSON.parse(run.stdout.trim().split("\n").pop());

    const height = (state) => state.split("\n").find((l) => l.startsWith(`${BAR_TITLE}:`))?.split(":")[1];
    assert.equal(height(out.small), "1", `bar was not one row to begin with: ${out.small}`);
    // tmux scales panes proportionally on resize, which stretched the bar to
    // three rows the first time a client attached at a different size.
    assert.equal(height(out.big), "1", `bar stretched on resize: ${out.big}`);
    assert.match(out.shown, /mosh/, "and it must still be drawing the prompt afterwards");
  } finally {
    spawnSync("tmux", ["-L", socket, "kill-server"], { encoding: "utf8" });
    fs.rmSync(dir, { recursive: true, force: true });
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
