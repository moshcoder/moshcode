# caddy-proxy

A name in front of something that is already running. No app, no database, no
runtime to keep alive — Caddy answers the Moshpit name and hands every request
to a local service on `127.0.0.1:8080` (or wherever `APP_ADDR` says).

This is the template for "I have a thing on this box, put a name on it": a
dev server, a dashboard, grafana, a game panel, anything that already listens
on loopback.

## The part that surprises people

Three machines' worth of concerns, and they fail independently:

| | needs the resolver? | what it does |
|---|---|---|
| the box serving the name | **no** | Caddy matches a `Host` header, nothing more |
| the registry | — | holds the address the name points at |
| every visitor | **yes** | `sudo moshcode dns enable`, or the name resolves to nothing |

Nothing on the server ever resolves its own name. That is why there is no DNS
software in this template.

## Deploying

1. **Point the name at the box.** In the Pit, set `points at` to its public
   IPv6 address — bare, no scheme, no brackets, no port:

   ```sh
   ip -6 addr show scope global | grep inet6
   ```

   Pick the globally routable one. An `fd..`/`fc..` address is unique-local
   (Tailscale and friends live there) and the registry refuses it, because a
   name pointed at one resolves somewhere only you can reach.

2. **Serve it.** The service stays bound to loopback — Caddy is its only
   client, and binding it publicly publishes it on a port nothing
   virtual-hosts.

   ```sh
   export MOSHPIT_NAME=foo.whatever
   export APP_ADDR=127.0.0.1:8080   # the default; change only if the service differs
   sudo cp Caddyfile /etc/caddy/Caddyfile
   sudo systemctl reload caddy
   sudo ufw allow 80/tcp
   ```

3. **Reach it,** on any machine that should see the name:

   ```sh
   sudo moshcode dns enable
   sudo cp deploy/moshcode-dns.service /etc/systemd/system/   # survives reboot
   sudo systemctl enable --now moshcode-dns
   ```

## Every subdomain at once

One name covers one hostname. To answer `anything.foo.whatever` too — one
service per subdomain, or a wildcard tenant app — do both halves, in either
order, because neither works without the other:

1. In the Pit's **DNS Records** tab, publish an **AAAA** record on the
   `*.foo.whatever` option pointing at the same box. Until that exists the
   subdomains resolve to nothing and no request ever reaches Caddy.
2. Uncomment the wildcard block at the bottom of the Caddyfile and reload.
   Caddy matches exactly one label deep, and the app reads which subdomain was
   asked for from the `Host` header.

`foo.whatever` itself is not covered by a wildcard — keep the apex block (and
its own AAAA or `points at`) for that. This is how DNS wildcards work, not a
choice Caddy made.

## Verifying, one layer at a time

A failure at any layer looks identical in a browser, so do not start there.

```sh
# Server only — no DNS involved. Proves Caddy, the firewall, and the service.
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
- **Subdomains are opt-in.** `foo.whatever` works out of the box;
  `www.foo.whatever` works only with the wildcard record described above.
- **Port 80 only** on the resolver path. A DNS record carries an address and
  has nowhere to put a port, which is why Caddy listens on 80 and the
  `host:port` part lives here, not in the registry.
