# caddy-static

A static site at a Moshpit name. No runtime, no database, no service to keep
alive — Caddy and a directory of files.

Reach for [`bun-caddy-sqlite`](../bun-caddy-sqlite) instead when you need
something that runs.

## The part that surprises people

Three machines' worth of concerns, and they fail independently:

| | needs the resolver? | what it does |
|---|---|---|
| the box serving the name | **no** | Caddy matches a `Host` header, nothing more |
| the registry | — | holds the address the name points at |
| every visitor | **yes** | `sudo moshcode dns enable`, or the name resolves to nothing |

Nothing on the server ever resolves its own name. That is why there is no DNS
software in this template.

## Setup

1. **Point the name at the box.** In the Pit, set `points at` to its public
   IPv6 address — bare, no scheme, no brackets, no port:

   ```sh
   ip -6 addr show scope global | grep inet6
   ```

   Pick the globally routable one. An `fd..`/`fc..` address is unique-local
   (Tailscale and friends live there) and the registry refuses it, because a
   name pointed at one resolves somewhere only you can reach.

2. **Put the files where the Caddyfile expects them.** `SITE_ROOT` defaults to
   `/srv/moshpit-site`; `site/` here is a placeholder to replace.

   ```sh
   sudo mkdir -p /srv/moshpit-site
   sudo cp -r site/. /srv/moshpit-site/
   ```

3. **Serve it.**

   ```sh
   export MOSHPIT_NAME=foo.whatever
   export SITE_ROOT=/srv/moshpit-site
   sudo cp Caddyfile /etc/caddy/Caddyfile
   sudo systemctl enable --now caddy
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
# Server only — no DNS involved. Proves Caddy and the firewall.
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
