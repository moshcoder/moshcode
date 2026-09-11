// OAuth endpoints used by remote MCP clients.
//
// Machine routes are mounted before the browser CSRF guard; the authorization
// page is mounted after it, so user approval is protected by the same cookie +
// double-submit CSRF discipline as the rest of the PWA.
import { Router } from "express";
import { config } from "../config.mjs";
import { page, esc } from "../lib/html.mjs";
import { csrfInput, requireAuth } from "../lib/session.mjs";
import {
  MCP_RESOURCE,
  MCP_SCOPES,
  activeMcpShare,
  createAuthorizationCode,
  createMcpDeviceAuthorization,
  exchangeAuthorizationCode,
  exchangeMcpDeviceCode,
  mcpShareResource,
  normalizeScopes,
  registerOAuthClient,
  rotateRefreshToken,
  sessionsForAuthorization,
  userOwnsSession,
  validateAuthorizationRequest,
} from "../lib/mcp-auth.mjs";

export const mcpOAuthMachineRouter = Router();
export const mcpOAuthBrowserRouter = Router();
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

const AS_METADATA = () => ({
  issuer: config.origin,
  authorization_endpoint: `${config.origin}/oauth/authorize`,
  token_endpoint: `${config.origin}/oauth/token`,
  device_authorization_endpoint: `${config.origin}/oauth/device_authorization`,
  registration_endpoint: `${config.origin}/oauth/register`,
  response_types_supported: ["code"],
  response_modes_supported: ["query"],
  grant_types_supported: ["authorization_code", "refresh_token", DEVICE_GRANT],
  token_endpoint_auth_methods_supported: ["none"],
  code_challenge_methods_supported: ["S256"],
  scopes_supported: MCP_SCOPES,
  // DCR remains supported by MCP 2026-07-28 for compatibility. We advertise
  // CIMD false until the server has a fetcher that can pin DNS and safely
  // retrieve arbitrary client metadata without opening an SSRF surface.
  client_id_metadata_document_supported: false,
});

const RESOURCE_METADATA = () => ({
  resource: MCP_RESOURCE,
  authorization_servers: [config.origin],
  scopes_supported: MCP_SCOPES,
  bearer_methods_supported: ["header"],
  resource_name: "Moshcode live sessions",
});

mcpOAuthMachineRouter.get("/.well-known/oauth-authorization-server", (_req, res) =>
  res.json(AS_METADATA()));
mcpOAuthMachineRouter.get("/.well-known/oauth-protected-resource", (_req, res) =>
  res.json(RESOURCE_METADATA()));
mcpOAuthMachineRouter.get("/.well-known/oauth-protected-resource/mcp", (_req, res) =>
  res.json(RESOURCE_METADATA()));
mcpOAuthMachineRouter.get("/.well-known/oauth-protected-resource/api/v1/mcp/:shareId", async (req, res) => {
  const share = await activeMcpShare(req.params.shareId);
  if (!share) return res.status(404).json({ error: "no such active session share" });
  res.json({
    resource: mcpShareResource(share.id),
    authorization_servers: [config.origin],
    scopes_supported: String(share.scopes).split(/\s+/).filter(Boolean),
    bearer_methods_supported: ["header"],
    resource_name: share.name || share.session_name || "Moshcode session",
  });
});

mcpOAuthMachineRouter.post("/oauth/register", async (req, res) => {
  try {
    const client = await registerOAuthClient(req.body || {});
    res.status(201).json({
      client_id: client.client_id,
      client_name: client.client_name,
      redirect_uris: client.redirect_uris,
      application_type: client.application_type,
      client_uri: client.client_uri || undefined,
      grant_types: ["authorization_code", "refresh_token", DEVICE_GRANT],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
  } catch (error) {
    res.status(400).json({
      error: "invalid_client_metadata",
      error_description: error.message,
    });
  }
});

mcpOAuthMachineRouter.post("/oauth/device_authorization", async (req, res) => {
  try {
    const device = await createMcpDeviceAuthorization({
      clientId: req.body?.client_id,
      resource: req.body?.resource,
      scope: req.body?.scope,
    });
    res.set("Cache-Control", "no-store").json({
      device_code: device.deviceCode,
      user_code: device.userCode,
      verification_uri: `${config.origin}/device`,
      verification_uri_complete: `${config.origin}/device?code=${encodeURIComponent(device.userCode)}`,
      expires_in: device.expiresIn,
      interval: device.interval,
    });
  } catch (error) {
    res.status(400).json({ error: "invalid_request", error_description: error.message });
  }
});

mcpOAuthMachineRouter.post("/oauth/token", async (req, res) => {
  res.set("Cache-Control", "no-store");
  const grant = String(req.body?.grant_type || "");
  try {
    if (grant === DEVICE_GRANT) {
      const tokens = await exchangeMcpDeviceCode({
        deviceCode: req.body?.device_code,
        clientId: req.body?.client_id,
      });
      return res.json(tokens);
    }
    if (grant === "authorization_code") {
      const tokens = await exchangeAuthorizationCode({
        code: req.body?.code,
        clientId: req.body?.client_id,
        redirectUri: req.body?.redirect_uri,
        verifier: req.body?.code_verifier,
        resource: req.body?.resource || MCP_RESOURCE,
      });
      return res.json(tokens);
    }
    if (grant === "refresh_token") {
      const tokens = await rotateRefreshToken({
        refreshToken: req.body?.refresh_token,
        clientId: req.body?.client_id,
      });
      return res.json(tokens);
    }
    return res.status(400).json({
      error: "unsupported_grant_type",
      error_description: "Use authorization_code, refresh_token, or the device-code grant.",
    });
  } catch (error) {
    return res.status(400).json({
      error: error.oauthError || "invalid_grant",
      error_description: error.message,
    });
  }
});

function authRedirect(redirectUri, values) {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(values)) {
    if (value !== "" && value != null) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function describeScope(scope) {
  if (scope === "sessions:read") return "See your Moshcode sessions and read mirrored terminal output.";
  if (scope === "sessions:control") return "Queue commands or supported key presses into the selected live session.";
  return scope;
}

mcpOAuthBrowserRouter.get("/oauth/authorize", requireAuth, async (req, res) => {
  try {
    const auth = await validateAuthorizationRequest(req.query);
    if (auth.share && auth.share.user_id !== req.user.id) throw new Error("that session share belongs to another account");
    const sessions = auth.share ? [{
      id: auth.share.session_id,
      name: auth.share.name || auth.share.session_name,
      cwd: auth.share.cwd,
    }] : await sessionsForAuthorization(req.user.id);
    const scopeRows = auth.scopes.map((scope) =>
      `<li><b>${esc(scope)}</b><br><span class="dim">${esc(describeScope(scope))}</span></li>`
    ).join("");
    const sessionRows = sessions.map((s, index) => {
      const label = [s.name || "mosh", s.host, s.cwd].filter(Boolean).join(" · ");
      return `<label class="session-option">
        <input type="radio" name="session_id" value="${esc(s.id)}"${index === 0 ? " checked" : ""}>
        <span><b>${esc(label)}</b><br><span class="dim">${esc(s.id)}</span></span>
      </label>`;
    }).join("");

    res.type("html").send(page({
      title: "Authorize MCP · moshcode",
      head: `<style>
        .oauth{max-width:720px;margin:8vh auto;padding:0 20px}
        .oauth-card{border:1px solid #29301f;border-radius:12px;padding:22px;background:#0b0d09}
        .scope-list{padding-left:20px;line-height:1.4}.scope-list li{margin:10px 0}
        .sessions{max-height:280px;overflow:auto;border:1px solid #23291d;border-radius:8px;margin:12px 0}
        .session-option{display:flex;gap:10px;padding:11px;border-bottom:1px solid #1b2017;cursor:pointer}
        .session-option:last-child{border-bottom:0}.session-option input{margin-top:4px}
        .actions{display:flex;gap:10px;margin-top:18px}.actions button{padding:10px 16px}
        .danger{background:transparent;color:#ff668f;border:1px solid #5b2635}
        .dim{opacity:.65;font-size:.85em}.mono{font-family:ui-monospace,monospace}
      </style>`,
      body: `<main class="oauth">
        <div class="oauth-card">
          <div class="mono dim">REMOTE MCP</div>
          <h1>Let ${esc(auth.client.client_name)} use Moshcode?</h1>
          <p>This client is asking to connect to <b>${esc(auth.resource)}</b> as ${esc(req.user.email || req.user.display_name || "you")}.</p>
          <h3>Permissions</h3>
          <ul class="scope-list">${scopeRows}</ul>
          <h3>Session access</h3>
          <p class="dim">${auth.share ? "This URL is bound to the named session." : "Bind this authorization to one session for least privilege, or allow all of your sessions."}</p>
          <form method="post" action="/oauth/authorize">
            ${csrfInput(req)}
            <input type="hidden" name="client_id" value="${esc(auth.clientId)}">
            <input type="hidden" name="redirect_uri" value="${esc(auth.redirectUri)}">
            <input type="hidden" name="response_type" value="code">
            <input type="hidden" name="code_challenge" value="${esc(auth.codeChallenge)}">
            <input type="hidden" name="code_challenge_method" value="S256">
            <input type="hidden" name="resource" value="${esc(auth.resource)}">
            <input type="hidden" name="scope" value="${esc(auth.scope)}">
            <input type="hidden" name="state" value="${esc(auth.state)}">
            <div class="sessions">
              ${auth.share ? "" : `<label class="session-option">
                <input type="radio" name="session_id" value=""${sessions.length ? "" : " checked"}>
                <span><b>All my Moshcode sessions</b><br><span class="dim">Current and future sessions until this authorization expires or is revoked.</span></span>
              </label>`}
              ${sessionRows || `<div class="session-option dim">No mirrored sessions yet. You can still authorize all sessions and start one later.</div>`}
            </div>
            <div class="actions">
              <button type="submit" name="decision" value="allow">Allow</button>
              <button type="submit" name="decision" value="deny" class="danger">Deny</button>
            </div>
          </form>
        </div>
      </main>`,
    }));
  } catch (error) {
    res.status(400).type("html").send(page({
      title: "OAuth error · moshcode",
      body: `<main style="max-width:720px;margin:12vh auto;padding:20px"><h1>Could not authorize that MCP client.</h1><p>${esc(error.message)}</p></main>`,
    }));
  }
});

mcpOAuthBrowserRouter.post("/oauth/authorize", requireAuth, async (req, res) => {
  let auth;
  try {
    auth = await validateAuthorizationRequest(req.body || {});
  } catch (error) {
    return res.status(400).type("text").send(`invalid authorization request: ${error.message}\n`);
  }

  if (req.body?.decision !== "allow") {
    return res.redirect(authRedirect(auth.redirectUri, {
      error: "access_denied",
      state: auth.state,
      iss: config.origin,
    }));
  }

  if (auth.share && auth.share.user_id !== req.user.id) {
    return res.status(400).type("text").send("That session share does not belong to this account.\n");
  }
  const sessionId = auth.share?.session_id || String(req.body?.session_id || "").trim() || null;
  if (sessionId && !(await userOwnsSession(req.user.id, sessionId))) {
    return res.status(400).type("text").send("That session does not belong to this account.\n");
  }

  const code = await createAuthorizationCode({
    userId: req.user.id,
    clientId: auth.clientId,
    redirectUri: auth.redirectUri,
    scope: normalizeScopes(auth.scope).join(" "),
    resource: auth.resource,
    sessionId,
    codeChallenge: auth.codeChallenge,
  });

  return res.redirect(authRedirect(auth.redirectUri, {
    code,
    state: auth.state,
    iss: config.origin,
  }));
});
