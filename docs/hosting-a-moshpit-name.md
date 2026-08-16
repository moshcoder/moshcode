# Hosting a service at a Moshpit name

You hold `foo.whatever`. This is how you put something behind it.

## The one fact everything else follows from

**The machine serving the name never resolves it. Every machine visiting it
must.**

Almost every "my Moshpit site doesn't work" is this, in one of its two
directions — a resolver installed on the server where it does nothing, or the
site declared broken from a laptop that never had one.

| | needs `moshcode dns`? | its job |
|---|---|---|
| the box serving the name | **no** | Caddy matches a `Host` header. That is all it ever does. |
| the registry (the Pit) | — | holds the address the name points at |
| every visitor | **yes** | `sudo moshcode dns enable`, or the name resolves to nothing |

A Moshpit ending is not in the public DNS root. Nothing on the internet resolves
it, and nothing ever will. The resolver is what makes the name mean something,
and it is a per-machine choice made by whoever wants to visit.

## Quickest path

```sh
moshcode template list
moshcode template install bun-caddy-sqlite
```

That writes a Caddyfile, systemd units and a Bun + SQLite service already wired
the way this page describes. Nothing in a template runs on install — read it,
then decide.

## 1. Point the name at your box

In the Pit, set **points at** to the machine's public IPv6 address. Bare — no
scheme, no brackets, no port:

```
2606:4700:4700::1111
```

Find yours:

```sh
ip -6 addr show scope global | grep inet6
```

Pick the globally routable one. An address starting `fd` or `fc` is
unique-local — that is where Tailscale and friends live — and the registry
refuses it, because a name pointed at one resolves somewhere only you can reach.

**IPv4 literals are refused.** An A record on a small host is usually leased,
NATed, or shared, and a name pointed at one goes stale without telling anyone. A
hostname (`box.example.com`) is accepted instead: keeping the address behind it
current is then someone else's job.

## 2. Serve the name

The web server needs a block that answers to the name, on **port 80**.

**Caddy:**

```caddyfile
http://foo.whatever {
	reverse_proxy 127.0.0.1:3000
}
```

The `http://` is required and is not a style choice. Leave it off and Caddy
tries to provision a TLS certificate for `foo.whatever`, fails — no CA will
issue for an ending outside the DNS root — and the site never comes up. This is
the single most common way this goes wrong.

**nginx:**

```nginx
server {
    listen [::]:80;
    server_name foo.whatever;
    root /srv/foo.whatever;
}
```

Then open the port. On ufw this covers v6 as well:

```sh
sudo ufw allow 80/tcp
```

Bind your app to loopback, not the public address. Caddy is its only client, and
binding it publicly publishes it on a port nothing virtual-hosts — which hands
anyone scanning the box the app with the name stripped off the front.

## 3. Let people reach it

On every machine that should see the name:

```sh
sudo moshcode dns enable
```

That does two things: writes a `systemd-resolved` drop-in routing Moshpit
endings at the bridge, and starts the bridge. The drop-in is a file and survives
a reboot. **The bridge process does not** — so after a restart the routing
points at a port with nothing behind it, and every Moshpit name stops resolving
with no obvious cause. The bundled `deploy/moshcode-dns.service` is the missing
half:

```sh
sudo cp deploy/moshcode-dns.service /etc/systemd/system/
sudo systemctl enable --now moshcode-dns
```

## Verifying, one layer at a time

Every layer fails identically in a browser, so do not debug from one.

```sh
# 1. Server only — no DNS involved at all.
#    Proves Caddy, the firewall, and the app.
curl -6 -H "Host: foo.whatever" http://[YOUR:V6:ADDR]/

# 2. Resolver only. Proves the registry and the bridge.
moshcode dns resolve foo.whatever

# 3. Both together.
curl -6 http://foo.whatever/
```

If 1 passes and 3 fails, it is DNS. If 1 fails, stop looking at DNS.

## What a name can point at

| target | resolver path | `/n/` gateway |
|---|---|---|
| `2606:4700:4700::1111` | AAAA record | fetched, bracketed |
| `box.example.com` | not answered — the bridge does no clearnet DNS | resolved, then fetched |
| `[2606:...]:8080` | **port dropped** — browsers go to 80 | fetched on 8080 |
| `203.0.113.7` | refused when saved | refused when saved |

DNS carries an address and has nowhere to put a port. A target naming a
non-default port therefore works only through the gateway, and a browser using
the resolver will go to port 80 regardless of what the target says.

## No server? Point the name at a feed instead

Everything above assumes you have a machine. If you do not, a name can still be
a site: paste an RSS or Atom URL into the **feed** box next to any name you
hold, and the Pit renders the page for you.

```
blue.eggs   points at   (empty)
            feed        https://example.com/feed.xml     [auto ▾]
```

Visiting `blue.eggs` — or `pit.moshcode.sh/n/blue.eggs` — then draws the feed:

| the feed carries | you get |
|---|---|
| posts | a blog: date, headline, opening lines, link out to the article |
| episodes with audio enclosures | a podcast: cover art, running time, and a player on every episode |

**auto / blog / podcast** picks the layout. Auto decides on whether the entries
carry audio, which is right nearly always — set it by hand for the feeds where
it is not (a blog that attaches one recording, a show whose host omits
enclosures).

Worth knowing:

- **A target beats a feed.** A name with both serves the target — a server you
  stood up beats a page we drew. Clear the target and the feed takes over, which
  also makes a feed a soft landing for a site that has gone down.
- **The Pit fetches the feed, not the visitor.** It is cached for a few minutes,
  so a name that gets linked somewhere busy does not become traffic on your feed
  host. If the feed stops answering, the last good copy keeps serving for a day
  with a note on it.
- **The feed must be on the public internet** over http(s), like a target.
  Private and link-local addresses are refused when you save.
- **Feed pages work without the resolver**, at `pit.moshcode.sh/n/<name>` — the
  page is rendered by the Pit, so there is no origin for a visitor to reach.
- Set it from a script with
  `PUT /api/moshpit/tlds/<tld>/names/feed` — `{"label":"blue","feed":"…","feed_kind":"podcast"}`.
  An empty `feed` clears it.

## Limits worth knowing before you build

- **No HTTPS, ever.** No CA will issue for an ending outside the DNS root. That
  rules out secure cookies, service workers, and WebCrypto in the browser.
  Everything at a Moshpit name is plain HTTP.
- **Only machines running the resolver can reach the name.** Not phones, not a
  colleague who hasn't installed it, not Googlebot, not a webhook from a payment
  provider. `pit.moshcode.sh/n/foo.whatever` is the URL to send people who have
  installed nothing — it fetches the target server-side and hands back the page.
- **One level deep.** `foo.whatever` resolves; `www.foo.whatever` does not.
  Moshpit names are exactly one label and one ending.
- **The gateway is not a file host.** It gives the origin 10 seconds and caps
  the body at 5 MB, strips cookies and `Authorization` in both directions, and
  sandboxes the result with CSP.
