// A pit spends most of its time running shell commands — `!cmd`, /shell, and
// every shell-valued /alias (`/merge` → `gh-prs-merge-all --apply`) land in
// runShell. Those spawned with `stdio: "inherit"`, so the session page at
// app.moshcode.sh/sessions/<id> showed the echoed command line and the exit
// note with nothing at all in between: not the command's stdout, and not its
// stderr, which is where a merge sweep reports what it skipped and why.
//
// These pin the capture end-to-end through a real script(1), because the parts
// were already unit-tested individually while the path that matters was not
// wired to them at all.
import assert from "node:assert/strict";
import test from "node:test";

import { captureSpec, scriptFlavor } from "../src/pty.mjs";
import { activeChildSink, createMirror, setActiveSink } from "../src/mirror.mjs";
import { runCmd } from "../src/engines.mjs";
import { runShell } from "../src/tui.mjs";

const CAPTURABLE = Boolean(scriptFlavor());

test("captureSpec hands back the launch untouched when nothing is watching", () => {
  const spec = captureSpec({ cmd: "gh", args: ["pr", "list"] }, undefined);
  assert.equal(spec.cmd, "gh");
  assert.deepEqual(spec.args, ["pr", "list"]);
  // stop() is always callable, so no caller has to know whether it captured.
  assert.doesNotThrow(() => spec.stop());
});

test("captureSpec falls back rather than failing on a box with no script(1)", () => {
  const spec = captureSpec({ cmd: "gh", args: ["pr", "list"] }, () => {}, { flavor: null });
  assert.equal(spec.cmd, "gh");
  assert.deepEqual(spec.args, ["pr", "list"]);
});

test("captureSpec wraps the launch in script(1) when a sink is attached", { skip: !CAPTURABLE }, () => {
  const spec = captureSpec({ cmd: "gh", args: ["pr", "list"] }, () => {});
  assert.equal(spec.cmd, "script");
  assert.ok(spec.args.includes("gh") || spec.args.some((a) => a.includes("'gh'")),
    "the real command has to survive into the script argv");
  spec.stop();
});

test("a shell command's stdout AND stderr both reach the mirror", { skip: !CAPTURABLE }, async () => {
  let seen = "";
  // stderr first, so a run that only captured stdout can't pass by accident of
  // ordering — both have to be there.
  const r = await runShell(
    "printf 'to-stderr\\n' >&2; printf 'to-stdout\\n'",
    { onOutput: (chunk) => { seen += chunk; } },
  );
  assert.equal(r.ok, true);
  assert.equal(r.code, 0);
  assert.match(seen, /to-stdout/, "stdout was the half that was never missing");
  assert.match(seen, /to-stderr/, "stderr is where a merge sweep says what it skipped");
});

test("a failing shell command still reports its exit code through the pty", { skip: !CAPTURABLE }, async () => {
  // script -e is what forwards the child's status; without it every command
  // would read as a success in the pit, which is worse than no capture at all.
  const r = await runShell("printf 'nope\\n' >&2; exit 3", { onOutput: () => {} });
  assert.equal(r.ok, true);
  assert.equal(r.code, 3);
});

test("an unmirrored shell command runs exactly as it did before", async () => {
  const r = await runShell("exit 0");
  assert.equal(r.ok, true);
  assert.equal(r.code, 0);
});

test("the active sink is what an unaware launcher captures through", { skip: !CAPTURABLE }, async () => {
  // A launcher should not have to know the mirror exists. runShell is handed a
  // sink by the pit; runCmd — the upgrader, /plugin, /skill, /mcp — is not, and
  // reads the live mirror off the module instead. That is deliberate: every
  // launcher taught by hand is one more that can be written without being.
  let seen = "";
  setActiveSink((chunk) => { seen += chunk; });
  try {
    const r = await runCmd("sh", ["-c", "printf 'from-a-launcher\\n' >&2"]);
    assert.equal(r.ok, true);
    assert.match(seen, /from-a-launcher/);
  } finally {
    setActiveSink(null);
  }
});

test("with no mirror running, a launcher spawns exactly what it always did", () => {
  setActiveSink(null);
  const spec = captureSpec({ cmd: "gh", args: ["pr", "list"] });
  assert.equal(spec.cmd, "gh", "an unmirrored pit stays on the untouched inherit path");
  assert.deepEqual(spec.args, ["pr", "list"]);
});

test("a shell command's stderr survives the whole chain to the session POST", { skip: !CAPTURABLE }, async () => {
  // The parts each work; this is the chain the operator actually watches —
  // runShell → the pty → the mirror's sink → a batched POST to
  // /api/sessions/<id>/output. Anything that reaches here reaches the page.
  const posted = [];
  const fetchImpl = async (url, options = {}) => {
    const { pathname } = new URL(url);
    if (pathname === "/api/sessions") {
      return new Response(JSON.stringify({ id: "session-1" }), { headers: { "content-type": "application/json" } });
    }
    if (pathname.endsWith("/commands")) {
      // Park forever; stop() aborts it.
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
      });
    }
    posted.push(JSON.parse(options.body).chunk);
    return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
  };

  const mirror = createMirror({
    credentials: { api: "https://app.example.test", token: "mck_test" },
    fetchImpl,
  });
  assert.equal(await mirror.start(), true);
  setActiveSink((chunk) => mirror.write(chunk));
  try {
    await runShell("printf 'merge-skipped-because\\n' >&2");
    await mirror.stop(); // flushes what is still pending
  } finally {
    setActiveSink(null);
  }

  assert.match(posted.join(""), /merge-skipped-because/,
    "stderr from a pit shell command has to reach the session page");
});

test("setActiveSink refuses anything that isn't callable", () => {
  // A bad value would throw inside followFile's poll — on a timer, with nobody
  // to catch it — so it is turned away at the door instead.
  setActiveSink("not a function");
  assert.equal(activeChildSink(), null);
  setActiveSink(null);
});
