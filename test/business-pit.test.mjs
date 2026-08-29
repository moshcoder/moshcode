// The business layer as typed at the prompt, and the gate in front of it.
//
// The unit tests drive the command functions directly; these drive the pit,
// because dispatch is its own thing and the gate lives there. Both halves have
// been wrong in this codebase before for the same reason: a command that works
// when imported is not yet a command anybody can type.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../bin/moshcode.mjs", import.meta.url));

/** Drive a pit, one command per prompt, against a throwaway $HOME. */
function runTui(lines, { home, env = {} } = {}) {
  const HOME = home || mkdtempSync(join(tmpdir(), "moshcode-biz-pit-"));
  const queue = [...(Array.isArray(lines) ? lines : [lines]), "/quit"];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, HOME, USERPROFILE: HOME, MOSHCODE_NO_MIRROR: "1", ...env },
    });
    let stdout = "";
    let stderr = "";
    let seen = 0;
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const prompts = stdout.split("mosh ▸").length - 1;
      while (seen < prompts) {
        seen += 1;
        const next = queue.shift();
        if (next === undefined) { child.stdin.end(); return; }
        child.stdin.write(`${next}\n`);
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr, home: HOME }));
  });
}

const businessOf = (home) => JSON.parse(readFileSync(join(home, ".moshcode", "business.json"), "utf8"));
const timersOf = (home) => JSON.parse(readFileSync(join(home, ".moshcode", "timers.json"), "utf8"));

test("a client, a rate and a timer, typed at the prompt", async () => {
  const result = await runTui([
    '/client create "Acme Inc", https://acme.com, +1-555-0100',
    "/rate set acme-inc $100/hour/agent/upto:4",
    "/timer on acme-inc --task shipping",
    "/timer off",
    "/timer log",
  ]);

  assert.equal(result.status, 0);
  const business = businessOf(result.home);
  assert.equal(business.clients["acme-inc"].url, "https://acme.com");
  assert.equal(business.rates["acme-inc"].cap, 4);
  const timers = timersOf(result.home);
  assert.equal(timers.active, null);
  assert.equal(timers.entries.length, 1);
  assert.equal(timers.entries[0].task, "shipping");
  assert.match(result.stdout, /timer off/);
});

test("an installed timer CLI does not quietly take the pit's records away", async () => {
  // The regression: /timer and /billing gained standalone CLIs, and delegating
  // to them the moment they appeared on PATH split one person's records in
  // half. /client and /rate have no outside home, so they kept writing
  // ~/.moshcode/business.json while /billing read the package's own ledger —
  // and the invoice for a client you had just created did not exist.
  //
  // A fake `timer` on PATH is enough to reproduce it: the check is only
  // "is this name executable". Without the opt-in the pit must ignore it.
  const dir = mkdtempSync(join(tmpdir(), "moshcode-fake-bin-"));
  const isWindows = process.platform === "win32";
  const shim = join(dir, isWindows ? "timer.cmd" : "timer");
  writeFileSync(shim, isWindows ? "@echo off\r\nexit /b 0\r\n" : "#!/bin/sh\nexit 0\n");
  if (!isWindows) chmodSync(shim, 0o755);

  try {
    const result = await runTui(
      ["/client create Acme", "/timer on acme --task shipping", "/timer off"],
      { env: { PATH: `${dir}${delimiter}${process.env.PATH}` } },
    );
    assert.equal(result.status, 0);
    // Had it delegated, the shim would have exited 0 having written nothing
    // and this file would not exist.
    const timers = timersOf(result.home);
    assert.equal(timers.entries.length, 1, "the pit kept its own ledger");
    assert.equal(timers.entries[0].task, "shipping");
    assert.ok(businessOf(result.home).clients.acme, "and the client is in the same place");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("/business and /merchant are the same door as /client", async () => {
  const result = await runTui(["/business create Globex", "/merchant list"]);
  assert.ok(businessOf(result.home).clients.globex, "/business created it");
  assert.match(result.stdout, /globex/, "/merchant listed it");
});

test("the pit's own files stay owner-only", async () => {
  const { statSync } = await import("node:fs");
  const result = await runTui(["/client create Acme"]);
  const mode = statSync(join(result.home, ".moshcode", "business.json")).mode & 0o777;
  assert.equal(mode, 0o600, "a client list is nobody else's business on a shared box");
});

test("MOSHCODE_MEMBER gates the pit, and says what to ask for", async () => {
  // Set the team up as the owner first, then come back as the member.
  const first = await runTui([
    "/team create Profullstack",
    "/team add profullstack preshy --role member",
    "/team grant profullstack preshy tools:coinpay",
  ]);
  const member = businessOf(first.home).teams.profullstack.members.preshy;
  assert.deepEqual(member.grants, ["tools:coinpay"]);

  const gated = await runTui(
    ["/team whoami", "/payments connect wallet --chain solana --address 5wal"],
    { home: first.home, env: { MOSHCODE_MEMBER: "profullstack/preshy" } },
  );
  assert.match(gated.stdout, /preshy/);
  assert.match(gated.stdout, /no payments:write/, "the refusal names the permission");
  assert.match(gated.stdout, /\/team grant profullstack preshy payments:write/, "and how to fix it");
  assert.equal(businessOf(first.home).payments.gateways, undefined, "nothing was connected");
});

test("--help is answered before the gate, and before the command runs", async () => {
  const result = await runTui(
    ["/timer --help", "/timer status"],
    { env: { MOSHCODE_MEMBER: "nobody/nobody" } },
  );
  // Asking what a command does is not doing it, so help answers even for a
  // member the gate would otherwise refuse outright.
  assert.match(result.stdout, /moshcode timer —/);
  assert.match(result.stdout, /no team here has that member/, "the command itself is still refused");
});
