// Permissions: what the words mean, and what the gate does with them.
//
// The gate is a guardrail, not a security boundary (src/teams.mjs says so at
// the top and `moshcode help team` says so to the operator). These tests hold
// it to the promise it does make: the answer is the same every time, a grant
// widens exactly what it names, and read is never write.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { can, checkAccess, currentMember, grantsFor, normalizePermission, permissionFor, resolveTeam, ROLES, teamCommand } from "../src/teams.mjs";
import { loadBusiness } from "../src/business-store.mjs";

function sandbox(t) {
  const previous = process.env.HOME;
  process.env.HOME = mkdtempSync(join(tmpdir(), "moshcode-team-"));
  t.after(() => { process.env.HOME = previous; });
  const lines = [];
  return { lines, write: (l) => lines.push(String(l)), said: () => lines.join("\n") };
}

test("a permission means the same thing however it is written", () => {
  assert.equal(normalizePermission("tools:coinpay"), "tools:coinpay");
  assert.equal(normalizePermission("tools/coinpay"), "tools:coinpay");
  assert.equal(normalizePermission("allow(tools/coinpay)"), "tools:coinpay");
  assert.equal(normalizePermission("Tools Coinpay"), "tools:coinpay");
  // A bare surface is the whole surface, which is what somebody means by it.
  assert.equal(normalizePermission("tools"), "tools:*");
  assert.equal(normalizePermission(""), null);
});

test("wildcards widen, and read does not imply write", () => {
  assert.equal(can(["*"], "payments:write"), true);
  assert.equal(can(["tools:*"], "tools:coinpay"), true);
  assert.equal(can(["tools:coinpay"], "tools:stripe"), false);
  assert.equal(can(["billing:*"], "billing:write"), true);
  // The one that matters: being allowed to look at an invoice is not being
  // allowed to send one.
  assert.equal(can(["billing:read"], "billing:write"), false);
  assert.equal(can([], "tools:coinpay"), false);
});

test("a pit line maps to the permission it actually needs", () => {
  assert.equal(permissionFor("tools", ["coinpay"]), "tools:coinpay");
  assert.equal(permissionFor("agents", ["claude"]), "agents:claude");
  assert.equal(permissionFor("billing", ["acme"]), "billing:read");
  assert.equal(permissionFor("billing", ["acme", "--send"]), "billing:write");
  assert.equal(permissionFor("timer", ["log"]), "timer:read");
  assert.equal(permissionFor("timer", ["on", "acme"]), "timer:write");
  // A command the gate knows nothing about needs nothing — otherwise every
  // verb added after this file would be refused by default.
  assert.equal(permissionFor("games", ["tetris"]), null);
  assert.equal(permissionFor("help", []), null);
});

test("a role is a starting set, and a grant adds to it", (t) => {
  const io = sandbox(t);
  teamCommand(["create", "Profullstack"], io);
  teamCommand(["add", "profullstack", "preshy", "--role", "member"], io);
  teamCommand(["grant", "profullstack", "preshy", "tools:coinpay"], io);
  const member = loadBusiness().teams.profullstack.members.preshy;
  assert.deepEqual(member.grants, ["tools:coinpay"], "only the explicit grant is stored");
  assert.equal(can(grantsFor(member), "tools:coinpay"), true);
  assert.equal(can(grantsFor(member), "timer:write"), true, "from the role");
  assert.equal(can(grantsFor(member), "payments:write"), false);
});

test("revoking something the role hands back says so instead of doing nothing", (t) => {
  const io = sandbox(t);
  teamCommand(["create", "Profullstack"], io);
  teamCommand(["add", "profullstack", "preshy", "--role", "member"], io);
  io.lines.length = 0;
  teamCommand(["revoke", "profullstack", "preshy", "timer:write"], io);
  assert.match(io.said(), /role \(member\) still grants it/);
});

test("one team needs no naming; two do", (t) => {
  const io = sandbox(t);
  teamCommand(["create", "Profullstack"], io);
  teamCommand(["add", "preshy"], io);
  assert.ok(loadBusiness().teams.profullstack.members.preshy, "the only team is the team");
  teamCommand(["create", "Moshcoder"], io);
  const found = resolveTeam(loadBusiness(), null);
  assert.equal(found.ok, false, "with two teams, silence is not an answer");
});

test("the gate is open for the owner and closed for a member who was not granted it", (t) => {
  const io = sandbox(t);
  teamCommand(["create", "Profullstack"], io);
  teamCommand(["add", "profullstack", "preshy", "--role", "member"], io);
  teamCommand(["grant", "profullstack", "preshy", "tools:coinpay"], io);

  // No MOSHCODE_MEMBER: the owner is at the keyboard, nothing is checked.
  assert.equal(checkAccess("payments", ["connect"], { env: {} }).allowed, true);

  const env = { MOSHCODE_MEMBER: "profullstack/preshy" };
  assert.equal(checkAccess("tools", ["coinpay"], { env }).allowed, true);
  assert.equal(checkAccess("tools", ["stripe"], { env }).allowed, false);
  const refused = checkAccess("payments", ["connect"], { env });
  assert.equal(refused.allowed, false);
  assert.match(refused.reason, /no payments:write/);
});

test("a MOSHCODE_MEMBER nobody recognises is refused, not ignored", (t) => {
  const io = sandbox(t);
  teamCommand(["create", "Profullstack"], io);
  const env = { MOSHCODE_MEMBER: "profullstack/nobody" };
  const gate = checkAccess("tools", ["coinpay"], { env });
  assert.equal(gate.allowed, false, "an unknown member must not fall through to owner");
  assert.match(gate.reason, /no team here has that member/);
});

test("a handle alone finds its team", (t) => {
  const io = sandbox(t);
  teamCommand(["create", "Profullstack"], io);
  teamCommand(["add", "profullstack", "preshy"], io);
  const acting = currentMember(loadBusiness(), { MOSHCODE_MEMBER: "preshy" });
  assert.equal(acting.teamId, "profullstack");
  assert.equal(acting.member.role, "member");
});

test("the client role can read what it is billed and nothing else", () => {
  const grants = ROLES.client;
  assert.equal(can(grants, "billing:read"), true);
  assert.equal(can(grants, "timer:read"), true);
  assert.equal(can(grants, "timer:write"), false);
  assert.equal(can(grants, "agents:claude"), false);
  assert.equal(can(grants, "shell:*"), false);
});
