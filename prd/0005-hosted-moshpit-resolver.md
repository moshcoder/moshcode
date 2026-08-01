---
openprd: "0.2"
id: "0005"
title: A hosted Moshpit resolver, for the devices that cannot run the bridge
status: Draft
authors:
  - anthony@chovy.com
created: 2026-08-01
updated: 2026-08-01
repo: https://github.com/moshcoder/moshcode
discussion:
implementation: apps/pwa/src/lib/moshpit-resolvers.mjs, apps/pwa/src/routes/moshpit.mjs, src/dns.mjs
tags:
  - moshpit
  - dns
  - infrastructure
  - privacy
supersedes:
superseded-by:
---

## Problem

A Moshpit ending is not in the ICANN root, so nothing resolves it until the
client is told something. Today there is exactly one way to be told: run
`moshcode dns enable`, which installs a local bridge and points the machine's
resolver at it.

That works on a laptop or a VPS. It is unavailable on the devices where most
people would actually meet a Moshpit name:

- a **phone**, which cannot run a daemon or edit `resolved.conf.d`
- a **router**, where you can set a DNS server and nothing else
- **someone else's machine** — the person you sent the link to

For all of them the only answer is `pit.moshcode.sh/n/<name>`, which fetches the
origin server-side and hands back the page. It works, and it is not resolution:
the URL bar reads `pit.moshcode.sh`, not `chovy.hacker`. The name never becomes
the visitor's address, which is the entire point of holding one.

The infrastructure for the missing piece is already half-built and unused.
`MOSHPIT_DNS_RESOLVERS` and `MOSHPIT_DOH_URL` are read, validated as real
addresses, and rendered on `/pit/dns` — and both are unset in production, so the
page publishes nothing. The shop window was built before the shop.

This PRD is deliberately **not** a replacement for the local bridge. It is the
answer for clients that cannot run one, and the difference matters because the
tradeoff is real and permanent: a hosted resolver sees every DNS query the
device makes.

## Goals

- A Moshpit name resolves on a device that can only be handed a DNS server.
- The URL bar keeps the name. `http://chovy.hacker/` stays `chovy.hacker`.
- Non-Moshpit lookups are answered correctly and are not the product.
- The privacy cost is stated plainly, in the UI, before anyone opts in.
- An outage degrades to "Moshpit names stop working", never "the internet stops
  working", for as long as that is within our control.

## Non-Goals

- **Replacing the local bridge.** Where a bridge can run it stays the better
  answer: no third party sees the queries, no round trip, no shared outage.
  `moshcode dns enable` remains the recommended path and the docs say so.
- **Being a general-purpose public resolver.** We are not competing with
  1.1.1.1. Forwarding exists so Moshpit names can resolve, not as a service.
- **Logging queries for analytics.** See Requirements — this is the one place
  where the tempting feature is the one that kills the product.
- **DNSSEC-signing the Moshpit zone.** Out of scope for v1; the endings are not
  in the root, so there is no chain to anchor to.

## Users

**Someone sent a link.** They open `http://seo.rank/` on a phone. Today: a
browser error, or a `pit.moshcode.sh` URL. With this: the page, at its own name.

**A household or office.** One DNS setting on the router, and every device on
the network resolves Moshpit names with nothing installed on any of them.

**A name holder demonstrating one.** The reason to hold `chovy.hacker` is that
it is an address you can give people. Today giving it away requires asking them
to install software first.

## Requirements

### R1 — Two protocols, both public

`Do53` (plain UDP/TCP 53) for routers and OS settings, and **DNS-over-HTTPS**
for phones and browsers, which increasingly will not accept anything else.
iOS and Android both accept a DoH profile; neither will run our daemon.

DoH is the one that unlocks phones, so it is not optional.

### R2 — Anycast or nothing

A single box is a single point of failure for the DNS of every device pointed
at it. If the deployment cannot be multi-region behind one address, this ships
as "best effort, do not set it as your only resolver" and says so in the UI.

### R3 — Forwarding is the dangerous part

The resolver answers Moshpit endings from the registry and forwards everything
else. That forwarding is what makes it usable as a device's only DNS server —
and what makes it a privacy problem, a latency tax, and a shared outage.

Three requirements follow, and R3.3 is the one worth arguing about:

- **R3.1** — the claimed-ending gate from `isOurs` applies here identically.
  `google.com` has two labels exactly like `blue.eggs`; only an ending someone
  has actually claimed is ours. An unknown ending set means *not* ours.
- **R3.2** — forwarded answers are relayed unmodified. No injected records, no
  rewritten NXDOMAIN, no "helpful" search page. The moment a resolver edits
  answers it is spyware with a nice landing page.
- **R3.3** — **no query logging beyond aggregate counters.** No per-query
  storage of name, source address, or the pair. This is the requirement that
  will be under pressure the first time someone asks "which endings are people
  looking up?" — and the honest answer is that we cannot know without becoming
  the thing the local bridge exists to avoid. Counters (queries/sec, hit rate,
  error rate) are fine. The tuple is not.

### R4 — Say the cost before the click

`/pit/dns` publishes the addresses. It must also state, in the same visual
weight as the addresses themselves:

> This resolver sees every DNS lookup your device makes, not just Moshpit ones.
> If you can run `moshcode dns enable`, do that instead — it keeps your lookups
> on your own machine.

A page that lists an IP with no context gets pasted into a router by someone who
has not thought about it. That is the failure mode to design against.

### R5 — Reuse the bridge, do not fork it

The hosted resolver is the same code as `src/dns.mjs` with upstreams
configured, deployed. The forwarding, the ending gate, the NODATA/NXDOMAIN
distinction and the AAAA support all already exist and are tested. A second
implementation would drift from the first, which is the failure this codebase
has already had five times over with one regex.

### R6 — Never the default

Nothing in `moshcode dns enable`, the CLI, or the extension silently points at
the hosted resolver. It is a documented address a person chooses to use. A
resolver that installs itself as your DNS without asking is malware behaviour
regardless of intent.

## UX Notes

`/pit/dns` already renders `.pit-addrs` cards for published resolvers, so the
page work is mostly copy plus the DoH URL. The order should be:

1. **`moshcode dns enable`** — recommended, keeps lookups local
2. **`pit.moshcode.sh/n/<name>`** — works with nothing installed, URL changes
3. **the hosted resolver** — for devices that cannot do (1), with R4's warning

Today the page has only (1) and publishes nothing for (3).

## Success Metrics

- A stock phone, given only a DoH profile, loads `http://chovy.hacker/` with
  `chovy.hacker` in the URL bar.
- Resolver p50 latency for a forwarded (non-Moshpit) query stays within ~10ms of
  the device's previous resolver, or the tax is visible enough that people turn
  it off.
- Zero per-query records in storage, demonstrable from the deployment config
  rather than from a policy document.

## Risks & Open Questions

**The privacy tradeoff is not fixable, only disclosed.** Anyone using this hands
us their full DNS history. R3.3 and R4 are mitigations, not solutions. If that
is unacceptable, the honest outcome is to not ship this and leave `/n/` as the
answer for phones.

**Shared outage.** A device with this as its only DNS server loses the whole
internet when we go down, not just Moshpit names. R2 exists for this and may
well be the reason to delay.

**Abuse.** An open forwarding resolver is a DDoS amplifier. Rate limiting and
response-size limits are required before anything is published, and this is not
optional or deferrable — an open resolver is found by scanners in hours.

**Does the demand exist?** The cheapest version of this experiment is to publish
nothing and instead measure how often `/n/` is loaded from mobile user agents.
If nobody is meeting Moshpit names on phones, this is infrastructure and risk
bought for an audience that is not there.

**Open:** does the ending gate consult the registry per query, or hold a cached
ending set refreshed on an interval? Per query is simpler and always current;
cached is faster and survives a registry outage. The local bridge faces the same
choice and has not resolved it either.
