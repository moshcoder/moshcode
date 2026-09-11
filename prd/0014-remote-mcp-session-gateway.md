---
openprd: "0.3"
id: "0014"
title: "Expose live Moshcode sessions over remote MCP"
status: Draft
authors:
  - ralyodio
created: 2026-09-11
updated: 2026-09-11
repo: https://github.com/moshcoder/moshcode
discussion:
implementation: feat/0014-remote-mcp-session-gateway
tags:
  - mcp
  - oauth
  - sessions
  - agents
supersedes:
superseded-by:
---

## Problem

Moshcode already provides a live browser mirror of a running CLI session: the CLI registers itself with app.moshcode.sh, streams terminal output, and drains a server-side command queue. That makes remote human control possible, but external AI clients such as ChatGPT, Codex, Claude, and other MCP-capable agents cannot securely attach to that same session through a standard protocol.

Without a standard AI-facing endpoint, every client would need a custom integration or would have to drive the browser UI. Sharing a permanent Moshcode API key or SSH credential with an AI client would also grant far more authority than is necessary and would make revocation, session scoping, and auditability difficult.

The product opportunity is to make Moshcode the persistent development environment and MCP the interoperable control plane: connect an AI once, authorize only the session capabilities it needs, then let it observe and operate the same live Moshcode session the user can see in the browser.

## Goals

- Let standards-compatible remote MCP clients connect to a public Moshcode MCP endpoint.
- Reuse the existing live CLI session mirror and command queue rather than inventing a second shell/session transport.
- Let a user explicitly authorize an MCP client with OAuth Authorization Code + PKCE.
- Issue short-lived access tokens and rotating refresh tokens instead of exposing Moshcode CLI API keys.
- Support least-privilege authorization with separate read/control scopes and optional binding to one Moshcode session.
- Let an authorized client list sessions, read sequenced terminal output, queue commands, and send already-supported navigation key presses.
- Support the current MCP `2026-07-28` stateless lifecycle while remaining usable by handshake-era 2025 MCP clients.
- Keep the MCP server stateless at the protocol layer; persistent state is represented by the existing explicit Moshcode `session_id`.

## Non-Goals

- Replacing the existing Moshcode CLI, browser session mirror, or CLI authentication mechanism.
- Giving MCP clients direct SSH credentials, sudo access, host secrets, environment variables, or arbitrary infrastructure-admin APIs.
- Creating a second PTY/session broker separate from the current Moshcode session mirror.
- Exposing filesystem and Git APIs in v1; an authorized client can operate the existing Moshcode prompt, and dedicated structured tools can be added later.
- Automatically approving high-impact commands on behalf of the user or bypassing client-side tool confirmation policies.
- Supporting legacy HTTP+SSE as a primary transport; HTTP POST is the supported remote MCP transport.
- Enabling Client ID Metadata Documents (CIMD) until Moshcode has a hardened metadata fetcher that cannot be abused for SSRF. Dynamic Client Registration remains the compatibility path for v1.
- Refactoring the PWA database or session subsystem as part of this feature.

## Users

- Moshcode users who want ChatGPT, Codex, Claude, or another MCP-capable agent to work inside a live Moshcode development session.
- Developers who use multiple AI clients and want one interoperable authorization/control surface rather than client-specific integrations.
- Teams that need an auditable, revocable alternative to sharing SSH credentials or permanent API keys with AI tooling.
- Moshcode itself, as a platform: MCP turns an existing remote session mirror into a reusable agent runtime surface.

## Requirements

- R1 [P0] Expose a remote MCP endpoint at `${PUBLIC_ORIGIN}/mcp`.
- R2 [P0] Require bearer authorization for every MCP tool/discovery request other than OAuth metadata and registration.
- R3 [P0] Publish OAuth Authorization Server Metadata and OAuth Protected Resource Metadata using `.well-known` endpoints.
- R4 [P0] Support OAuth Dynamic Client Registration for public clients with exact redirect URI validation and no client secret.
- R5 [P0] Support Authorization Code with PKCE S256. Authorization codes MUST be single-use, short-lived, and stored only as hashes.
- R6 [P0] Issue short-lived access tokens and rotating refresh tokens. Tokens MUST be stored only as hashes and bound to the Moshcode MCP resource.
- R7 [P0] Support `sessions:read` and `sessions:control` scopes. Control implies read.
- R8 [P0] Present a logged-in consent screen that shows requested scopes and lets the user authorize all sessions or bind the grant to one owned Moshcode session.
- R9 [P0] Enforce session binding on every session tool server-side, not only in tool descriptions or UI.
- R10 [P0] Implement `moshcode_sessions_list` as a read-only MCP tool.
- R11 [P0] Implement `moshcode_session_read` using the existing monotonically sequenced `session_output` rows and an `after_seq` cursor.
- R12 [P0] Implement `moshcode_session_send` using the existing `session_commands` queue. Multi-line text MUST preserve order and inherit the browser mirror's command count/length limits.
- R13 [P0] Implement `moshcode_session_key` only for the navigation keys already declared by the CLI's `keys` feature.
- R14 [P0] Advertise MCP tool annotations so hosts can distinguish read-only tools from session-modifying tools.
- R15 [P0] Support MCP protocol `2026-07-28`, including `server/discover`, stateless per-request operation, `resultType`, private cache hints, and server identity metadata.
- R16 [P0] Support 2025 handshake-era clients for `initialize`, `notifications/initialized`, `tools/list`, `tools/call`, and `ping`.
- R17 [P0] Return a standards-compatible `WWW-Authenticate` challenge when an MCP access token is missing/invalid and an insufficient-scope challenge when a control tool needs more scope.
- R18 [P0] Keep machine OAuth/MCP endpoints outside browser CSRF enforcement while keeping `/oauth/authorize` behind the existing login + CSRF protections.
- R19 [P0] Add database migrations for OAuth clients, authorization codes, access tokens, and refresh tokens with user/client/session foreign keys.
- R20 [P0] Add integration tests for bearer challenges, PKCE/token issuance, scoped tool discovery, session-bound access, and command queue insertion.
- R21 [P1] Add a revocation UI/API showing connected MCP clients, granted scopes, session binding, last use, and a one-click revoke action.
- R22 [P1] Add hardened Client ID Metadata Document support and advertise `client_id_metadata_document_supported: true`.
- R23 [P1] Move session command wake/fan-out to a shared or cross-instance signal so MCP-queued commands wake an already-parked CLI long-poll immediately on every deployment topology.
- R24 [P1] Add an explicit interrupt/control capability once the CLI advertises and safely decodes Ctrl-C as a negotiated session feature.
- R25 [P2] Add structured Git/filesystem tools only when they can reuse Moshcode's permission model and provide a narrower authority than raw terminal commands.
- R26 [P0] Let a live CLI mint an opaque, expiring endpoint at `https://moshcode.sh/api/v1/mcp/<share-id>` that is permanently bound to one owned session.
- R27 [P0] Support RFC 8628 device authorization for MCP clients that cannot receive a browser redirect.
- R28 [P0] Add `/mcp answer`, `/mcp status`, and `/mcp revoke` operator commands for creating, inspecting, and revoking session shares.
- R29 [P0] Add answer, approval, and interrupt tools; interrupts MUST require the CLI to advertise the negotiated `signals` feature.

## UX Notes

The connection flow should feel like connecting any other account-backed tool:

1. The MCP client discovers `https://app.moshcode.sh/mcp`, receives the protected-resource challenge, and discovers the Moshcode authorization server.
2. The client dynamically registers its exact redirect URI and starts an OAuth authorization-code + PKCE flow.
3. Moshcode requires the user to be signed in, then shows the client name, requested permissions, the MCP resource, and session-access choices.
4. The user can authorize all sessions or one named live/recent session. One-session authorization should be the recommended least-privilege option when the user knows which workspace the agent needs.
5. After approval, the client receives the authorization code and exchanges it for an access + refresh token pair.
6. The agent calls `moshcode_sessions_list`, then `moshcode_session_read`, then a control tool only when needed.
7. Incremental reads use `after_seq`/`next_seq`; agents should not repeatedly request the full scrollback.
8. Sending a command means exactly what it does in the existing web mirror: text is queued into the live Moshcode prompt. The tool description must not pretend it is a sandbox.
9. If a token is bound to one session, other session ids should behave as inaccessible even if they belong to the same user.
10. Write/control tools should be surfaced to clients with non-read-only annotations so host confirmation policies can protect consequential operations.

The server should refer to the public endpoint using `PUBLIC_ORIGIN`; production is expected to expose the PWA at `https://app.moshcode.sh`.

## Tech Stack

- Existing `apps/pwa` Express application on Node.js 20+.
- Existing libSQL database helper and numbered SQL migration system.
- Existing cookie login/session + CSRF middleware for the browser consent flow.
- Existing `cli_sessions`, `session_output`, and `session_commands` tables as the runtime/session substrate.
- OAuth Authorization Code + PKCE S256 implemented with Node's built-in crypto helpers; no permanent MCP client secrets.
- OAuth Dynamic Client Registration in v1 for cross-client compatibility.
- Stateless HTTP Model Context Protocol implementation supporting current `2026-07-28` plus a 2025 compatibility path.
- No new runtime dependency is required for the v1 implementation; the wire surface is intentionally small (`server/discover`, initialize compatibility, tools list/call, ping).
- Railway remains the production application host; no separate MCP service is required for v1.

## Monetization

_None for v1._

Remote MCP session access is a platform capability that makes Moshcode more useful and more interoperable. Future paid plans may place limits on concurrent remote sessions, organization policy, audit retention, or advanced structured tools, but authorization or baseline interoperability must not be artificially weakened to force an upgrade.

## Success Metrics

- A standards-compatible remote MCP client can complete discovery, OAuth, tool scan, session listing, and an incremental session read without manual API-key copying.
- A control-scoped client can queue a command that the existing Moshcode CLI consumes without a new CLI transport.
- A read-only token cannot discover or invoke control tools.
- A token bound to one session cannot list/read/control another session.
- Authorization-code replay and refresh-token replay do not mint additional valid credentials.
- Access tokens expire automatically and refresh tokens rotate.
- The existing `/sessions` browser mirror and CLI auth flows continue passing their tests unchanged.
- At least one external MCP host can connect end-to-end to the deployed endpoint after merge.
- No SSH credential, Moshcode CLI API key, or server secret is revealed to the MCP client.

## Risks & Open Questions

- **MCP host product limits:** ChatGPT plan/workspace support for write-capable custom MCP apps is controlled by OpenAI and can differ from Codex/API/other MCP hosts. The server should remain standards-based rather than special-casing one host.
- **DCR lifecycle:** MCP 2026-07-28 deprecates Dynamic Client Registration in favor of CIMD, but DCR remains a compatibility path. Hardened CIMD support is P1 because naively fetching arbitrary client metadata URLs creates an SSRF risk.
- **Command delivery wake-up:** the current session mirror wakes long-polls through an in-process map. A command inserted by another app instance—or by this v1 MCP route without access to that private map—can wait until the existing long-poll timeout. R23 should move wake signaling behind a shared session-control primitive or cross-instance signal.
- **Raw terminal authority:** `moshcode_session_send` can run whatever the Moshcode prompt itself permits. OAuth/session scoping reduces credential blast radius but does not make dangerous shell commands safe; MCP hosts should continue applying confirmation policies.
- **Revocation UX:** v1 tokens can expire/rotate but users need a first-class connected-clients page before this should be marketed as an organization-management feature.
- **Audit:** the existing command queue records queued commands and timestamps, but a dedicated OAuth-client/audit attribution field may be desirable so a human can distinguish browser commands from individual MCP clients.
- **Database direction:** this PRD intentionally uses the repository's current persistence layer and does not bundle a database migration/replatforming project into MCP.
