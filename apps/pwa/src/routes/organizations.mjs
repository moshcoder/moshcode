import { Router } from "express";
import { all } from "../db.mjs";
import { bearer, userForApiKey } from "../lib/apikey.mjs";
import { requireAuth, csrfInput } from "../lib/session.mjs";
import { page, footer, appBar, esc } from "../lib/html.mjs";
import { balance } from "../lib/credits.mjs";
import {
  ROLES, permission, roleFor, MembershipError, organizationsFor, organizationFor,
  createOrganization, createTeam, teamFor, setTeamMember, setOrganizationMember,
  shareSession, sessionsFor,
} from "../lib/organizations.mjs";

export const organizationsRouter = Router();
const json = (req) => req.path.startsWith("/api/") || (req.get("accept") || "").includes("application/json");
const wrap = (handler) => async (req, res, next) => {
  try { await handler(req, res); }
  catch (error) {
    if (!(error instanceof MembershipError)) return next(error);
    if (json(req)) return res.status(error.status).json({ error: error.message });
    res.status(error.status).type("html").send(page({ title: "moshcode ▸ teams", body:
      `<main class="wrap" style="max-width:760px;padding-top:5vh"><h1>Could not save</h1><p>${esc(error.message)}</p><a class="btn" href="/organizations">Back to organizations</a></main>${footer}` }));
  }
};
const apiAuth = async (req, res, next) => {
  try {
    req.user = await userForApiKey(bearer(req));
    if (!req.user) return res.status(401).json({ error: "invalid or missing API key" });
    next();
  } catch (error) { next(error); }
};
for (const prefix of ["/api/organizations", "/api/teams"]) organizationsRouter.use(prefix, apiAuth);
const selectRole = (role = "read") => `<select name="role" aria-label="Member role">${ROLES.map((one) => `<option value="${one}"${role === one ? " selected" : ""}>${one}</option>`).join("")}</select>`;
const rolesNote = `<p class="dim">Read: watch shared sessions. Writer: watch and send input. Admin: manage members and teams within their scope. Owner: manage ownership too.</p>`;
const card = (body) => `<section class="card" style="margin:16px 0"><div class="card-body">${body}</div></section>`;
async function show(req, res, title, body) {
  res.type("html").send(page({ title: `moshcode ▸ ${title}`, body:
    `${appBar(req.user, await balance(req.user.id), req.csrfToken)}<main class="wrap" style="max-width:900px;padding-top:5vh"><h1>${esc(title)}</h1>${body}</main>${footer}` }));
}
const memberForms = (req, members, path, editable) => members.map((member) => `<div style="padding:12px 0;border-bottom:1px solid var(--line)">
  <b>${esc(member.display_name || member.email || "Member")}</b> <span class="dim">${esc(member.email || "")} · ${esc(member.role)}</span>
  ${editable ? `<form method="post" action="${path}/${esc(member.id)}" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
    ${csrfInput(req)}${selectRole(member.role)}<button class="btn" type="submit">Save role</button>
    <button class="btn" type="submit" name="remove" value="1">Remove member</button></form>` : ""}</div>`).join("");

organizationsRouter.get(["/organizations", "/api/organizations"], requireAuth, wrap(async (req, res) => {
  const organizations = await organizationsFor(req.user.id);
  if (json(req)) return res.json({ organizations });
  const items = organizations.map((org) => card(`<a class="acid" href="/organizations/${esc(org.id)}"><b>${esc(org.name)}</b> →</a> <span class="pill">${esc(org.role)}</span>`)).join("");
  await show(req, res, "Organizations", `<p class="dim">Build teams and share a live moshcode session with the people you work with.</p>${items || card("You have not joined an organization yet.")}
    ${card(`<h2>Create an organization</h2><form method="post" action="/organizations">${csrfInput(req)}<label class="field"><span>Organization name</span><input name="name" required maxlength="100" placeholder="Your organization"></label><button class="btn acid">Create organization</button></form>`)}`);
}));
organizationsRouter.post(["/organizations", "/api/organizations"], requireAuth, wrap(async (req, res) => {
  const organization = await createOrganization(req.user.id, req.body?.name);
  if (json(req)) return res.status(201).json({ organization });
  res.redirect(`/organizations/${organization.id}`);
}));
organizationsRouter.get(["/organizations/:id", "/api/organizations/:id"], requireAuth, wrap(async (req, res) => {
  const org = await organizationFor(req.params.id, req.user.id);
  if (json(req)) return res.json({ organization: org });
  const manager = permission(org.role) >= 3;
  await show(req, res, org.name, `<p><a class="acid" href="/organizations">← Organizations</a> <span class="pill">${esc(org.role)}</span></p>
    ${rolesNote}<h2>Teams</h2>${org.teams.map((team) => card(`<a class="acid" href="/teams/${esc(team.id)}"><b>${esc(team.name)}</b> →</a> <span class="pill">${roleFor(team.permission)}</span>`)).join("") || card("No teams to show yet.")}
    ${manager ? card(`<h2>Create a team</h2><form method="post" action="/organizations/${esc(org.id)}/teams">${csrfInput(req)}<label class="field"><span>Team name</span><input name="name" required maxlength="100" placeholder="Contractors"></label><button class="btn acid">Create team</button></form>`) +
      card(`<h2>Organization members</h2><p class="dim">Add people through a team below. Organization admins and owners can manage all teams.</p>${memberForms(req, org.members, `/organizations/${esc(org.id)}/members`, true)}`) : ""}`);
}));
organizationsRouter.post(["/organizations/:id/teams", "/api/organizations/:id/teams"], requireAuth, wrap(async (req, res) => {
  const team = await createTeam(req.user.id, req.params.id, req.body?.name);
  if (json(req)) return res.status(201).json({ team });
  res.redirect(`/teams/${team.id}`);
}));
organizationsRouter.post(["/organizations/:id/members/:userId", "/api/organizations/:id/members/:userId"], requireAuth, wrap(async (req, res) => {
  const member = await setOrganizationMember(req.user.id, req.params.id, { userId: req.params.userId, role: req.body?.role, remove: req.body?.remove === "1" || req.body?.remove === true });
  if (json(req)) return res.json({ member });
  res.redirect(`/organizations/${req.params.id}`);
}));
organizationsRouter.get(["/teams/:id", "/api/teams/:id"], requireAuth, wrap(async (req, res) => {
  const team = await teamFor(req.params.id, req.user.id);
  const sessions = await all(`SELECT s.id,s.name,s.status FROM cli_sessions s JOIN session_team_shares sh ON sh.session_id=s.id WHERE sh.team_id=? ORDER BY s.last_seen_at DESC LIMIT 50`, [team.id]);
  if (json(req)) return res.json({ team, sessions });
  const manager = permission(team.role) >= 3;
  await show(req, res, team.name, `<p><a class="acid" href="/organizations/${esc(team.organization_id)}">${esc(team.organization_name)}</a> → ${esc(team.name)} <span class="pill">${esc(team.role)}</span></p>
    ${rolesNote}${card(`<h2>Shared sessions</h2><p class="dim">The session owner shares a terminal from its session page. Everyone joins that same live terminal.</p>${sessions.map((s) => `<p><a class="acid" href="/sessions/${esc(s.id)}">${esc(s.name)} →</a> <span class="pill">${esc(s.status)}</span></p>`).join("") || `<p>No sessions shared yet. <a class="acid" href="/sessions">Open your sessions →</a></p>`}`)}
    ${card(`<h2>Team members</h2>${memberForms(req, team.members, `/teams/${esc(team.id)}/members`, manager)}`)}
    ${manager ? card(`<h2>Add a member</h2><p class="dim">Use the email on their moshcode account. Permissions default to read.</p><form method="post" action="/teams/${esc(team.id)}/members">${csrfInput(req)}<label class="field"><span>Email</span><input type="email" name="email" required></label><label class="field"><span>Role</span>${selectRole()}</label><button class="btn acid">Add member</button></form>`) : ""}`);
}));
organizationsRouter.post(["/teams/:id/members", "/api/teams/:id/members", "/teams/:id/members/:userId", "/api/teams/:id/members/:userId"], requireAuth, wrap(async (req, res) => {
  const member = await setTeamMember(req.user.id, req.params.id, { email: req.body?.email, userId: req.params.userId, role: req.body?.role, remove: req.body?.remove === "1" || req.body?.remove === true });
  if (json(req)) return res.json({ member });
  res.redirect(`/teams/${req.params.id}`);
}));

organizationsRouter.get("/api/sessions", apiAuth, wrap(async (req, res) => res.json({ sessions: await sessionsFor(req.user.id) })));
organizationsRouter.post("/api/sessions/:id/teams", apiAuth, wrap(async (req, res) => {
  await shareSession(req.user.id, req.params.id, req.body?.teamId, req.body?.remove === true);
  res.json({ ok: true });
}));
organizationsRouter.post("/sessions/:id/teams", requireAuth, wrap(async (req, res) => {
  await shareSession(req.user.id, req.params.id, req.body?.teamId, req.body?.remove === "1");
  res.redirect(`/sessions/${req.params.id}`);
}));
