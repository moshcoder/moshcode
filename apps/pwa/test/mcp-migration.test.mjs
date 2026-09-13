import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-upgrade-"));
process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
process.env.PUBLIC_ORIGIN = "https://app.example.test";
process.env.MCP_PUBLIC_ORIGIN = "https://gateway.example.test";
const { run, get, db } = await import("../src/db.mjs");
const { sha256 } = await import("../src/lib/crypto.mjs");
const migrations = new URL("../src/migrations/", import.meta.url);
test.after(() => { db.close?.(); fs.rmSync(dir, { recursive: true, force: true }); });

test("upgrade preserves existing consent, pairs access/refresh grants and leaves ordinary queued input alone", async () => {
  const files = fs.readdirSync(migrations).filter((name) => name.endsWith(".sql") && name < "022").sort();
  for (const name of files) {
    const sql = fs.readFileSync(new URL(name, migrations), "utf8");
    for (const statement of sql.split(/;\s*(?:\n|$)/).map((one) => one.trim()).filter(Boolean)) await run(statement);
    await run(`INSERT INTO _migrations (name,applied_at) VALUES (?,?)`, [name, Date.now()]);
  }
  const now = Date.now(); const resource = "https://gateway.example.test/api/v1/mcp/mcs_old";
  await run(`INSERT INTO users (id,email,created_at) VALUES ('u','upgrade@example.test',?)`, [now]);
  await run(`INSERT INTO cli_sessions (id,user_id,status,created_at,last_seen_at) VALUES ('s','u','live',?,?)`, [now, now]);
  await run(`INSERT INTO mcp_shares (id,session_id,user_id,scopes,status,created_at,expires_at) VALUES ('mcs_old','s','u','sessions:read sessions:control','active',?,?)`, [now, now + 600000]);
  await run(`INSERT INTO mcp_oauth_clients (client_id,client_name,redirect_uris,created_at) VALUES ('client','Fixture','["https://client.example.test/cb"]',?)`, [now]);
  for (const [raw, type] of [["old-access", "access"], ["old-refresh", "refresh"]]) {
    await run(`INSERT INTO mcp_oauth_tokens (token_hash,token_type,user_id,client_id,scope,resource,session_id,created_at,expires_at) VALUES (?,?,'u','client','sessions:read sessions:control',?,'s',?,?)`, [sha256(raw), type, resource, now, now + 600000]);
  }
  await run(`INSERT INTO mcp_oauth_tokens (token_hash,token_type,user_id,client_id,scope,resource,session_id,created_at,expires_at,revoked_at) VALUES (?,'refresh','u','client','sessions:read sessions:control',?,'s',?,?,?)`,
    [sha256("older-consumed-refresh"), resource, now - 1000, now + 600000, now - 500]);
  await run(`INSERT INTO session_commands (id,session_id,body,status,created_at) VALUES ('plain','s','fixture','queued',?)`, [now]);
  const { migrate } = await import("../src/migrate.mjs");
  await migrate();
  await migrate(); // A restart applies no ALTER twice.
  const { accessForToken, requireMcpShareAccess, rotateRefreshToken, MCP_SHARE_SCOPES } = await import("../src/lib/mcp-auth.mjs");
  const access = await accessForToken("old-access", resource);
  assert.deepEqual(access.scope.split(" "), MCP_SHARE_SCOPES);
  assert.equal((await get(`SELECT family_id FROM mcp_oauth_tokens WHERE token_hash=?`, [sha256("old-refresh")])).family_id, access.family_id);
  assert.equal((await get(`SELECT mcp_share_id FROM session_commands WHERE id='plain'`)).mcp_share_id, null);
  let accepted = false;
  await requireMcpShareAccess({ params: { shareId: "mcs_old" }, get: (name) => name === "authorization" ? "Bearer old-access" : undefined },
    { set() { return this; }, status() { return this; }, json() { throw new Error("existing consent was lost"); } }, () => { accepted = true; });
  assert.equal(accepted, true);
  const rotated = await rotateRefreshToken({ refreshToken: "old-refresh", clientId: "client", resource });
  assert.ok(await accessForToken(rotated.access_token, resource));
  await assert.rejects(rotateRefreshToken({ refreshToken: "older-consumed-refresh", clientId: "client", resource }), /already used/);
  assert.equal(await accessForToken(rotated.access_token, resource), null);
  assert.equal(await accessForToken("old-access", resource), null);
});
