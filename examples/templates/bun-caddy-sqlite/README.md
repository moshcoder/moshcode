# bun-caddy-sqlite

Bun serving an app, Caddy in front, SQLite underneath — local file in
development, Turso in production — published at a Moshpit name over IPv6.

## The part that surprises people

Three machines' worth of concerns, and they fail independently:

| | needs the resolver? | what it does |
|---|---|---|
| the box serving the name | **no** | Caddy matches a `Host` header, nothing more |
| the registry | — | holds the address the name points at |
| every visitor | **yes** | `sudo moshcode dns enable`, or the name resolves to nothing |

Nothing on the server ever resolves its own name. That is why there is no DNS
software in this template.

## Locally

```sh
bun install
cp .env.example .env
bun dev
curl -H "Host: foo.whatever" http://127.0.0.1:3000/
```

That runs against a SQLite file at `./data/app.db`. No Turso account needed
until you deploy.

## Deploying

1. **Point the name at the box.** In the Pit, set `points at` to its public
   IPv6 address — bare, no scheme, no brackets, no port:

   ```sh
   ip -6 addr show scope global | grep inet6
   ```

   Pick the globally routable one. An `fd..`/`fc..` address is unique-local
   (Tailscale and friends live there) and the registry refuses it, because a
   name pointed at one resolves somewhere only you can reach.

2. **Move the database, if it should be hosted.** Set `TURSO_DATABASE_URL` and
   `TURSO_AUTH_TOKEN` in `/etc/moshpit-service.env`. Leave them unset and the
   service uses the local file under `/var/lib/moshpit-service`, which the unit
   provisions. A URL without a token is refused at startup rather than failing
   at the first query.

3. **Serve it.**

   ```sh
   export MOSHPIT_NAME=foo.whatever
   sudo cp Caddyfile /etc/caddy/Caddyfile
   sudo cp deploy/moshpit-service.service /etc/systemd/system/
   sudo systemctl enable --now moshpit-service caddy
   sudo ufw allow 80/tcp
   ```

4. **Reach it,** on any machine that should see the name:

   ```sh
   sudo moshcode dns enable
   sudo cp deploy/moshcode-dns.service /etc/systemd/system/   # survives reboot
   sudo systemctl enable --now moshcode-dns
   ```

## Verifying, one layer at a time

A failure at any layer looks identical in a browser, so do not start there.

```sh
# Server only — no DNS involved. Proves Caddy, the firewall, and the app.
curl -6 -H "Host: foo.whatever" http://[YOUR:V6:ADDR]/

# Resolver only. Proves the registry and the bridge.
moshcode dns resolve foo.whatever

# Both.
curl -6 http://foo.whatever/
```

If the first works and the last does not, it is DNS. If the first fails, stop
looking at DNS.

## Known limits

- **No HTTPS, ever.** No CA will issue for an ending outside the DNS root. That
  rules out secure cookies, service workers, and WebCrypto in the browser. The
  `http://` in the Caddyfile is what stops Caddy trying and failing.
- **Only machines running the resolver can reach the name.** Not phones, not a
  colleague who has not installed it, not webhooks.
  `pit.moshcode.sh/n/foo.whatever` is the URL for people who installed nothing.
- **One level deep.** `foo.whatever` works; `www.foo.whatever` does not.
- **Port 80 only** on the resolver path. A DNS record carries an address and has
  nowhere to put a port, so a target like `[addr]:8080` only works through the
  `/n/` gateway.
