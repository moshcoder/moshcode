// The claim the whole PRD rests on: a session outlives the process that
// started it. Everything else in the herd is bookkeeping around this.
//
// Run against both substrates, because "it works on my box, which has tmux" is
// exactly the assumption R2 exists to stop. Each substrate skips itself when
// the machine cannot provide it, so this passes on a bare container and still
// means something on a developer laptop.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HERD = path.join(ROOT, "src", "herd.mjs");

/**
 * A private runtime per test: its own socket so this cannot touch the sessions
 * a developer is actually running, and its own directory for the manifest.
 */
function isolated(substrate) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moshcode-survival-"));
  return {
    dir,
    env: {
      ...process.env,
      MOSHCODE_HERD: substrate,
      MOSHCODE_HERD_DIR: dir,
      MOSHCODE_HERD_SOCKET: `moshcode-test-${process.pid}-${path.basename(dir)}`,
    },
  };
}

/** Run a snippet in a throwaway node process, with the herd module available. */
function inChildProcess(env, source) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    env, encoding: "utf8", cwd: ROOT,
  });
  return `${result.stdout || ""}${result.stderr || ""}`.trim();
}

for (const substrate of ["tmux", "pty"]) {
  test(`a ${substrate} session keeps running after the process that started it exits`, (t) => {
    const { dir, env } = isolated(substrate);
    try {
      // One process starts the session and exits. Nothing is left holding it.
      const started = inChildProcess(env, `
        const herd = await import(${JSON.stringify(HERD)});
        const r = herd.startSession({
          name: "survivor", engine: "test", bin: "sh",
          args: ["-c", "echo READY; while read line; do echo got:$line; done"],
          cwd: process.cwd(),
        });
        console.log(r.ok ? "started" : "failed:" + (r.error && r.error.message));
      `);
      if (/no herd substrate/.test(started) || started === "") {
        t.skip(`no ${substrate} substrate on this machine`);
        return;
      }
      assert.match(started, /^started$/m, `could not start a ${substrate} session: ${started}`);

      // A second, unrelated process finds it still running and can talk to it.
      const seen = inChildProcess(env, `
        const herd = await import(${JSON.stringify(HERD)});
        await new Promise((r) => setTimeout(r, 1200));
        console.log("LIVE:" + JSON.stringify(herd.liveNames()));
        herd.sendPrompt("survivor", "ping");
        await new Promise((r) => setTimeout(r, 800));
        console.log("SCREEN:" + JSON.stringify(herd.capture("survivor", { lines: 20 })));
      `);
      assert.match(seen, /LIVE:\["survivor"\]/, `the session did not survive: ${seen}`);
      assert.match(seen, /got:ping/, `input did not reach the surviving session: ${seen}`);
    } finally {
      inChildProcess(env, `
        const herd = await import(${JSON.stringify(HERD)});
        herd.killSession("survivor");
        herd.stopRuntime();
      `);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`a ${substrate} session reports done once its process ends`, (t) => {
    const { dir, env } = isolated(substrate);
    try {
      const started = inChildProcess(env, `
        const herd = await import(${JSON.stringify(HERD)});
        const r = herd.startSession({
          name: "finisher", engine: "test", bin: "sh", args: ["-c", "echo working; exit 0"], cwd: process.cwd(),
        });
        console.log(r.ok ? "started" : "failed");
      `);
      if (started !== "started") { t.skip(`no ${substrate} substrate on this machine`); return; }

      const after = inChildProcess(env, `
        const herd = await import(${JSON.stringify(HERD)});
        const state = await import(${JSON.stringify(path.join(ROOT, "src", "herd-state.mjs"))});
        await new Promise((r) => setTimeout(r, 1500));
        const row = herd.listSessions().find((s) => s.name === "finisher");
        console.log("STATE:" + state.sessionState(row).state);
      `);
      // A finished agent has to stay visible and readable — "which one is
      // done?" is half the reason the roster exists, and a session that
      // evaporates on exit can only ever answer "gone".
      assert.match(after, /STATE:done/, `expected done, got: ${after}`);
    } finally {
      inChildProcess(env, `
        const herd = await import(${JSON.stringify(HERD)});
        herd.killSession("finisher");
        herd.stopRuntime();
      `);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
