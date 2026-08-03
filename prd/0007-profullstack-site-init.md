---
openprd: "0.2"
id: "0007"
title: "Generate batteries-included Profullstack sites for Moshpit names"
status: Draft
authors:
  - anthony@profullstack.com
created: 2026-08-03
updated: 2026-08-03
repo: https://github.com/moshcoder/moshcode
discussion:
implementation:
tags:
  - moshpit
  - profullstack
  - template
  - site-init
  - bun
  - solidstart
  - turso
  - sqlite
  - coinpay
  - oauth
  - blog
  - rss
supersedes:
superseded-by:
---

## Problem

Moshcode can currently copy basic hosting templates and install web-server configuration for a Moshpit name, but a copied template is not yet a complete application. A developer still has to choose and wire a frontend framework, SSR, client navigation, an API, a database, authentication, migrations, blog routes, RSS, scheduling, deployment units, and secrets.

That work is repetitive and prevents a newly claimed Moshpit name from becoming a useful site immediately.

The Moshpit network also has unusual hosting constraints:

- Moshpit names are outside the public DNS root.
- Resolver-based visitors normally reach a name over plain HTTP.
- The public gateway strips cookies and `Authorization`.
- Pin-verified TLS is available only to Moshpit-aware clients and currently requires nginx.
- A normal OAuth callback and durable browser session therefore cannot safely depend on the plain Moshpit origin or the public gateway.

Moshcode needs a trusted, batteries-included application initializer that preserves the existing safety rule that arbitrary templates are copied but never executed.

## Goals

1. Let a user turn a claimed Moshpit name into a working full-stack application with one guided command.
2. Generate one isomorphic TypeScript application whose route and component code is reused for initial SSR and subsequent SPA navigation.
3. Include a complete versioned JSON API, CoinPay OAuth/OIDC login, durable sessions, role-based blog administration, API tokens, a blog, and an RSS feed.
4. Use Bun for the generated application and SolidStart/SolidJS for SSR, hydration, routing, and shared UI code.
5. Use the same application data layer against either a local SQLite-compatible file or a hosted Turso libSQL database.
6. Prefer hosted Turso automatically when the Turso CLI is installed and authenticated; otherwise use local SQLite without blocking setup.
7. Make the blog optional but enabled by default.
8. Make the auto-blog pipeline optional but enabled by default, while avoiding surprise paid AI usage.
9. Preserve the existing `moshcode template install` no-execution security boundary.
10. Produce a deterministic, testable, resumable installer suitable for humans, CI, and coding agents.

## Non-Goals

- Replacing `moshcode template install` with executable third-party templates.
- Building a general plugin marketplace or arbitrary template hook system.
- Making ordinary browsers trust Moshpit pin-verified TLS without a Moshpit-aware client.
- Using the public Moshpit gateway for authenticated sessions or write APIs.
- Providing local username/password authentication in v1.
- Shipping a general-purpose CMS comparable to WordPress.
- Adding a heavyweight ORM, separate backend project, separate frontend project, monorepo, React, Next.js, HTMX, or Hono JSX.
- Automatically purchasing or configuring a public DNS domain.
- Automatically spending money on an AI model.
- Supporting multi-region active-active writes to one local SQLite file.
- Solving every deployment target in v1; the supported host is a Linux server using systemd plus nginx or Caddy.

## Users

### Primary user: Moshpit name owner

A developer who has claimed a name such as `foo.whatever` and wants a real application rather than a static placeholder.

### Secondary user: Coding agent

An automated coding engine that needs a predictable project layout, explicit configuration, stable API contracts, migrations, tests, and clear acceptance criteria.

### Secondary user: Site visitor

A person using a Moshpit resolver, the public gateway, or the site's separate secure public origin to read pages and blog posts.

### Secondary user: Site administrator

The verified CoinPay user authorized to create, edit, schedule, publish, and delete blog posts and run the auto-blog pipeline.

## Product Decision

The bundled starter is named **`profullstack`**.

Two existing concepts remain distinct:

1. `moshcode template install profullstack` copies files only. It never executes template code, installs packages, provisions a database, contacts CoinPay, writes secrets, changes system configuration, or starts services.
2. `moshcode site init <name>` is a trusted workflow implemented inside Moshcode. It copies the bundled `profullstack` template and performs explicitly approved provisioning steps.

The existing `moshcode site <name>` behavior remains backward compatible and continues to plan or install web-server configuration.

## Requirements

### Command and compatibility

- **R1 [P0]** Add `moshcode site init <name>` as the guided application initializer.
- **R2 [P0]** Preserve the existing behavior of `moshcode site <name>`, `moshcode site <name> --install`, and all existing `site` flags.
- **R3 [P0]** Add `profullstack` to `examples/templates/` and to `moshcode template list`.
- **R4 [P0]** Keep `moshcode template install profullstack` copy-only. No file copied from any template may be executed by the installer.
- **R5 [P0]** Implement provisioning in trusted Moshcode source code, not in a `postinstall`, shell hook, package script, or executable template manifest.
- **R6 [P0]** Support interactive TTY use and deterministic non-interactive use.
- **R7 [P0]** Support `--dry-run`; it must display file operations, external commands, configuration choices, and privileged changes without writing files, creating cloud resources, registering OAuth clients, installing dependencies, or changing services.
- **R8 [P0]** Support `--json` for machine-readable results. JSON mode must write no human commentary to stdout.
- **R9 [P0]** Detect conflicts before writing any project files. Without `--force`, any conflict aborts the file-copy phase before changes are made.
- **R10 [P0]** Write a non-secret `.moshcode/site.json` state file so interrupted setup can be inspected and safely resumed.
- **R11 [P1]** Add `moshcode site init <name> --resume` and make plain re-execution detect and offer to resume an incomplete initialization.
- **R12 [P1]** Add shell completion and CLI schema entries for every new command and option.

### CLI contract

The initializer must accept:

```text
moshcode site init <name>

  --into <directory>
  --template <name>              default: profullstack
  --db auto|turso|sqlite         default: auto
  --turso-db <database-name>
  --turso-group <group-name>
  --auth coinpay|none            default: coinpay
  --auth-origin <https-url>
  --owner-email <email>
  --blog | --no-blog             default: --blog
  --autoblog | --no-autoblog     default: --autoblog
  --autoblog-source <source>     repeatable: queue, release, ai
  --port <1-65535>               default: 3000
  --install                      permit package install and system changes
  --reload                       reload/enable services after installation
  --tls                          request existing Moshpit pin-TLS support
  --yes, -y                      accept safe prompts
  --force                        overwrite conflicting project files
  --dry-run
  --json
```

Rules:

- **R13 [P0]** `--yes` may accept safe application defaults but must not imply `--install`, `--reload`, OAuth client registration, cloud resource creation after an explicit failure, or destructive cleanup.
- **R14 [P0]** `--install` authorizes dependency installation and system-file writes but does not imply `--reload`.
- **R15 [P0]** `--reload` requires `--install`.
- **R16 [P0]** In a non-TTY, every value that cannot be derived safely must come from a flag or environment variable. The command must fail with a precise missing-input error rather than hang.
- **R17 [P0]** Secrets must never appear in command output, dry-run output, JSON output, process titles, or `.moshcode/site.json`.

### Generated application stack

- **R18 [P0]** The generated runtime and package manager are Bun.
- **R19 [P0]** The generated web framework is SolidStart with SolidJS and Solid Router.
- **R20 [P0]** Initial page requests are server rendered.
- **R21 [P0]** The browser hydrates the same TSX routes and components and performs subsequent internal navigation as an SPA.
- **R22 [P0]** Shared UI code must not be duplicated into separate SSR and SPA implementations.
- **R23 [P0]** Database, OAuth, session, secret, scheduler, and privileged mutation code must remain server-only.
- **R24 [P0]** SolidStart server functions and shared domain modules are used for application UI data access; SSR routes must not make HTTP calls back into their own public API.
- **R25 [P0]** Public API routes and UI server functions must call the same server-side service layer.
- **R26 [P0]** The generated project uses strict TypeScript and includes a no-emit typecheck command.
- **R27 [P0]** Exact tested dependency versions are committed in `bun.lock`. No prerelease framework version is selected automatically.
- **R28 [P0]** The app binds to `127.0.0.1` by default. nginx or Caddy is the public client.
- **R29 [P0]** The app must boot with local SQLite and no external services after `bun install`, migration, and seed.

### Required project layout

The generated project must follow this minimum layout:

```text
profullstack-site/
├── src/
│   ├── app.tsx
│   ├── app.css
│   ├── components/
│   │   ├── AppShell.tsx
│   │   ├── BlogCard.tsx
│   │   ├── BlogEditor.tsx
│   │   ├── LoginButton.tsx
│   │   └── UserMenu.tsx
│   ├── domain/
│   │   ├── api.ts
│   │   ├── auth.ts
│   │   ├── posts.ts
│   │   └── validation.ts
│   ├── routes/
│   │   ├── index.tsx
│   │   ├── account.tsx
│   │   ├── login.tsx
│   │   ├── setup.tsx
│   │   ├── blog/
│   │   │   ├── index.tsx
│   │   │   ├── [slug].tsx
│   │   │   └── feed.xml.ts
│   │   ├── admin/
│   │   │   └── blog/
│   │   │       ├── index.tsx
│   │   │       └── [id].tsx
│   │   ├── auth/
│   │   │   └── coinpay/
│   │   │       ├── index.ts
│   │   │       ├── callback.ts
│   │   │       └── logout.ts
│   │   └── api/
│   │       └── v1/
│   │           ├── index.ts
│   │           ├── health.ts
│   │           ├── session.ts
│   │           ├── openapi.json.ts
│   │           ├── posts/
│   │           │   ├── index.ts
│   │           │   └── [slug].ts
│   │           ├── account/
│   │           │   └── tokens.ts
│   │           └── admin/
│   │               ├── posts.ts
│   │               └── autoblog.ts
│   └── server/
│       ├── config.ts
│       ├── db.ts
│       ├── migrate.ts
│       ├── posts.ts
│       ├── rss.ts
│       ├── security.ts
│       ├── auth/
│       │   ├── coinpay.ts
│       │   ├── oauth-transactions.ts
│       │   ├── sessions.ts
│       │   └── api-tokens.ts
│       └── autoblog/
│           ├── index.ts
│           ├── queue.ts
│           ├── release.ts
│           └── ai.ts
├── content/
│   └── queue/
├── migrations/
│   └── 0001_initial.sql
├── scripts/
│   ├── migrate.ts
│   ├── seed.ts
│   └── autoblog.ts
├── test/
├── public/
│   └── assets/
├── deploy/
│   ├── profullstack.service
│   ├── profullstack-autoblog.service
│   └── profullstack-autoblog.timer
├── .env.example
├── .gitignore
├── app.config.ts
├── bun.lock
├── Caddyfile
├── package.json
├── README.md
├── template.json
└── tsconfig.json
```

A small implementation may combine files, but it must preserve the conceptual boundaries between shared domain code, shared UI code, server-only services, public API routes, and migrations.

### Database selection and provisioning

- **R30 [P0]** Use `@libsql/client` so one data-access API works with a local SQLite-compatible file and a hosted Turso libSQL database.
- **R31 [P0]** Do not add an ORM in v1. Use parameterized raw SQL and small repository/service functions.
- **R32 [P0]** Default database mode is `auto`.
- **R33 [P0]** In `auto` mode, look for `turso` on `PATH`.
- **R34 [P0]** When the Turso CLI is present, run `turso auth whoami`.
- **R35 [P0]** When the Turso CLI is present and authenticated, offer to create or use a hosted database. The interactive default is hosted Turso.
- **R36 [P0]** When the Turso CLI is absent, unauthenticated, declined, or unavailable, `auto` mode must fall back to local SQLite and continue.
- **R37 [P0]** Explicit `--db turso` must fail on provisioning failure and must never silently switch to local SQLite.
- **R38 [P0]** Explicit `--db sqlite` must never contact Turso.
- **R39 [P0]** In a non-TTY, `--db auto` uses Turso only when the CLI is already authenticated and all required choices are deterministic; otherwise it uses local SQLite.
- **R40 [P0]** Create hosted libSQL with:

```sh
turso db create <database-name> --wait
turso db show <database-name> --url
turso db tokens create <database-name> --expiration never
```

- **R41 [P0]** If an account has multiple Turso groups and no group is supplied, prompt interactively or fail non-interactively with a list of valid choices.
- **R42 [P0]** Sanitize the Moshpit name into a valid database name and append a short stable hash when needed to avoid collisions.
- **R43 [P0]** Store hosted credentials only in `.env`, with file mode `0600`.
- **R44 [P0]** Never commit `.env`, `data/*.db`, SQLite journal/WAL files, or generated tokens.
- **R45 [P0]** Local configuration is:

```env
DATABASE_URL=file:./data/app.db
TURSO_AUTH_TOKEN=
```

- **R46 [P0]** Hosted configuration is:

```env
DATABASE_URL=libsql://<database-name>-<organization>.turso.io
TURSO_AUTH_TOKEN=<redacted>
```

- **R47 [P0]** The application creates the parent directory for a local database before opening the file.
- **R48 [P0]** The migration runner is idempotent, transactional where SQLite allows, records applied migration filename and checksum, and refuses a changed checksum for an already-applied migration.
- **R49 [P0]** If a cloud database is created and a later step fails, do not destroy it automatically. Report its name and the exact resume or cleanup command.
- **R50 [P1]** Add a documented database-token rotation procedure.

### Initial database schema

The first migration must create at least:

```text
schema_migrations
users
sessions
oauth_transactions
api_tokens
posts
autoblog_runs
settings
```

Minimum fields and constraints:

```text
schema_migrations
  filename              TEXT PRIMARY KEY
  checksum              TEXT NOT NULL
  applied_at            INTEGER NOT NULL

users
  id                    TEXT PRIMARY KEY
  coinpay_sub           TEXT NOT NULL UNIQUE
  email                 TEXT
  email_verified        INTEGER NOT NULL DEFAULT 0
  display_name          TEXT
  avatar_url            TEXT
  role                  TEXT NOT NULL DEFAULT 'user'
  created_at            INTEGER NOT NULL
  updated_at            INTEGER NOT NULL
  last_login_at         INTEGER

sessions
  id                    TEXT PRIMARY KEY
  user_id               TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
  token_hash            TEXT NOT NULL UNIQUE
  created_at            INTEGER NOT NULL
  expires_at            INTEGER NOT NULL
  last_seen_at          INTEGER NOT NULL
  user_agent_hash       TEXT
  ip_prefix_hash        TEXT

oauth_transactions
  id                    TEXT PRIMARY KEY
  state_hash            TEXT NOT NULL UNIQUE
  pkce_verifier_ciphertext TEXT NOT NULL
  return_to             TEXT NOT NULL
  created_at            INTEGER NOT NULL
  expires_at            INTEGER NOT NULL
  consumed_at           INTEGER

api_tokens
  id                    TEXT PRIMARY KEY
  user_id               TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
  name                  TEXT NOT NULL
  token_prefix          TEXT NOT NULL
  token_hash            TEXT NOT NULL UNIQUE
  scopes                TEXT NOT NULL
  created_at            INTEGER NOT NULL
  expires_at            INTEGER
  last_used_at          INTEGER
  revoked_at            INTEGER

posts
  id                    TEXT PRIMARY KEY
  slug                  TEXT NOT NULL UNIQUE
  title                 TEXT NOT NULL
  excerpt               TEXT
  body_markdown         TEXT NOT NULL
  body_html             TEXT NOT NULL
  status                TEXT NOT NULL
  source                TEXT NOT NULL
  author_user_id        TEXT REFERENCES users(id)
  scheduled_at          INTEGER
  published_at          INTEGER
  created_at            INTEGER NOT NULL
  updated_at            INTEGER NOT NULL

autoblog_runs
  id                    TEXT PRIMARY KEY
  source                TEXT NOT NULL
  status                TEXT NOT NULL
  input_ref             TEXT
  post_id               TEXT REFERENCES posts(id)
  error_code            TEXT
  error_message         TEXT
  started_at            INTEGER NOT NULL
  completed_at          INTEGER

settings
  key                   TEXT PRIMARY KEY
  value_json            TEXT NOT NULL
  updated_at            INTEGER NOT NULL
```

Required indexes:

```text
posts(status, published_at)
posts(status, scheduled_at)
sessions(expires_at)
oauth_transactions(expires_at)
api_tokens(user_id, revoked_at)
autoblog_runs(started_at)
```

Allowed role values in v1 are `owner`, `editor`, and `user`.

Allowed post states in v1 are `draft`, `scheduled`, `published`, and `archived`.

### CoinPay OAuth/OIDC

- **R51 [P0]** Authentication provider is CoinPay OAuth 2.0/OIDC authorization code flow with S256 PKCE.
- **R52 [P0]** Default scopes are `openid profile email`.
- **R53 [P1]** Optional scopes are `did` and `wallet:read`; they are never requested by default.
- **R54 [P0]** The installer supports:
  1. automatic client registration using a user-supplied CoinPay API token;
  2. entry of an existing client ID and client secret; or
  3. configure-later mode.
- **R55 [P0]** CoinPay secrets are entered without terminal echo and are written only to `.env`.
- **R56 [P0]** Automatic registration calls the authenticated CoinPay client-registration API with the final HTTPS callback URI and requested scopes.
- **R57 [P0]** If automatic registration succeeds, the client secret is persisted immediately because it may be shown only once.
- **R58 [P0]** If auth is selected but credentials are absent, the application still boots and `/api/v1/health` reports `auth.configured: false`; login UI must explain the exact missing configuration.
- **R59 [P0]** OAuth transactions contain a cryptographically random state value, a PKCE verifier, an allowed post-login return path, creation time, expiry, and single-use marker.
- **R60 [P0]** Store only a hash of the state token. Protect the PKCE verifier at rest with authenticated encryption derived from `SESSION_SECRET`.
- **R61 [P0]** OAuth transactions expire after ten minutes and are consumed atomically.
- **R62 [P0]** The callback rejects missing, expired, reused, or mismatched state before exchanging the code.
- **R63 [P0]** The authorization code exchange and UserInfo request occur only on the server.
- **R64 [P0]** The `sub` returned by the verified CoinPay identity is the stable user key. Email is not the primary key.
- **R65 [P0]** The implementation must not hand-roll JWT or JOSE verification. It must use a maintained library and the canonical CoinPay verification metadata confirmed before release.
- **R66 [P0]** Access, refresh, and ID tokens are not persisted for login-only use after identity establishment. Persist provider tokens only if a future feature explicitly needs delegated CoinPay API access.
- **R67 [P0]** Logout destroys the local session. Provider-token revocation is performed only if CoinPay exposes and documents a revocation endpoint.
- **R68 [P0]** Authentication errors return safe user messages and structured internal error codes without exposing provider responses, client secrets, codes, state, or tokens.
- **R69 [P0]** The installer asks for `OWNER_EMAIL`. The first CoinPay user whose verified email matches it is assigned `owner`.
- **R70 [P0]** If no owner email is configured, no user becomes owner automatically. The generated README must document the safe owner-bootstrap command.
- **R71 [P1]** Add a local administrative CLI script that can assign or revoke roles by CoinPay `sub` or verified email while running on the host.

#### Configurable CoinPay endpoints

Until CoinPay's public OAuth prompt and API documentation use one canonical endpoint set, the template must keep endpoint URLs configurable:

```env
COINPAY_BASE_URL=https://coinpayportal.com
COINPAY_AUTHORIZE_PATH=/api/oauth/authorize
COINPAY_TOKEN_PATH=/api/oauth/token
COINPAY_USERINFO_PATH=/api/oauth/userinfo
COINPAY_CLIENTS_PATH=/api/oauth/clients
COINPAY_JWKS_PATH=/api/oauth/jwks
```

Release is blocked until an integration test passes against the canonical production endpoint set and the chosen ID-token verification method is confirmed.

### Session and API authentication

- **R72 [P0]** Generate `SESSION_SECRET` from at least 32 cryptographically random bytes.
- **R73 [P0]** Browser sessions use an opaque random token; store only its cryptographic hash in the database.
- **R74 [P0]** On a normal CA-valid HTTPS auth origin, the session cookie is `HttpOnly`, `Secure`, `SameSite=Lax`, host-only, and uses a `__Host-` prefix.
- **R75 [P0]** Rotate the session token after login and privilege changes.
- **R76 [P0]** Default session lifetime is 30 days with idle activity tracking and server-side revocation.
- **R77 [P0]** State-changing browser requests require same-origin validation and CSRF protection appropriate to SolidStart actions.
- **R78 [P0]** User-created API tokens are prefixed, shown once, stored as hashes, scoped, revocable, and accepted only over a CA-valid HTTPS origin.
- **R79 [P0]** Default API-token scopes are read-only. Write scopes require an explicit selection.
- **R80 [P0]** Authentication middleware must distinguish browser sessions from bearer API tokens and produce a normalized internal principal.
- **R81 [P0]** Admin blog mutations require `owner` or `editor`.
- **R82 [P0]** Owner-only operations include role management, OAuth configuration status, and destructive site settings.
- **R83 [P0]** Return `401` for unauthenticated requests and `403` for authenticated principals lacking permission.

### Moshpit origin and secure auth origin

- **R84 [P0]** The generated app supports two logical origins served by the same application:

```env
MOSHPIT_ORIGIN=http://foo.whatever
AUTH_ORIGIN=https://foo.apps.example.com
PUBLIC_CANONICAL_ORIGIN=https://foo.apps.example.com
```

- **R85 [P0]** `AUTH_ORIGIN` must be a normal, CA-valid HTTPS URL for stock-browser CoinPay OAuth and authenticated sessions.
- **R86 [P0]** The plain Moshpit origin may serve public pages, public blog posts, RSS, health, and read-only API routes.
- **R87 [P0]** The plain Moshpit origin must not issue login sessions, accept bearer tokens, render account data, expose admin UI, or accept state-changing requests.
- **R88 [P0]** A login link opened on the Moshpit origin redirects to the equivalent route on `AUTH_ORIGIN`.
- **R89 [P0]** The public gateway is treated as anonymous and read-only because it strips cookies and `Authorization`.
- **R90 [P0]** Host/origin policy must be enforced on the server, not only hidden in the frontend.
- **R91 [P0]** `PUBLIC_CANONICAL_ORIGIN` supplies absolute public links in RSS, Open Graph metadata, canonical tags, and API documentation.
- **R92 [P1]** When `moshcode site <name> --tls` is used with nginx, the generated app may advertise the pin-verified Moshpit HTTPS origin to compatible clients, but it is not the default OAuth callback in v1.
- **R93 [P1]** Add platform support for automatically allocating a CA-valid companion hostname under a Moshcode-owned public domain. Until that service exists, prompt for `AUTH_ORIGIN`.

### Public JSON API

All API endpoints are versioned beneath `/api/v1`.

Public endpoints:

```text
GET  /api/v1
GET  /api/v1/health
GET  /api/v1/session
GET  /api/v1/posts
GET  /api/v1/posts/:slug
GET  /api/v1/openapi.json
```

Authenticated account endpoints:

```text
GET     /api/v1/account/tokens
POST    /api/v1/account/tokens
DELETE  /api/v1/account/tokens/:id
```

Administrative endpoints:

```text
POST    /api/v1/admin/posts
PATCH   /api/v1/admin/posts/:id
DELETE  /api/v1/admin/posts/:id
POST    /api/v1/admin/autoblog/run
GET     /api/v1/admin/autoblog/runs
```

- **R94 [P0]** Use JSON request and response bodies except endpoints that explicitly return HTML, redirects, or XML.
- **R95 [P0]** Successful list responses use:

```json
{
  "data": [],
  "meta": {
    "limit": 20,
    "cursor": null,
    "next_cursor": null
  }
}
```

- **R96 [P0]** Errors use:

```json
{
  "error": {
    "code": "machine_readable_code",
    "message": "Safe human-readable message",
    "request_id": "opaque-id"
  }
}
```

- **R97 [P0]** Validate every path, query, header, and body input using shared schemas.
- **R98 [P0]** Pagination is cursor-based, stable, and bounded. Default limit is 20; maximum is 100.
- **R99 [P0]** Public post responses include only published posts whose `published_at` is not in the future.
- **R100 [P0]** OpenAPI output documents auth methods, schemas, errors, and every v1 endpoint.
- **R101 [P0]** CORS is disabled by default except same-origin requests. Additional allowed origins require explicit configuration.
- **R102 [P0]** API responses include a request ID, `X-Content-Type-Options: nosniff`, and appropriate cache headers.
- **R103 [P0]** Read-only public endpoints may be cached; session, token, and admin endpoints must be `no-store`.
- **R104 [P1]** Add conditional GET support (`ETag` and/or `Last-Modified`) to post list and detail responses.

### Blog

- **R105 [P0]** Blog is installed and enabled by default.
- **R106 [P0]** `--no-blog` keeps the code in the template but sets `BLOG_ENABLED=false`, removes blog navigation, disables auto-blog, and returns `404` from blog and feed routes.
- **R107 [P0]** Public routes are:

```text
/blog
/blog/:slug
/blog/feed.xml
```

- **R108 [P0]** Admin route is `/admin/blog` with create, edit, preview, schedule, publish, archive, and delete actions.
- **R109 [P0]** Blog pages use the same Solid components during SSR and hydrated SPA navigation.
- **R110 [P0]** Posts are authored in Markdown.
- **R111 [P0]** Markdown is rendered and sanitized on the server with maintained open-source libraries. Unsanitized HTML must never be rendered.
- **R112 [P0]** Slugs are normalized, unique, stable after publication unless explicitly changed, and validated against reserved routes.
- **R113 [P0]** A changed published slug records or generates a permanent redirect from the old slug.
- **R114 [P0]** The installer seeds one published welcome post so `/blog`, a post detail page, the posts API, and RSS are immediately non-empty.
- **R115 [P0]** Draft and scheduled posts are never exposed to anonymous visitors.
- **R116 [P0]** The admin editor uses progressive forms/actions that work after hydration and report validation errors without losing content.
- **R117 [P1]** Support tags and tag-filtered blog pages.
- **R118 [P1]** Support image attachments through a configurable object-storage adapter; v1 does not require this.

### RSS

- **R119 [P0]** `/blog/feed.xml` returns RSS 2.0 as `application/rss+xml; charset=utf-8`.
- **R120 [P0]** The feed includes an Atom self-link, channel title, description, canonical site link, language, last build date, stable GUIDs, publication dates, excerpts, and sanitized full HTML in `content:encoded`.
- **R121 [P0]** Every XML field and URL is escaped correctly.
- **R122 [P0]** Only currently published posts appear.
- **R123 [P0]** Feed links use `PUBLIC_CANONICAL_ORIGIN`, not an untrusted request `Host` header.
- **R124 [P0]** The feed supports `ETag`, `Last-Modified`, and `304 Not Modified`.
- **R125 [P0]** RSS generation is covered by an XML-parser test, not only string snapshots.
- **R126 [P0]** When blog is disabled, the feed returns `404`.

### Auto-blog

- **R127 [P0]** Auto-blog is enabled by default when the blog is enabled.
- **R128 [P0]** `--no-autoblog` sets `AUTOBLOG_ENABLED=false` and does not install or enable the timer.
- **R129 [P0]** Auto-blog has a provider-neutral pipeline and records every attempted run.
- **R130 [P0]** Default sources are `queue` and `release`.
- **R131 [P0]** Queue source imports Markdown files from `content/queue/` exactly once.
- **R132 [P0]** Release source can turn a local changelog or supplied release JSON into a post without requiring an AI provider.
- **R133 [P0]** AI source is included but inactive until an endpoint, model, and credential are explicitly configured.
- **R134 [P0]** Enabling auto-blog must not itself make paid model calls.
- **R135 [P0]** The baseline AI adapter uses an OpenAI-compatible HTTP API through `fetch` and does not require a vendor SDK.
- **R136 [P0]** AI output is validated, rendered, sanitized, and subject to the same post rules as manually authored content.
- **R137 [P0]** Default auto-publish behavior is:
  - queue and release sources: publish;
  - AI source: create a draft until `AUTOBLOG_AI_AUTOPUBLISH=true`.
- **R138 [P0]** A systemd oneshot service and timer run the pipeline on a configurable schedule. Default schedule is daily at 09:00 server local time.
- **R139 [P0]** The job uses a database lock/lease so concurrent timer, API, or manual runs cannot process the same input twice.
- **R140 [P0]** Each run records source, status, input reference, resulting post, timestamps, and a safe error.
- **R141 [P0]** Manual execution is available through `bun run autoblog` and the authorized admin API.
- **R142 [P0]** A failed item does not abort unrelated queued items.
- **R143 [P0]** Re-running a source is idempotent based on a stable input hash.
- **R144 [P1]** Add GitHub release ingestion through a webhook or scheduled fetch.
- **R145 [P1]** Add OpenRouter, OpenAI, Anthropic, and local Ollama presets while retaining the generic OpenAI-compatible adapter.

### Configuration

The generated `.env.example` must include:

```env
APP_NAME=foo.whatever
HOST=127.0.0.1
PORT=3000
NODE_ENV=development

MOSHPIT_ORIGIN=http://foo.whatever
AUTH_ORIGIN=https://foo.apps.example.com
PUBLIC_CANONICAL_ORIGIN=https://foo.apps.example.com
ALLOWED_ORIGINS=https://foo.apps.example.com

DATABASE_URL=file:./data/app.db
TURSO_AUTH_TOKEN=

COINPAY_BASE_URL=https://coinpayportal.com
COINPAY_AUTHORIZE_PATH=/api/oauth/authorize
COINPAY_TOKEN_PATH=/api/oauth/token
COINPAY_USERINFO_PATH=/api/oauth/userinfo
COINPAY_CLIENTS_PATH=/api/oauth/clients
COINPAY_JWKS_PATH=/api/oauth/jwks
COINPAY_CLIENT_ID=
COINPAY_CLIENT_SECRET=
COINPAY_SCOPES="openid profile email"

SESSION_SECRET=
SESSION_TTL_DAYS=30
OWNER_EMAIL=

BLOG_ENABLED=true
BLOG_TITLE=foo.whatever
BLOG_DESCRIPTION="Updates from foo.whatever"
BLOG_LANGUAGE=en-us
BLOG_POSTS_PER_PAGE=20

AUTOBLOG_ENABLED=true
AUTOBLOG_SOURCES=queue,release
AUTOBLOG_AI_AUTOPUBLISH=false
AUTOBLOG_OPENAI_BASE_URL=
AUTOBLOG_OPENAI_API_KEY=
AUTOBLOG_OPENAI_MODEL=
```

- **R146 [P0]** Configuration is parsed once at startup and validated before the server accepts requests.
- **R147 [P0]** Missing required production values produce one actionable startup report listing all invalid fields.
- **R148 [P0]** Public environment values and server secrets are defined in separate typed configuration objects.
- **R149 [P0]** No secret is serialized into SSR payloads or browser bundles.
- **R150 [P0]** The health endpoint reports feature configuration as booleans and modes, never secret values.

### Installer flow

Interactive default flow:

```text
$ moshcode site init foo.whatever

Creating a Profullstack application for foo.whatever

Project directory: ./foo.whatever
Runtime: Bun
UI: SolidStart
API: /api/v1
Blog: /blog
RSS: /blog/feed.xml

✓ Bun found

✓ Turso CLI found
✓ Turso login found

Use a hosted Turso database? [Y/n]
Database name [foo-whatever]:
Create database now? [Y/n]

✓ Database created
✓ Database URL retrieved
✓ Database token created
✓ Credentials written to .env (0600)

Enable blog? [Y/n]
Enable auto-blog? [Y/n]
Auto-blog sources [queue,release]:

Configure CoinPay login now? [Y/n]
Secure HTTPS origin:
Owner CoinPay email:
CoinPay setup:
  1. Register a new OAuth client with an API token
  2. Enter an existing client ID and secret
  3. Configure later

Install Bun dependencies? [Y/n]
Run migrations and seed data? [Y/n]
Build production bundle? [Y/n]
Install systemd and web-server configuration? [y/N]
Reload and enable services now? [y/N]

✓ Application initialized
```

- **R151 [P0]** Prompt order must avoid requesting secrets before the final callback URI and database choice are known.
- **R152 [P0]** Every external command's exit code and stderr are checked.
- **R153 [P0]** The installer stops at the first failed dependent step and prints completed steps plus the exact resume command.
- **R154 [P0]** Sensitive prompts use no-echo input.
- **R155 [P0]** The final summary contains:
  - project directory;
  - database mode and resource name;
  - auth configured/not configured;
  - public and secure origins;
  - enabled features;
  - service names;
  - local development command;
  - production start command;
  - remaining manual actions.
- **R156 [P0]** The final summary never prints a full database token, OAuth client secret, session secret, API token, authorization code, or state.
- **R157 [P0]** If Bun is missing, offer the official Bun installation path interactively. Without approval, generate the project and print the install command; do not silently run a remote shell script.
- **R158 [P0]** If Turso is missing, local SQLite fallback is immediate; do not require Turso installation.
- **R159 [P0]** If CoinPay automatic registration is unavailable, provide the exact callback URI and scopes needed for manual dashboard registration.

### Safe template rendering

- **R160 [P0]** The initializer may replace documented inert tokens such as `__APP_NAME__`, `__APP_SLUG__`, `__MOSHPIT_ORIGIN__`, `__AUTH_ORIGIN__`, and `__PORT__`.
- **R161 [P0]** Only trusted initializer code performs token replacement.
- **R162 [P0]** Template values are escaped for the target format; a Moshpit name must not be able to inject TypeScript, JSON, shell, systemd, nginx, or Caddy syntax.
- **R163 [P0]** No arbitrary expression evaluation, JavaScript evaluation, shell interpolation, or user-provided template engine is allowed.
- **R164 [P0]** Generated systemd unit names and paths use sanitized identifiers and absolute paths.

### Deployment

- **R165 [P0]** The generated application includes a systemd service that runs the built SolidStart Bun server from an unprivileged user and restarts on failure.
- **R166 [P0]** The service binds to `127.0.0.1:<port>`.
- **R167 [P0]** The service loads secrets from an environment file with restrictive permissions.
- **R168 [P0]** The service uses a dedicated writable data directory and reasonable systemd hardening that does not break Bun or SQLite.
- **R169 [P0]** The initializer can call the existing trusted `moshcode site <name> --proxy <port>` planning/install path rather than reimplementing web-server detection.
- **R170 [P0]** Caddy serves the HTTP Moshpit origin and reverse-proxies to Bun.
- **R171 [P0]** nginx may serve both plain HTTP and registry pin-verified TLS using the existing `--tls` behavior.
- **R172 [P0]** Port 80 never redirects unconditionally to pin-verified port 443.
- **R173 [P0]** A separate CA-valid `AUTH_ORIGIN` reverse proxy is documented and generated when its hostname points to the server.
- **R174 [P0]** `--install` may write project service units and web-server configuration only after showing a plan.
- **R175 [P0]** `--reload` validates configuration before reloading and must not take unrelated sites down on invalid generated configuration.
- **R176 [P0]** Auto-blog timer installation is skipped when blog or auto-blog is disabled.
- **R177 [P1]** Add Railway deployment documentation and an external scheduler alternative to systemd.

### Security and privacy

- **R178 [P0]** Use parameterized SQL everywhere.
- **R179 [P0]** Normalize and validate all redirect targets; post-login `return_to` values must be local paths from an allowlist and must not permit open redirects.
- **R180 [P0]** Enforce maximum request-body sizes for JSON and forms.
- **R181 [P0]** Add conservative rate limits for OAuth initiation/callback, session creation, token creation, admin mutations, and auto-blog execution.
- **R182 [P0]** Do not trust proxy headers unless the request came from the configured local reverse proxy.
- **R183 [P0]** Escape HTML by default and sanitize rendered Markdown.
- **R184 [P0]** Add a Content Security Policy compatible with SolidStart and the site's own assets.
- **R185 [P0]** Do not store raw IP addresses by default. If abuse controls use client metadata, store a keyed or salted coarse-prefix hash with a retention policy.
- **R186 [P0]** Redact secrets and tokens from logs.
- **R187 [P0]** Log structured request IDs, route, status, duration, and safe error codes.
- **R188 [P0]** Refuse authenticated writes when the request arrives through the plain Moshpit origin, gateway, or an unapproved host.
- **R189 [P0]** Dependency and lockfile scanning must run in CI.
- **R190 [P0]** The generated README must clearly label plain Moshpit HTTP as public/non-sensitive and `AUTH_ORIGIN` as the only stock-browser authenticated origin.

### Observability and health

- **R191 [P0]** `GET /api/v1/health` returns at least:

```json
{
  "ok": true,
  "version": "0.1.0",
  "runtime": "bun",
  "database": {
    "mode": "sqlite",
    "reachable": true,
    "migrations_current": true
  },
  "auth": {
    "provider": "coinpay",
    "configured": false
  },
  "blog": {
    "enabled": true
  },
  "autoblog": {
    "enabled": true,
    "sources": ["queue", "release"]
  }
}
```

- **R192 [P0]** Health must return a non-2xx status when the database is unreachable or required migrations are missing.
- **R193 [P0]** A liveness route must avoid expensive external calls.
- **R194 [P1]** Add a separate readiness route when deployment targets need it.
- **R195 [P0]** Auto-blog run failures are visible in admin UI and API without exposing model prompts, credentials, or provider-sensitive payloads.

### Documentation

- **R196 [P0]** Add `docs/profullstack-template.md`.
- **R197 [P0]** Update `docs/hosting-a-moshpit-name.md` to explain:
  - copy-only templates;
  - trusted `site init`;
  - plain HTTP;
  - pin-verified TLS;
  - gateway stripping;
  - the need for a CA-valid auth origin.
- **R198 [P0]** Update the root README's template and site sections.
- **R199 [P0]** Generated README includes local development, Turso setup, CoinPay client setup, owner bootstrap, migrations, blog management, RSS, auto-blog, API examples, deployment, backup, restore, and token rotation.
- **R200 [P0]** API examples use `curl` and never include real secrets.
- **R201 [P0]** Add a troubleshooting matrix for resolver, web server, Bun service, database, OAuth callback, session cookie, RSS, and timer failures.

## UX Notes

### First-run principles

- Prefer useful defaults.
- Show the user the architecture before asking questions.
- Ask one decision at a time.
- Do not ask for a value that can be safely derived.
- Do not hide fallback behavior.
- Never print secrets back to the terminal.
- Every cloud or privileged action must be visible before execution.
- A failed optional integration must not prevent a local application from running.

### Database states

| State | Interactive behavior | Non-interactive `--db auto` |
|---|---|---|
| Turso absent | Explain local fallback; continue | Use SQLite |
| Turso present, logged out | Offer login; fallback if declined | Use SQLite |
| Turso present, logged in | Hosted Turso is default choice | Use Turso only when group/name are deterministic |
| Explicit `--db turso` fails | Stop with actionable error | Stop with actionable error |
| Explicit `--db sqlite` | Never contact Turso | Never contact Turso |

### Auth states

| State | Application behavior |
|---|---|
| CoinPay configured + HTTPS auth origin | Login works |
| CoinPay selected but credentials missing | App boots; login page shows setup instructions |
| Plain Moshpit origin | Public/read-only; login redirects to secure origin |
| Public gateway | Anonymous/read-only |
| Secure origin with bad/missing host | Reject request |
| Callback state expired/reused | Reject and offer restart login |

### Blog states

| Setting | `/blog` | `/blog/feed.xml` | Admin | Timer |
|---|---|---|---|---|
| Blog on, auto-blog on | Enabled | Enabled | Enabled | Enabled |
| Blog on, auto-blog off | Enabled | Enabled | Enabled | Disabled |
| Blog off | 404 | 404 | 404 | Disabled |

### Code-reuse rule

The required rendering lifecycle is:

```text
same Solid route/component code
        │
        ├── initial request: rendered by Bun/SolidStart
        │
        └── after hydration: reused by Solid Router as SPA UI
```

No feature may ship separate React-like client and server component trees for the same page.

## Acceptance Criteria

### A. Local zero-cloud setup

Given a machine with Bun but no Turso CLI, when the user runs:

```sh
moshcode site init foo.whatever --db auto --auth none --yes
```

then:

1. a project is generated without contacting Turso;
2. `DATABASE_URL=file:./data/app.db` is configured;
3. migrations apply;
4. a welcome post is seeded;
5. `bun run dev` starts successfully;
6. `/`, `/blog`, `/blog/<welcome-slug>`, `/blog/feed.xml`, `/api/v1/health`, and `/api/v1/posts` return valid responses;
7. internal navigation hydrates and continues without full-page reloads;
8. no secret or database file is tracked by Git.

### B. Hosted Turso setup

Given an authenticated Turso CLI, when the user accepts the hosted default, then:

1. exactly one database is created or selected;
2. the database URL and token are retrieved;
3. `.env` is mode `0600`;
4. secrets are redacted from output;
5. migrations and seed run against the hosted database;
6. re-running the initializer does not create a duplicate database.

### C. Explicit Turso failure

Given `--db turso`, when Turso provisioning fails, then:

1. setup exits non-zero;
2. it does not switch to SQLite;
3. it reports completed resources and the resume command;
4. it does not destroy a created database automatically.

### D. CoinPay login

Given a CA-valid `AUTH_ORIGIN` and valid CoinPay client credentials, then:

1. login initiates authorization code flow with S256 PKCE and state;
2. callback validates state before token exchange;
3. a verified CoinPay identity creates or updates one local user keyed by `sub`;
4. the matching verified owner email receives the `owner` role;
5. a hashed opaque session is stored;
6. a secure host-only cookie is set;
7. logout revokes the local session;
8. the Moshpit HTTP origin never receives or accepts the authenticated cookie.

### E. Blog and RSS

Given the seeded welcome post, then:

1. it appears on `/blog`;
2. it has a server-rendered detail page;
3. it appears in `/api/v1/posts`;
4. it appears in valid RSS;
5. draft and future scheduled posts do not appear publicly;
6. RSS supports conditional requests.

### F. Auto-blog

Given the default queue source, when a unique Markdown file is placed in `content/queue/` and the job runs twice, then:

1. one post is created and published;
2. one successful run is recorded;
3. the second execution does not create a duplicate;
4. no AI provider is called.

### G. Template safety

Given a remote template containing a `postinstall`, executable script, symlink, or malicious manifest, then `moshcode template install` continues to copy only permitted regular files and does not execute anything.

Given the bundled `profullstack` template, `moshcode site init` performs only operations explicitly implemented in trusted Moshcode source.

### H. Dry run

Given any valid initializer command with `--dry-run`, then:

1. no files are written;
2. no cloud resources are created;
3. no package installer is run;
4. no OAuth client is registered;
5. no system service or web server is changed;
6. all planned actions are displayed with secrets redacted.

## Testing Requirements

### Moshcode CLI tests

- Argument parsing for all flags, aliases, conflicts, and missing values.
- Backward compatibility for existing `moshcode site <name>` behavior.
- TTY and non-TTY decision matrix.
- Turso absent, logged-out, logged-in, multi-group, create success, partial failure, and explicit failure.
- Secret redaction in text, JSON, error, and dry-run output.
- File-conflict atomicity.
- Resume and idempotency.
- Safe template-token rendering against injection payloads.
- No execution through template installation.
- Privileged plan generation without applying it.
- Mock CoinPay registration success and failure.

### Generated application tests

- Strict TypeScript typecheck.
- Migration idempotency and checksum mismatch.
- Local SQLite integration tests.
- Mocked remote libSQL client tests.
- SSR route output.
- Hydration and client-side navigation smoke test.
- Shared service behavior used by UI and API.
- API validation, pagination, error envelopes, auth, roles, and caching.
- OAuth state, expiry, reuse, PKCE, callback, and session rotation.
- Host/origin gating.
- Session and API-token hashing/revocation.
- Markdown sanitization with malicious payloads.
- Blog state visibility.
- RSS parse and conditional requests.
- Auto-blog idempotency, locking, and provider-disabled behavior.
- Health behavior with missing migrations or database outage.

### CI matrix

At minimum:

```text
Moshcode CLI: Node.js 18 and current LTS
Generated app: current supported Bun release
Database: local file mode
OS: Ubuntu latest LTS
```

A nightly or release-gate integration job may test real Turso and CoinPay using isolated credentials. Pull-request CI must use mocks and must not create external resources.

## Success Metrics

1. A user with Bun can generate and run the local site in one command sequence without editing source code.
2. At least 90% of successful interactive initializations reach a passing health endpoint without manual debugging.
3. Local SQLite fallback succeeds whenever Turso is unavailable in `auto` mode.
4. No installer output or committed file contains generated secrets.
5. SSR and hydrated SPA navigation are both covered by automated tests.
6. A newly generated default site has a working blog and RSS feed immediately.
7. Default auto-blog processing creates no paid AI requests.
8. Existing template and site command tests remain green.
9. The generated application has no separate frontend/backend repositories and no duplicate page component implementations.
10. A coding agent can implement or extend a site using the generated README, OpenAPI document, tests, and this PRD without reverse-engineering installer behavior.

## Rollout Plan

### Phase 1: Template and local application

- Add the `profullstack` bundled files.
- Implement SolidStart SSR/hydration, local SQLite, migrations, API, blog, RSS, seed, and tests.
- Keep auth configurable but disabled in local smoke tests.
- Add copy-only template listing and install coverage.

### Phase 2: Trusted initializer and Turso

- Add `site init` parsing, state file, dry run, rendering, conflict handling, Bun detection, Turso detection, provisioning, fallback, migration, seed, and build.
- Add text and JSON output.
- Add resume/idempotency tests.

### Phase 3: CoinPay authentication

- Confirm canonical CoinPay endpoints and ID-token verification method.
- Implement client registration options, PKCE/state, callback, user/session creation, owner bootstrap, host/origin enforcement, and account/API-token UI.
- Add mocked and production-gated integration tests.

### Phase 4: Deployment and auto-blog

- Integrate existing `moshcode site` proxy planning.
- Add systemd service/timer units and installation workflow.
- Add queue/release auto-blog, locking, run history, admin controls, and optional OpenAI-compatible adapter.
- Update hosting documentation.

### Phase 5: Companion secure origin

- Document manual CA-valid companion origin setup.
- Add automated `apps.moshcode.sh` allocation only when a supporting Moshcode platform API exists.
- Do not block phases 1–4 on automatic hostname allocation.

## Repository Changes

Expected Moshcode changes:

```text
bin/moshcode.mjs
src/serve.mjs
src/site-init.mjs
src/site-init/
  args.mjs
  plan.mjs
  render.mjs
  state.mjs
  turso.mjs
  coinpay.mjs
  install.mjs
src/cli-schema.mjs
src/completion.mjs
src/help.mjs
examples/templates/profullstack/**
test/site-init.test.mjs
test/site-init-turso.test.mjs
test/site-init-coinpay.test.mjs
test/site-init-render.test.mjs
docs/profullstack-template.md
docs/hosting-a-moshpit-name.md
README.md
prd/README.md
```

The implementation may split modules differently, but database provisioning, CoinPay provisioning, rendering, state/resume, and privileged install planning must remain independently testable.

## Risks & Open Questions

1. **CoinPay documentation consistency:** Current CoinPay documentation surfaces different OAuth/JWKS paths in different integration pages. The canonical authorization, token, UserInfo, JWKS, issuer, audience, signing algorithm, and revocation behavior must be confirmed before release.
2. **Secure companion origin:** CoinPay OAuth for stock browsers requires a CA-valid HTTPS callback. Automatic `apps.moshcode.sh` allocation needs a platform API that may not yet exist.
3. **Pinned Moshpit TLS:** It is useful for Moshpit-aware clients but cannot be treated as universally trusted by ordinary browsers or external OAuth providers.
4. **Turso product modes:** Turso supports both its newer database engine and libSQL. This PRD intentionally selects hosted libSQL because `@libsql/client` also supports the local file mode. Revisit when one SDK provides equally simple local-file and hosted-new-engine behavior.
5. **SolidStart release selection:** Pin the latest tested stable release at implementation time; do not automatically adopt a prerelease in a production starter.
6. **Auto-blog definition:** Queue and release sources are fully defined for v1. More autonomous topic selection, crawling, editorial policy, citations, and duplicate-content controls need a later PRD.
7. **HTML sanitization:** The exact Markdown and sanitization libraries must be selected based on maintained status, Bun compatibility, and security review.
8. **Systemd hardening:** Restrictive unit settings must be tested with Bun, local SQLite writes, build assets, DNS, and outbound CoinPay/Turso requests.
9. **Multiple sites on one host:** Port selection, system user strategy, service naming, data directories, and Turso database names must remain collision-safe.
10. **Backups:** Local SQLite backup and hosted Turso recovery procedures must be documented before declaring the template production-ready.
11. **Owner recovery:** A lost owner account needs a host-local recovery path that does not expose a network setup token.
12. **API stability:** `/api/v1` is a compatibility promise. Breaking response changes require `/api/v2` or an explicit deprecation process.

## Decision Summary

The default generated site is:

```text
Bun
SolidStart + SolidJS
SSR first request
hydrated SPA navigation
shared TSX routes/components
SolidStart server functions
versioned JSON API
@libsql/client
local SQLite fallback
hosted Turso libSQL when available
CoinPay OAuth/OIDC
hashed database sessions
scoped API tokens
/blog
/blog/feed.xml
default-on queue/release auto-blog
systemd
nginx or Caddy
plain public Moshpit origin
separate CA-valid authenticated origin
```

The primary experience is:

```sh
moshcode site init foo.whatever
cd foo.whatever
bun run dev
```

The existing template security boundary remains:

```text
template install = copy files only
site init        = trusted, explicit provisioning
```

## References

- Moshcode bundled templates: https://github.com/moshcoder/moshcode/tree/main/examples/templates
- Moshcode template safety implementation: https://github.com/moshcoder/moshcode/blob/main/src/templates.mjs
- Moshcode site/hosting implementation: https://github.com/moshcoder/moshcode/blob/main/src/serve.mjs
- Moshpit hosting constraints: https://github.com/moshcoder/moshcode/blob/main/docs/hosting-a-moshpit-name.md
- Moshcode OpenPRD template: https://github.com/moshcoder/moshcode/blob/main/prd/0000-template.md
- SolidStart configuration: https://docs.solidjs.com/solid-start/reference/config/define-config
- SolidStart data fetching and server functions: https://docs.solidjs.com/solid-start/guides/data-fetching
- SolidStart authentication guidance: https://docs.solidjs.com/solid-start/advanced/auth
- Turso TypeScript quickstart: https://docs.turso.tech/sdk/ts/quickstart
- Turso CLI database creation: https://docs.turso.tech/cli/db/create
- Turso CLI authentication status: https://docs.turso.tech/cli/auth/whoami
- Turso database token creation: https://docs.turso.tech/cli/db/tokens/create
- CoinPay OAuth/OIDC documentation: https://coinpayportal.com/docs
- CoinPay OAuth integration prompt: https://coinpayportal.com/docs/prompts/OAUTH
