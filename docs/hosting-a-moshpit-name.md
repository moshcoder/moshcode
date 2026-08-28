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

## Publishing to a name over HTTP

A feed points at writing that already exists somewhere. If it does not exist
anywhere yet, publish it to the name directly — one endpoint, your existing
moshcode API key, no dashboard.

```sh
curl -X POST https://pit.moshcode.sh/api/moshpit/sites/blue.eggs/content \
  -H "authorization: Bearer $MOSHCODE_API_KEY" \
  -H "content-type: application/json" \
  -d '{"kind":"link","title":"Worth reading","url":"https://example.com/post"}'
```

That is the whole integration. Point a webhook, a cron job, a bot or a form at
it and the name has a site.

### What you can publish

| `kind` | what it is | needs |
|---|---|---|
| `section` | a heading in the nav that posts can be filed under | `title` |
| `page` | a standalone page in the nav — about, colophon | `title`, `body` |
| `text` | a post that is its own body | `title`, `body` |
| `link` | a post that points somewhere | `title`, `url` |
| `image` | one picture | `url` |
| `gallery` | several | `media[]` |
| `video` | something to watch | `url` |
| `embed` | a card for a URL we will not inline | `title`, `url` |

Other fields: `slug` (the URL and the identity — made from the title if you
omit it), `section` (which section a post is filed under), `published_at`
(epoch seconds, milliseconds or a date string; `null` for a draft), `position`
and `nav` (where it sits in the navigation).

### The rest of the verbs

| | |
|---|---|
| `GET /api/moshpit/sites/<name>/content` | read the site back out (drafts only if it's yours) |
| `POST /api/moshpit/sites/<name>/content` | publish — one object, or an array of up to 50 |
| `PUT …/content/<slug>` | replace one item |
| `DELETE …/content/<slug>` | take one down |

**It upserts on the slug.** A webhook that fires twice updates one post instead
of creating two, which matters the first time a delivery is retried. A batch
that is partly valid answers `207` and reports each item separately, so one bad
entry does not discard the good ones.

**A batch is capped by size as well as by count.** Fifty posts of the maximum
body length fit; fifty maximal galleries do not, and come back as a `413`
saying so. Split it — upserting on the slug is what makes splitting safe, so
the halves can be retried independently and in any order.

### Publishing a lot at once

The batch endpoint reads the whole request before it does anything, so its
ceiling is however much we are willing to hold for whoever asks. For a real
bulk import there is a second endpoint that does not buffer at all:

```sh
curl -N -X POST https://pit.moshcode.sh/api/moshpit/sites/blue.eggs/content/stream \
  -H "authorization: Bearer $MOSHCODE_API_KEY" \
  -H "content-type: application/x-ndjson" \
  --data-binary @posts.ndjson
```

`posts.ndjson` is one item per line — the same objects the batch endpoint
takes. Each is written as it arrives, and the response is NDJSON too, sent
while the upload is still going:

```json
{"type":"accepted","name":"blue.eggs","limits":{"items":500,"bytes":93368000}}
{"type":"progress","index":1,"ok":true,"created":true,"slug":"first-post"}
{"type":"progress","index":2,"ok":false,"error":"a link needs a url"}
{"type":"done","items":500,"created":499,"updated":0,"failed":1,"ms":1605}
```

That is what makes a progress bar possible — the first `progress` line arrives
long before the last item is uploaded. `/pit/publish` is a page that does
exactly this with a file picker, if you would rather not script it.

Worth knowing:

- **A bad line costs that line.** It comes back as a `progress` with `ok:false`
  and the stream keeps going, the same way the batch endpoint's `207` works.
- **The caps are in the `accepted` line**, so a client knows them without
  reading this page. Up to 500 items — a name holds 500, so one upload can fill
  a site and cannot do more than fill it.
- **A cap hit mid-stream cannot be a status code.** The `200` was sent before
  the first item was written, so it arrives as a final `error` line instead,
  and everything already written stays written.
- **Four uploads at a time**, process-wide. Past that it is `503` with a
  `Retry-After` rather than a queue.
- **Send `application/x-ndjson`.** Plain `application/json` is refused, because
  the JSON body parser would have consumed the request before the handler ran
  and the upload would look empty rather than failing honestly.

### What the site looks like

`/n/<name>` is the front page — every published post, newest first. Sections and
pages become the nav, capped at 12 entries, because a nav that wraps onto three
lines has stopped being one. Each post gets `/n/<name>/<slug>`. Publish a page
with the slug `home` to give the site a title and a tagline.

Everything published is escaped on the way out, and only `http(s)` URLs are
accepted. A `video` is inlined when it is a media file or on a short list of
known hosts (YouTube, Vimeo, PeerTube); anything else becomes a card that links
out, because an arbitrary URL in an iframe on `app.moshcode.sh` is a phishing
surface with our hostname on it.

**Precedence for a name:** target (your server) → posts published here → feed →
the ending's directory.

## Short links

`pit.moshcode.sh/n/blue.eggs/the-post-i-wrote-on-tuesday` is a fine URL for a
browser and a bad one for a slide, a QR code or a chat line. The registry mints
short ones:

```
mosh ▸ /shorten https://pit.moshcode.sh/n/blue.eggs/the-post-i-wrote-on-tuesday
✓ https://pit.moshcode.sh/f/k7mq2xd → https://pit.moshcode.sh/n/blue.eggs/the-post-i-wrote-on-tuesday
```

`/f/<code>` answers a `302` to wherever the link points. The same thing from a
script, with the API key you already have:

```sh
curl -X POST https://pit.moshcode.sh/api/moshpit/links \
  -H "authorization: Bearer $MOSHCODE_API_KEY" \
  -H "content-type: application/json" \
  -d '{"url":"https://example.com/a-very-long-address","name":"blue.eggs"}'
```

| | |
|---|---|
| `POST /api/moshpit/links` | mint one — `{ url, name? }`, `name` optional |
| `GET /api/moshpit/links` | every link you have minted, with its hit count |
| `DELETE /api/moshpit/links/<code>` | take one down; the code stops resolving |
| `GET /f/<code>` | follow it |

Four things worth knowing:

- **It needs an account.** An anonymous shortener is an open redirector with a
  database attached, which is what phishing kits are made of. Minting is tied to
  the account so a link can be revoked and its owner found.
- **It is idempotent per account.** Shortening the same URL twice hands back the
  same code, so a retried call cannot quietly mint a second one and split the
  hit count in half.
- **`http(s)` only,** the same rule published content follows. A `javascript:`
  target never reaches the column that `/f/` redirects to.
- **The redirect is a `302`, and is never cached or indexed.** A `301` would
  outlive the link — including past a delete — and a shortener whose links cannot
  be taken back is not one to print on anything.

Hits are counted; who followed them is not.

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
