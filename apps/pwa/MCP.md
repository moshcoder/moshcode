# Remote session MCP

The canonical resource is `https://moshcode.sh/api/v1/mcp/<opaque-share-id>`.
OAuth remains on `https://app.moshcode.sh`. The front door must proxy the share
endpoint, owner share-management endpoints, and per-share protected-resource
metadata without changing resource identifiers. `MCP_PUBLIC_ORIGIN` controls the
share host; `PUBLIC_ORIGIN` remains the existing account and OAuth authority.

New shares default to `sessions:read`. Request additional permissions explicitly:

| Scope | Bound-share tools |
| --- | --- |
| `sessions:read` | `session_read` |
| `sessions:write` | `session_send`, `session_answer` |
| `sessions:approve` | `session_approve` (`approve` or `deny` only) |
| `sessions:cancel` | `session_cancel` |

Write, approval and cancellation also include read access. A share automatically
binds tools to its session; a conflicting `session_id` is rejected. Legacy
`moshcode_session_*` aliases remain accepted, while `/mcp` retains its old tool
names and `sessions:control` compatibility. Broad control is rejected for new
share grants. Migration 022 converts existing share control consent to the
same explicit permissions. Existing tokens for the same owner, client, resource
and session are grouped conservatively for replay revocation because previous
rotations did not preserve token lineage.

These are terminal operations. Write access can type any bounded line, including
an answer to a confirmation. Separate tool scopes do not turn raw terminal bytes
into prompt-specific authorization. Approval queues `yes` or `no`; it does not
claim to identify or correlate a particular engine confirmation. Input is
limited to 50 lines of 500 characters each, with terminal control bytes rejected.

OAuth code grants require S256 PKCE, the registered redirect, the registered
client and the exact resource. Authorization codes are single-use. Device and
refresh token requests must repeat the exact share `resource`; device polls honor
the advertised interval and increase it by five seconds after `slow_down`.
Only the session owner can consent, through the existing authenticated,
CSRF-protected browser flow. Device secrets are stored hashed. Device flows
started before the storage upgrade should be restarted after deployment.

Access tokens last at most one hour and never outlive the share. Refresh tokens
rotate; replay revokes the entire authorization grant, including replacement
access/refresh tokens. `POST /oauth/revoke` accepts `token` and `client_id` and
revokes that grant without revealing whether an unknown token existed. Share
revocation and expiry invalidate all access and further token issuance.

Queued actions carry share provenance. The CLI's atomic queue claim rechecks the
share's owner, session, expiry and revocation. Revocation cancels still-queued
actions; an action already claimed by the CLI may finish. Revocation cannot
recall input already delivered to a terminal. The queue's `{id, body}` wire
format is unchanged.

`mcp_audit_events` records identities, fixed action names, outcomes and time.
Command/answer text, terminal output and credentials are absent from audit rows.
The operational command queue and output mirror still contain the content they
must deliver; they are not audit storage.

The HTTP transport uses JSON responses to authenticated POST requests. GET
performs OAuth discovery/challenge and returns 405 for an authenticated client
because the server does not offer a standalone SSE stream. Metadata and machine
preflight responses support CORS; an authenticated browser MCP request must have
a configured origin or one of that OAuth client's registered redirect origins.
Unknown protocol versions and tool calls disguised as notifications are rejected.

Validation uses isolated local databases and HTTP servers, including ownership,
CSRF, scope separation, exact binding, replay, concurrency, queue revocation,
audit exclusions and an upgrade from the previous database schema:

```sh
cd apps/pwa
node --test test/mcp-*.test.mjs
```

References: [MCP authorization and resource binding](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization),
[RFC 8628 device polling](https://www.rfc-editor.org/rfc/rfc8628.html#section-3.5),
[RFC 9700 refresh-token protection](https://www.rfc-editor.org/rfc/rfc9700.html#section-4.14).
