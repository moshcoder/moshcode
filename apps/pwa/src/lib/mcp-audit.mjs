import { run } from "../db.mjs";
import { id } from "./crypto.mjs";

/** Callers pass identity and a fixed action/outcome only, never request bodies. */
export async function auditMcp({ userId, clientId = null, shareId = null, sessionId = null, action, outcome }) {
  const eventId = id();
  await run(
    `INSERT INTO mcp_audit_events (id,user_id,client_id,share_id,session_id,action,outcome,created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    [eventId, userId, clientId, shareId, sessionId, action, outcome, Date.now()]
  );
  return eventId;
}

export const finishMcpAudit = (eventId, outcome) =>
  run(`UPDATE mcp_audit_events SET outcome=? WHERE id=?`, [outcome, eventId]);
