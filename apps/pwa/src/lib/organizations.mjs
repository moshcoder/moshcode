import { db, get, all } from "../db.mjs";
import { id } from "./crypto.mjs";

export const ROLES = ["read", "writer", "admin", "owner"];
export const permission = (role) => ROLES.indexOf(role) + 1;
export const roleFor = (level) => ROLES[Number(level) - 1] || "read";

export class MembershipError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const fail = (message, status) => { throw new MembershipError(message, status); };
const nameOf = (value) => {
  const name = String(value || "").trim();
  if (!name || name.length > 100) fail("Use a name between 1 and 100 characters.");
  return name;
};
const roleOf = (value) => {
  const role = value == null || value === "" ? "read" : value;
  if (!ROLES.includes(role)) fail("Choose read, writer, admin, or owner.");
  return role;
};
const first = async (tx, sql, args) => (await tx.execute({ sql, args })).rows[0] || null;
let writes = Promise.resolve();
function transaction(work) {
  // libSQL's local client opens another connection for each transaction.
  // Queue local membership writes rather than racing BEGIN IMMEDIATE on it;
  // the database transaction still protects against other app processes.
  const operation = writes.then(async () => {
    await db.execute("PRAGMA foreign_keys = ON");
    const tx = await db.transaction("write");
    try { const result = await work(tx); await tx.commit(); return result; }
    catch (error) { await tx.rollback(); throw error; }
    finally { tx.close(); }
  });
  writes = operation.catch(() => {});
  return operation;
}
async function orgManager(tx, organizationId, actorId) {
  const member = await first(tx, "SELECT role FROM organization_members WHERE organization_id=? AND user_id=?", [organizationId, actorId]);
  if (!member || permission(member.role) < 3) fail("Organization admin access is required.", 403);
  return member.role;
}
async function teamManager(tx, teamId, actorId) {
  const member = await first(tx, "SELECT permission FROM team_access WHERE team_id=? AND user_id=?", [teamId, actorId]);
  if (!member || Number(member.permission) < 3) fail("Team admin access is required.", 403);
  return roleFor(member.permission);
}
function mayChange(actorRole, previousRole, nextRole) {
  if (actorRole !== "owner" && (previousRole === "owner" || nextRole === "owner")) {
    fail("Only an owner can change owner membership.", 403);
  }
}

export async function createOrganization(actorId, name) {
  const org = { id: id(), name: nameOf(name), created_at: Date.now() };
  return transaction(async (tx) => {
    await tx.execute({ sql: "INSERT INTO organizations (id,name,created_at) VALUES (?,?,?)", args: [org.id, org.name, org.created_at] });
    await tx.execute({ sql: "INSERT INTO organization_members (organization_id,user_id,role,created_at) VALUES (?,?,'owner',?)", args: [org.id, actorId, org.created_at] });
    return org;
  });
}
export const organizationsFor = (userId) => all(`SELECT o.*, m.role FROM organizations o
  JOIN organization_members m ON m.organization_id=o.id WHERE m.user_id=? ORDER BY o.name`, [userId]);
export const teamsFor = (userId) => all(`SELECT t.*, o.name AS organization_name, a.permission
  FROM teams t JOIN organizations o ON o.id=t.organization_id JOIN team_access a ON a.team_id=t.id
  WHERE a.user_id=? ORDER BY o.name,t.name`, [userId]);

export async function organizationFor(organizationId, userId) {
  const org = await get(`SELECT o.*,m.role FROM organizations o JOIN organization_members m ON m.organization_id=o.id
    WHERE o.id=? AND m.user_id=?`, [organizationId, userId]);
  if (!org) fail("No such organization.", 404);
  const teams = (await teamsFor(userId)).filter((t) => t.organization_id === organizationId);
  const members = permission(org.role) >= 3 ? await all(`SELECT u.id,u.email,u.display_name,m.role FROM organization_members m
    JOIN users u ON u.id=m.user_id WHERE m.organization_id=? ORDER BY u.email`, [organizationId]) : [];
  return { ...org, teams, members };
}
export async function teamFor(teamId, userId) {
  const team = (await teamsFor(userId)).find((t) => t.id === teamId);
  if (!team) fail("No such team.", 404);
  const members = await all(`SELECT u.id,u.email,u.display_name,m.role FROM team_members m
    JOIN users u ON u.id=m.user_id WHERE m.team_id=? ORDER BY u.email`, [teamId]);
  return { ...team, role: roleFor(team.permission), members };
}
export async function createTeam(actorId, organizationId, name) {
  const team = { id: id(), organization_id: organizationId, name: nameOf(name), created_at: Date.now() };
  return transaction(async (tx) => {
    await orgManager(tx, organizationId, actorId);
    if (await first(tx, "SELECT id FROM teams WHERE organization_id=? AND name=?", [organizationId, team.name])) fail("That team already exists.", 409);
    await tx.execute({ sql: "INSERT INTO teams (id,organization_id,name,created_at) VALUES (?,?,?,?)", args: [team.id, organizationId, team.name, team.created_at] });
    await tx.execute({ sql: "INSERT INTO team_members (team_id,organization_id,user_id,role,created_at) VALUES (?,?,?,'owner',?)", args: [team.id, organizationId, actorId, team.created_at] });
    return team;
  });
}

// Membership uses an existing account. It never creates credentials for someone
// else or grants access to a later registration just because an email matches.
export async function setTeamMember(actorId, teamId, { email, userId, role, remove = false }) {
  const nextRole = remove ? null : roleOf(role);
  return transaction(async (tx) => {
    const actorRole = await teamManager(tx, teamId, actorId);
    const team = await first(tx, "SELECT * FROM teams WHERE id=?", [teamId]);
    const user = userId
      ? await first(tx, "SELECT id,email,display_name FROM users WHERE id=?", [userId])
      : await first(tx, "SELECT id,email,display_name FROM users WHERE lower(email)=?", [String(email || "").trim().toLowerCase()]);
    if (!user) fail("That person needs to create a moshcode account first.", 404);
    const previous = await first(tx, "SELECT role FROM team_members WHERE team_id=? AND user_id=?", [teamId, user.id]);
    mayChange(actorRole, previous?.role, nextRole);
    if (previous?.role === "owner" && nextRole !== "owner") {
      const count = await first(tx, "SELECT COUNT(*) AS n FROM team_members WHERE team_id=? AND role='owner'", [teamId]);
      if (Number(count.n) <= 1) fail("Keep at least one team owner.", 409);
    }
    if (remove) {
      await tx.execute({ sql: "DELETE FROM team_members WHERE team_id=? AND user_id=?", args: [teamId, user.id] });
    } else {
      await tx.execute({ sql: "INSERT OR IGNORE INTO organization_members (organization_id,user_id,role,created_at) VALUES (?,?,'read',?)", args: [team.organization_id, user.id, Date.now()] });
      await tx.execute({ sql: `INSERT INTO team_members (team_id,organization_id,user_id,role,created_at) VALUES (?,?,?,?,?)
        ON CONFLICT(team_id,user_id) DO UPDATE SET role=excluded.role`, args: [teamId, team.organization_id, user.id, nextRole, Date.now()] });
    }
    return { ...user, role: nextRole };
  });
}
export async function setOrganizationMember(actorId, organizationId, { userId, role, remove = false }) {
  const nextRole = remove ? null : roleOf(role);
  return transaction(async (tx) => {
    const actorRole = await orgManager(tx, organizationId, actorId);
    const previous = await first(tx, "SELECT role FROM organization_members WHERE organization_id=? AND user_id=?", [organizationId, userId]);
    if (!previous) fail("No such organization member.", 404);
    mayChange(actorRole, previous.role, nextRole);
    if (previous.role === "owner" && nextRole !== "owner") {
      const count = await first(tx, "SELECT COUNT(*) AS n FROM organization_members WHERE organization_id=? AND role='owner'", [organizationId]);
      if (Number(count.n) <= 1) fail("Keep at least one organization owner.", 409);
    }
    if (remove) {
      const last = await first(tx, `SELECT t.team_id FROM team_members t WHERE t.organization_id=? AND t.user_id=? AND t.role='owner'
        AND NOT EXISTS (SELECT 1 FROM team_members other WHERE other.team_id=t.team_id AND other.role='owner' AND other.user_id<>?)`, [organizationId, userId, userId]);
      if (last) fail("Assign another owner to this member's teams first.", 409);
      await tx.execute({ sql: "DELETE FROM organization_members WHERE organization_id=? AND user_id=?", args: [organizationId, userId] });
    } else {
      await tx.execute({ sql: "UPDATE organization_members SET role=? WHERE organization_id=? AND user_id=?", args: [nextRole, organizationId, userId] });
    }
    return { userId, role: nextRole };
  });
}

export const accessibleSession = (sessionId, userId) => get(`SELECT s.*,
  CASE WHEN s.user_id=? THEN 4 ELSE a.permission END AS permission
  FROM cli_sessions s LEFT JOIN shared_session_access a ON a.session_id=s.id AND a.user_id=?
  WHERE s.id=? AND (s.user_id=? OR a.permission>=1)`, [userId, userId, sessionId, userId]);
export const sessionsFor = (userId) => all(`SELECT s.*,
  CASE WHEN s.user_id=? THEN 4 ELSE a.permission END AS permission
  FROM cli_sessions s LEFT JOIN shared_session_access a ON a.session_id=s.id AND a.user_id=?
  WHERE s.user_id=? OR a.permission>=1 ORDER BY s.last_seen_at DESC LIMIT 50`, [userId, userId, userId]);
export const sharesFor = (sessionId) => all(`SELECT t.id,t.name,o.name AS organization_name FROM session_team_shares s
  JOIN teams t ON t.id=s.team_id JOIN organizations o ON o.id=t.organization_id WHERE s.session_id=? ORDER BY o.name,t.name`, [sessionId]);
export async function shareSession(actorId, sessionId, teamId, remove = false) {
  return transaction(async (tx) => {
    if (!await first(tx, "SELECT id FROM cli_sessions WHERE id=? AND user_id=?", [sessionId, actorId])) fail("Only the session owner can share it.", 403);
    // Removing a stale share must still work after the owner leaves its team.
    if (remove) {
      await tx.execute({ sql: "DELETE FROM session_team_shares WHERE session_id=? AND team_id=?", args: [sessionId, teamId] });
      return;
    }
    if (!await first(tx, "SELECT team_id FROM team_access WHERE team_id=? AND user_id=?", [teamId, actorId])) fail("Join the team before sharing a session with it.", 403);
    await tx.execute({ sql: "INSERT OR IGNORE INTO session_team_shares (session_id,team_id,shared_by,created_at) VALUES (?,?,?,?)", args: [sessionId, teamId, actorId, Date.now()] });
  });
}
