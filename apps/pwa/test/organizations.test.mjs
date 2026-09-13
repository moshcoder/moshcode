import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let deps;
try { deps = { express: require("express"), cookieParser: require("cookie-parser") }; } catch { /* optional PWA dependencies */ }
const options = { skip: !deps && "apps/pwa deps not installed" };
const dir = mkdtempSync(path.join(tmpdir(), "moshcode-organizations-"));
process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
process.env.SESSION_SECRET = "organization-tests-only";
process.env.SESSION_POLL_MS = "30";
let state;
async function boot() {
  const { migrate } = await import("../src/migrate.mjs");
  await migrate();
  const sql = await import("../src/db.mjs");
  const org = await import("../src/lib/organizations.mjs");
  const { createApiKey } = await import("../src/lib/apikey.mjs");
  const { sessionMiddleware, csrfGuard } = await import("../src/lib/session.mjs");
  const { organizationsRouter } = await import("../src/routes/organizations.mjs");
  const { sessionsRouter } = await import("../src/routes/sessions.mjs");
  const app = deps.express();
  app.use(deps.express.json(), deps.express.urlencoded({ extended: false }), deps.cookieParser(), sessionMiddleware, csrfGuard, sessionsRouter, organizationsRouter);
  app.use((err, _req, res, _next) => { console.error(err); res.status(500).json({ error: err.message }); });
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const tokens = {};
  for (const user of ["owner", "reader", "writer", "admin", "outsider", "second"]) {
    await sql.run("INSERT INTO users (id,email,display_name,created_at) VALUES (?,?,?,?)", [user, `${user}@example.com`, user, Date.now()]);
    await sql.run("INSERT INTO sessions (token,user_id,created_at,expires_at) VALUES (?,?,?,?)", [`cookie-${user}`, user, Date.now(), Date.now() + 600000]);
    tokens[user] = (await createApiKey(user, "test")).plaintext;
  }
  const api = (user, pathname, body) => fetch(base + pathname, { method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${tokens[user]}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const browser = (user, pathname, body, extra = {}) => fetch(base + pathname, { method: body === undefined ? "GET" : "POST", redirect: "manual",
    headers: { cookie: `mc_sess=cookie-${user}; mc_csrf=csrf-${user}`, "content-type": "application/json", accept: "application/json" },
    body: body === undefined ? undefined : JSON.stringify({ ...body, _csrf: `csrf-${user}` }), ...extra });
  return { ...sql, org, base, api, browser, server };
}
const app = () => state ||= boot();
test.after(async () => {
  if (state) { const { server, db } = await state; server.closeAllConnections(); await new Promise((done) => server.close(done)); db.close(); }
  rmSync(dir, { recursive: true, force: true });
});
let sequence = 0;
async function teamFixture() {
  const a = await app();
  const organization = await a.org.createOrganization("owner", `Organization ${++sequence}`);
  const team = await a.org.createTeam("owner", organization.id, "Contractors");
  return { ...a, organization, team };
}

test("organizations and teams belong to their creator, with read access by default", options, async () => {
  const { org, organization, team, api, browser } = await teamFixture();
  assert.equal((await org.organizationFor(organization.id, "owner")).role, "owner");
  assert.equal((await org.teamFor(team.id, "owner")).role, "owner");
  await org.setTeamMember("owner", team.id, { email: " READER@EXAMPLE.COM " });
  assert.equal((await org.teamFor(team.id, "reader")).role, "read");
  assert.equal((await org.organizationFor(organization.id, "reader")).role, "read");
  assert.equal((await api("outsider", `/api/teams/${team.id}`)).status, 404);
  assert.equal((await api("outsider", `/api/organizations/${organization.id}`)).status, 404);
  assert.equal((await api("reader", `/api/organizations/${organization.id}/teams`, { name: "Intrusion" })).status, 403);
  assert.equal((await api("reader", `/api/teams/${team.id}/members`, { email: "outsider@example.com", role: "admin" })).status, 403);
  assert.equal((await api("owner", `/api/teams/${team.id}/members`, { email: "reader@example.com", role: "root" })).status, 400);
  const noCsrf = await browser("owner", `/teams/${team.id}/members`, {}, { body: JSON.stringify({ email: "reader@example.com" }) });
  assert.equal(noCsrf.status, 403);
  const cookieApi = await browser("owner", "/api/organizations", { name: "No bearer" });
  assert.equal(cookieApi.status, 401, "API cannot authenticate with a CSRF-exempt cookie");
});

test("team admins cannot grant ownership or promote their organization role", options, async () => {
  const { org, organization, team } = await teamFixture();
  await org.setTeamMember("owner", team.id, { email: "admin@example.com", role: "admin" });
  await org.setTeamMember("admin", team.id, { email: "writer@example.com", role: "writer" });
  await assert.rejects(() => org.setTeamMember("admin", team.id, { email: "reader@example.com", role: "owner" }), /Only an owner/);
  await assert.rejects(() => org.setTeamMember("admin", team.id, { userId: "owner", role: "read" }), /Only an owner/);
  await assert.rejects(() => org.setOrganizationMember("admin", organization.id, { userId: "admin", role: "owner" }), /Organization admin/);
  await assert.rejects(() => org.setTeamMember("owner", team.id, { userId: "owner", remove: true }), /at least one team owner/);
  await assert.rejects(() => org.setOrganizationMember("owner", organization.id, { userId: "owner", role: "admin" }), /at least one organization owner/);
  await org.setTeamMember("owner", team.id, { email: "second@example.com", role: "owner" });
  const raced = await Promise.allSettled([
    org.setTeamMember("owner", team.id, { userId: "owner", remove: true }),
    org.setTeamMember("second", team.id, { userId: "second", remove: true }),
  ]);
  assert.equal(raced.filter((r) => r.status === "fulfilled").length, 1, "simultaneous removals preserve an owner");
});

test("organization admin access is inherited but ordinary membership shares no other teams", options, async () => {
  const { org, organization, team } = await teamFixture();
  await org.setTeamMember("owner", team.id, { email: "admin@example.com", role: "read" });
  await org.setTeamMember("owner", team.id, { email: "reader@example.com", role: "read" });
  const privateTeam = await org.createTeam("owner", organization.id, "Private");
  await assert.rejects(() => org.teamFor(privateTeam.id, "reader"), /No such team/);
  await org.setOrganizationMember("owner", organization.id, { userId: "admin", role: "admin" });
  assert.equal((await org.teamFor(privateTeam.id, "admin")).role, "admin");
  await org.setOrganizationMember("owner", organization.id, { userId: "admin", role: "read" });
  await assert.rejects(() => org.teamFor(privateTeam.id, "admin"), /No such team/);
  await org.setOrganizationMember("owner", organization.id, { userId: "reader", remove: true });
  await assert.rejects(() => org.teamFor(team.id, "reader"), /No such team/);
});

test("readers watch the same terminal, writers send input, and machine endpoints stay owner-only", options, async () => {
  const { org, team, api, browser, get } = await teamFixture();
  for (const role of ["read", "writer"]) await org.setTeamMember("owner", team.id, { email: `${role === "read" ? "reader" : "writer"}@example.com`, role });
  const registered = await (await api("owner", "/api/sessions", { name: "Shared terminal", features: ["keys", "signals"] })).json();
  const sid = registered.id;
  assert.equal((await browser("reader", `/sessions/${sid}`)).status, 404, "private until explicitly shared");
  await org.shareSession("owner", sid, team.id);
  const read = await browser("reader", `/sessions/${sid}`);
  assert.equal(read.status, 200);
  const html = await read.text();
  assert.match(html, /Shared session · read/);
  assert.match(html, /<textarea[^>]*disabled/);
  const writeHtml = await (await browser("writer", `/sessions/${sid}`)).text();
  assert.doesNotMatch(writeHtml, /<textarea[^>]*disabled/);
  assert.equal((await browser("reader", `/sessions/${sid}/commands`, { body: "do work" })).status, 403);
  assert.equal((await browser("reader", `/sessions/${sid}/commands`, { key: "enter" })).status, 403);
  assert.equal((await api("writer", `/api/sessions/${sid}/output`, { chunk: "forged" })).status, 404);
  assert.equal((await api("writer", `/api/sessions/${sid}/commands`)).status, 404);
  assert.equal((await api("writer", `/api/sessions/${sid}/end`, {})).status, 404);
  assert.equal((await api("writer", `/api/sessions/${sid}/teams`, { teamId: team.id, remove: true })).status, 403);
  const sent = await (await browser("writer", `/sessions/${sid}/commands`, { body: "hello from teammate" })).json();
  assert.equal((await get("SELECT actor_user_id FROM session_commands WHERE id=?", [sent.id])).actor_user_id, "writer");
  const claimed = await (await api("owner", `/api/sessions/${sid}/commands`)).json();
  assert.deepEqual(claimed.commands, [{ id: sent.id, body: "hello from teammate" }]);
  assert.deepEqual((await (await api("owner", `/api/sessions/${sid}/commands`)).json()).commands, []);
  const list = await (await api("reader", "/api/sessions")).json();
  assert.ok(list.sessions.some((s) => s.id === sid));
});

test("revoking or downgrading a writer cancels queued input before the CLI can claim it", options, async () => {
  const { org, team, api, browser, get } = await teamFixture();
  const { id: sid } = await (await api("owner", "/api/sessions", { name: "Revocation", features: ["keys"] })).json();
  await org.shareSession("owner", sid, team.id);
  for (const change of ["downgrade", "remove", "unshare"]) {
    await org.setTeamMember("owner", team.id, { email: "writer@example.com", role: "writer" });
    const sent = await (await browser("writer", `/sessions/${sid}/commands`, { key: "enter" })).json();
    if (change === "unshare") await org.shareSession("owner", sid, team.id, true);
    else await org.setTeamMember("owner", team.id, { userId: "writer", role: "read", remove: change === "remove" });
    assert.deepEqual((await (await api("owner", `/api/sessions/${sid}/commands`)).json()).commands, []);
    assert.equal((await get("SELECT status FROM session_commands WHERE id=?", [sent.id])).status, "cancelled");
  }
});

test("an open stream stops disclosing output as soon as team access is removed", options, async () => {
  const { org, team, api, browser } = await teamFixture();
  await org.setTeamMember("owner", team.id, { email: "reader@example.com" });
  const { id: sid } = await (await api("owner", "/api/sessions", { name: "Revoked view" })).json();
  await org.shareSession("owner", sid, team.id);
  await api("owner", `/api/sessions/${sid}/output`, { chunk: "visible before removal" });
  const stop = new AbortController();
  const response = await browser("reader", `/sessions/${sid}/stream`, undefined, { signal: stop.signal });
  const reader = response.body.getReader();
  const decode = new TextDecoder();
  let text = "";
  try {
    while (!text.includes("visible before removal")) text += decode.decode((await reader.read()).value);
    await org.setTeamMember("owner", team.id, { userId: "reader", remove: true });
    await api("owner", `/api/sessions/${sid}/output`, { chunk: "private after removal" });
    while (true) { const chunk = await reader.read(); if (chunk.done) break; text += decode.decode(chunk.value); }
    assert.match(text, /access-revoked/);
    assert.doesNotMatch(text, /private after removal/);
    assert.equal((await browser("reader", `/sessions/${sid}/stream`)).status, 404);
  } finally { stop.abort(); }
});
