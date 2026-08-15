// The Moshpit namespace: claim `.<whatever>`, alias it, exempt names from the
// alias, and resolve.
//
//   GET    /api/moshpit/log?since=&limit=     the allocation log, in order, to anyone
//   GET    /api/moshpit/tlds                  the public registry (`?mine=1` for yours)
//   POST   /api/moshpit/tlds                  claim `.<whatever>`
//   GET    /api/moshpit/tlds/:tld             availability lookup, no auth
//   PUT    /api/moshpit/tlds/:tld/alias       point .tld at another TLD you own
//   DELETE /api/moshpit/tlds/:tld/alias       stop pointing it anywhere
//   GET    /api/moshpit/tlds/:tld/exempt      names held back from the alias
//   POST   /api/moshpit/tlds/:tld/exempt      hold one back
//   DELETE /api/moshpit/tlds/:tld/exempt      let it follow the alias again
//   GET    /api/moshpit/resolve?name=&mode=   resolve + precedence for a client resolver
//   GET    /api/moshpit/records?name=         the records a name publishes, no auth
//   GET    /api/moshpit/tlds/:tld/records     the same, by tld + ?label=
//   POST   /api/moshpit/tlds/:tld/records     publish a record on a name you hold
//   DELETE /api/moshpit/tlds/:tld/records     withdraw one
//   GET    /pit                               the human page
//   GET    /pit/records                       the DNS records on the names you hold
//   GET    /pit/dns                           how to reach these names from a machine
import { createHash } from "node:crypto";
import { Router } from "express";
import { page, footer, appBar, esc } from "../lib/html.mjs";
import { requireAuth, csrfInput } from "../lib/session.mjs";
import { bearer, userForApiKey } from "../lib/apikey.mjs";
import { balance } from "../lib/credits.mjs";
import { resolverConfig } from "../lib/moshpit-resolvers.mjs";
import { landingFor } from "../lib/moshpit-landing.mjs";
import { nameQuery, tldQuery } from "../lib/moshpit-search.mjs";
import {
  MAX_BODY_BYTES, ORIGIN_TIMEOUT_MS, checkTarget, fetchOrigin, fetchOriginTls, forwardableHeaders, tlsRedirect,
} from "../lib/moshpit-gateway.mjs";
import {
  addPin,
  addRecord,
  clearAlias,
  clearExempt,
  countNames,
  countRecordNames,
  countTldLog,
  countTlds,
  countTldsForUser,
  countSearchTlds,
  countTldsNotOwnedBy,
  DEFAULT_TLD_PRICE_USD,
  getName,
  getTld,
  getTldWithPrice,
  listAliasesTo,
  listAllNames,
  listExempt,
  listNames,
  listPins,
  listRecordNames,
  listRecords,
  listRecordsForNames,
  listTlds,
  listTldsForUser,
  listTldsNotOwnedBy,
  MAX_BULK_TLDS,
  MAX_LISTING_PRICE_USD,
  MAX_TTL,
  MIN_TTL,
  normalizeLabel,
  normalizeMode,
  normalizePinKind,
  normalizeTld,
  openNamePurchase,
  parseMoshpitName,
  PIN_KINDS,
  pinsForName,
  popularLabels,
  quoteName,
  RECORD_HELP,
  RECORD_TYPES,
  recordsForName,
  registerName,
  registerTld,
  registerTlds,
  releaseName,
  removePin,
  removeRecord,
  resolutionPreference,
  resolveMoshpitName,
  searchTlds,
  setAlias,
  setExempt,
  setNameTarget,
  setTldPrice,
  shortCount,
  suggestedLabels,
  summarizeBulkClaim,
  tldLog,
  tldRejection,
  zoneLine,
} from "../moshpit.mjs";
import { config } from "../config.mjs";

export const moshpitRouter = Router();

const bad = (res, error, status = 400) => res.status(status).json({ error });
const unauthorized = (res) => res.status(401).json({ error: "sign in first" });

/**
 * The machine half of the namespace.
 *
 * Everything under /api/moshpit is described at the top of this file as an API,
 * and it was one only if you happened to have a browser cookie. `moshcode`
 * holds an API key that /api/me and /api/sessions both accept; every endpoint
 * here answered that same key with 401, so the namespace was the one part of
 * the product no script could touch.
 *
 * Same helper, same keys, same 401 when there is no key -- this is not a new
 * way in, it stops one router being the exception. A cookie session still wins
 * when both are present, because that is the caller who is already identified.
 *
 * Only /api/moshpit. The /pit pages are browser routes: they are CSRF-guarded
 * form posts, and a bearer token has no business standing in for a session
 * there.
 */
moshpitRouter.use("/api/moshpit", async (req, _res, next) => {
  if (!req.user) {
    const user = await userForApiKey(bearer(req));
    if (user) req.user = user;
  }
  next();
});

/* ---------- API ---------- */

/**
 * The registry, optionally filtered.
 *
 * `?q=` is what the filter box on /pit calls on every (debounced) keystroke:
 * `eggs` is a substring, `def*` is a glob, and tldQuery() decides which. It
 * answers with a name count per ending so the results can say how big each one
 * is without a second round trip per row.
 *
 * Unauthenticated and cheap on purpose -- the registry is public, and a filter
 * that only worked signed in would not help anyone deciding whether to sign up.
 * `?scope=` narrows to yours or everybody else's; yours needs a session, the
 * rest does not.
 */
moshpitRouter.get("/api/moshpit/tlds", async (req, res) => {
  const mine = Boolean(req.query.mine) || req.query.scope === "mine";
  if (mine && !req.user) return unauthorized(res);

  const filter = tldQuery(req.query.q);
  if (filter) {
    const scope = mine ? "mine" : req.query.scope === "theirs" ? "theirs" : "all";
    const limit = Math.min(50, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
    const tlds = await searchTlds(filter.like, {
      scope, userId: req.user?.id ?? null, exact: filter.exact, limit,
    });
    return res.json({
      query: filter.query,
      total: await countSearchTlds(filter.like, { scope, userId: req.user?.id ?? null }),
      tlds: tlds.map((t) => ({
        tld: t.tld,
        alias_of: t.alias_of,
        price_usd: t.price_usd,
        name_count: Number(t.name_count ?? 0),
        mine: Boolean(req.user && t.user_id === req.user.id),
      })),
    });
  }

  // `total` on every answer, because the alternative is what this used to do:
  // hand back 200 rows out of thousands with nothing in the response saying so.
  // A client cannot tell a complete list from a truncated one by looking at it,
  // and reading "absent from the list" as "does not exist" is the mistake that
  // shape invites.
  const { limit, offset } = pageParams(req.query);

  if (mine) {
    // Unpaged by default, as it has always been: this is the answer to "what do
    // I hold", and imposing a page size on it now would truncate the one call
    // that was telling the whole truth.
    const tlds = await listTldsForUser(req.user.id, limit === null ? {} : { limit, offset });
    return res.json({ total: await countTldsForUser(req.user.id), limit, offset, tlds });
  }

  // The default page size is the 200 this always applied — kept so existing
  // callers see no change in what arrives, only in being told there is more.
  const applied = limit ?? DEFAULT_PAGE;
  const tlds = await listTlds({ limit: applied, offset });
  res.json({ total: await countTlds(), limit: applied, offset, tlds });
});

/**
 * `?limit=` and `?offset=`, or null for "as it comes".
 *
 * These were read on the `?q=` branch and ignored everywhere else, so paging
 * the plain list did nothing at all — every page came back as page one, which
 * looks exactly like a list that happens to have 200 things in it.
 *
 * The ceiling is a real limit rather than a suggestion: without one, `?limit=`
 * is a way to ask the database for every row it has, and the pager exists
 * precisely so nobody has to.
 */
const MAX_PAGE = 1000;
const DEFAULT_PAGE = 200;

function pageParams(query) {
  const raw = Number.parseInt(query.limit, 10);
  const limit = Number.isInteger(raw) && raw > 0 ? Math.min(MAX_PAGE, raw) : null;
  const offsetRaw = Number.parseInt(query.offset, 10);
  const offset = Number.isInteger(offsetRaw) && offsetRaw > 0 ? offsetRaw : 0;
  return { limit, offset };
}

/**
 * The allocation log, in order, to anyone who asks.
 *
 * `moshpit_tlds` is a cache; this table is the record. That distinction was
 * written into the model months ago and then went nowhere, because nothing
 * could read it: no route, no export, no way for a second copy of this registry
 * to exist. "The directory can be mirrored and served by anyone" was true of
 * the schema and false of the product.
 *
 * Unauthenticated, because a log only one party can read settles nothing. The
 * point of publishing it is that a claim can be checked against the order it
 * was made in, by someone who does not trust us -- and a reader who has to ask
 * us for permission first is trusting us again.
 *
 * `?since=` is a seq, exclusive. A mirror stores the last seq it saw and asks
 * for what came after; catching up and staying caught up are the same call.
 *
 * The owning account is a digest rather than the user id. Ownership is already
 * public -- who claimed `.eggs` first is the whole point -- but the account
 * behind it is not, which is the same line /api/moshpit/tlds/:tld draws when it
 * answers "already registered" without saying by whom. The digest is stable and
 * derived only from the id, so two entries by one owner are still visibly one
 * owner, and every mirror computes the same value for them.
 */
moshpitRouter.get("/api/moshpit/log", async (req, res) => {
  const sinceRaw = Number.parseInt(req.query.since, 10);
  const since = Number.isInteger(sinceRaw) && sinceRaw > 0 ? sinceRaw : 0;

  const limitRaw = Number.parseInt(req.query.limit, 10);
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(MAX_PAGE, limitRaw) : DEFAULT_LOG_PAGE;

  // One more than asked for, so "is there another page" is answered by what
  // came back rather than by a second count that could disagree with it.
  const rows = await tldLog({ since, limit: limit + 1 });
  const more = rows.length > limit;
  const entries = more ? rows.slice(0, limit) : rows;

  res.json({
    total: await countTldLog(),
    since,
    limit,
    // The seq to pass back as `?since=`. Null means caught up -- not "start
    // again", which is what an absent cursor would otherwise be read as.
    next: more ? entries[entries.length - 1].seq : null,
    entries: entries.map((e) => ({
      seq: e.seq,
      tld: e.tld,
      action: e.action,
      owner: ownerDigest(e.user_id),
      at: e.at,
    })),
  });
});

// 500 rather than the 200 the endings list uses: these rows are small, and a
// mirror catching up from empty is the normal case rather than the exception.
const DEFAULT_LOG_PAGE = 500;

const ownerDigest = (userId) =>
  (userId ? createHash("sha256").update(`moshpit:owner:${userId}`).digest("hex").slice(0, 16) : null);

moshpitRouter.post("/api/moshpit/tlds", async (req, res) => {
  if (!req.user) return unauthorized(res);
  const result = await registerTld({
    tld: req.body?.tld,
    userId: req.user.id,
    ownerEmail: req.user.email ?? null,
    ownerKey: typeof req.body?.owner_key === "string" ? req.body.owner_key : null,
  });
  // 409 rather than 400 when the name is gone: the request was well formed,
  // someone else simply got there first, and a client should be able to tell
  // those apart without parsing the message.
  if (!result.ok) return bad(res, result.error || "could not register that TLD", result.taken ? 409 : 400);
  res.status(201).json({ tld: result.tld });
});

/**
 * Availability lookup. Answers for every case rather than 404ing on "not
 * registered" -- unregistered is a legitimate answer here, and this is what a
 * registration page calls as you type.
 */
moshpitRouter.get("/api/moshpit/tlds/:tld", async (req, res) => {
  const tld = normalizeTld(req.params.tld);
  if (!tld) {
    return res.status(400).json({
      tld: req.params.tld, available: false,
      reason: "not a valid TLD — letters, digits and dashes only, no dots",
    });
  }
  const reserved = tldRejection(tld);
  if (reserved) return res.json({ tld, available: false, reason: reserved });

  const owned = await getTld(tld);
  if (owned) {
    // Deliberately not the owning user id -- ownership is public, the account
    // behind it is not.
    return res.json({ tld, available: false, reason: "already registered", registered_at: owned.created_at });
  }
  res.json({ tld, available: true });
});

moshpitRouter.put("/api/moshpit/tlds/:tld/alias", async (req, res) => {
  if (!req.user) return unauthorized(res);
  const result = await setAlias({ from: req.params.tld, to: req.body?.to, userId: req.user.id });
  if (!result.ok) return bad(res, result.error || "could not set that alias");
  res.json({ from: normalizeTld(req.params.tld), to: normalizeTld(req.body?.to) });
});

moshpitRouter.delete("/api/moshpit/tlds/:tld/alias", async (req, res) => {
  if (!req.user) return unauthorized(res);
  const result = await clearAlias(req.params.tld, req.user.id);
  if (!result.ok) return bad(res, result.error || "could not clear that alias");
  res.json({ from: normalizeTld(req.params.tld), to: null });
});

moshpitRouter.get("/api/moshpit/tlds/:tld/exempt", async (req, res) => {
  const tld = normalizeTld(req.params.tld);
  if (!tld) return bad(res, "not a valid TLD");
  res.json({ tld, exempt: await listExempt(tld) });
});

moshpitRouter.post("/api/moshpit/tlds/:tld/exempt", async (req, res) => {
  if (!req.user) return unauthorized(res);
  const result = await setExempt({ tld: req.params.tld, label: req.body?.label, userId: req.user.id });
  if (!result.ok) return bad(res, result.error || "could not exempt that name");
  res.status(201).json({ tld: normalizeTld(req.params.tld), label: normalizeLabel(req.body?.label), exempt: true });
});

moshpitRouter.delete("/api/moshpit/tlds/:tld/exempt", async (req, res) => {
  if (!req.user) return unauthorized(res);
  const result = await clearExempt({ tld: req.params.tld, label: req.body?.label, userId: req.user.id });
  if (!result.ok) return bad(res, result.error || "could not clear that exemption");
  res.json({ tld: normalizeTld(req.params.tld), label: normalizeLabel(req.body?.label), exempt: false });
});

/* ---- names under a TLD ---- */

moshpitRouter.get("/api/moshpit/tlds/:tld/names", async (req, res) => {
  const tld = normalizeTld(req.params.tld);
  if (!tld) return bad(res, "not a valid TLD");
  res.json({ tld, names: await listNames(tld) });
});

moshpitRouter.post("/api/moshpit/tlds/:tld/names", async (req, res) => {
  if (!req.user) return unauthorized(res);
  const result = await registerName({
    tld: req.params.tld, label: req.body?.label, userId: req.user.id, target: req.body?.target,
  });
  if (!result.ok) return bad(res, result.error || "could not register that name", result.taken ? 409 : 400);
  res.status(201).json({ name: result.name });
});

moshpitRouter.put("/api/moshpit/tlds/:tld/names", async (req, res) => {
  if (!req.user) return unauthorized(res);
  const result = await setNameTarget({
    tld: req.params.tld, label: req.body?.label, userId: req.user.id, target: req.body?.target,
  });
  if (!result.ok) return bad(res, result.error || "could not retarget that name");
  res.json({ tld: normalizeTld(req.params.tld), label: normalizeLabel(req.body?.label), target: req.body?.target ?? null });
});

moshpitRouter.delete("/api/moshpit/tlds/:tld/names", async (req, res) => {
  if (!req.user) return unauthorized(res);
  const result = await releaseName({ tld: req.params.tld, label: req.body?.label, userId: req.user.id });
  if (!result.ok) return bad(res, result.error || "could not release that name");
  res.json({ tld: normalizeTld(req.params.tld), label: normalizeLabel(req.body?.label), released: true });
});

/* ---- the DNS records a name publishes ---- */

/**
 * GET /api/moshpit/records?name=scrambled.eggs — public.
 *
 * Public because DNS is: a record is published so that strangers can act on it,
 * and a zone nobody may read is a zone nobody may use. This is the endpoint a
 * resolver calls, so it answers the resolved name (aliases followed) rather
 * than the one that was typed.
 *
 * 404 with an empty list when the name publishes nothing, so a client can tell
 * "no records" from "not a name this registry answers for" — the first is a
 * name waiting to be pointed, the second is somebody else's namespace.
 */
moshpitRouter.get("/api/moshpit/records", async (req, res) => {
  const found = await recordsForName(req.query.name);
  if (!found) return res.status(404).json({ error: "not a Moshpit name", records: [] });

  const body = {
    name: found.name,
    resolved: found.resolved,
    name_registered: found.name_registered,
    target: found.target,
    records: found.records.map((r) => ({
      type: r.type, value: r.value, ttl: r.ttl, ...(r.priority === null ? {} : { priority: r.priority }),
    })),
    // The zone-file form, because the point of these being real records is that
    // they can be read, diffed and pasted by things that already speak DNS.
    zone: found.records.map((r) => zoneLine(found.resolved, r)),
  };
  return found.records.length ? res.json(body) : res.status(404).json(body);
});

/** GET /api/moshpit/tlds/:tld/records?label=blue — public, unresolved and exact. */
moshpitRouter.get("/api/moshpit/tlds/:tld/records", async (req, res) => {
  const tld = normalizeTld(req.params.tld);
  const label = normalizeLabel(req.query.label);
  if (!tld) return bad(res, "not a valid TLD");
  if (!label) return bad(res, "which name? pass ?label=");
  res.json({ tld, label, records: await listRecords(tld, label) });
});

/**
 * POST /api/moshpit/tlds/:tld/records { label, type, value, ttl?, priority? }
 *
 * 409 for a conflict with what the name already publishes, because that is what
 * it is: the request was well-formed and the state refused it. A 400 would tell
 * a script to fix its input, and there is nothing wrong with the input.
 */
moshpitRouter.post("/api/moshpit/tlds/:tld/records", async (req, res) => {
  if (!req.user) return unauthorized(res);
  const result = await addRecord({
    tld: req.params.tld, label: req.body?.label, userId: req.user.id,
    type: req.body?.type, value: req.body?.value, ttl: req.body?.ttl, priority: req.body?.priority,
  });
  if (!result.ok) {
    const conflict = /CNAME/.test(result.error || "");
    return bad(res, result.error || "could not publish that record", conflict ? 409 : 400);
  }
  res.status(201).json({ tld: normalizeTld(req.params.tld), label: normalizeLabel(req.body?.label), record: result.record });
});

/** DELETE /api/moshpit/tlds/:tld/records { label, type, value } */
moshpitRouter.delete("/api/moshpit/tlds/:tld/records", async (req, res) => {
  if (!req.user) return unauthorized(res);
  const result = await removeRecord({
    tld: req.params.tld, label: req.body?.label, userId: req.user.id,
    type: req.body?.type, value: req.body?.value,
  });
  if (!result.ok) return bad(res, result.error || "could not withdraw that record", 404);
  res.json({ tld: normalizeTld(req.params.tld), label: normalizeLabel(req.body?.label), removed: true });
});

/* ---- serving a name over the clearnet ---- */

/**
 * The canonical clearnet URL for a name. One name, one indexable address.
 *
 * config.pitOrigin, not config.origin: the pit answers on both hosts with
 * byte-identical pages, so canonicalising at the app host would name the wrong
 * one as the original and leave the two competing as duplicates of each other.
 */
const nameUrl = (name) => `${config.pitOrigin}/n/${encodeURIComponent(name)}`;

/**
 * Head tags for a name's page.
 *
 * These pages are the network's public surface — a name nobody holds is a page
 * somebody should be able to *find*, which is the whole pitch. So they get a
 * canonical URL and a description rather than being left to whatever a crawler
 * infers from a directory listing.
 *
 * An aliased name canonicalises to what it resolves to: `.agentic` pointing at
 * `.agent` means one page, reachable by two names, and saying so keeps the two
 * from competing as duplicates.
 */
function nameHead(resolution) {
  const canonical = nameUrl(resolution.resolved || resolution.name);
  const description = resolution.name_registered
    ? `${resolution.name} is registered on the Moshpit network.`
    : `${resolution.name} is unclaimed on the Moshpit network — take it in the pit.`;
  return `<link rel="canonical" href="${esc(canonical)}">
<meta name="description" content="${esc(description)}">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(resolution.name)}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:description" content="${esc(description)}">`;
}

/**
 * Crawlers get an explicit invitation rather than an inferred one.
 *
 * `/n/` is the point of the network being on the clearnet at all, so it is
 * named as allowed. The proxied half of a name (`/n/<name>/<path>`) is somebody
 * else's site reached through us and is not ours to get indexed under this
 * host, so only the name's own page is offered.
 */
moshpitRouter.get("/robots.txt", (_req, res) => {
  res.type("text/plain").send(`User-agent: *
Allow: /$
Allow: /pit
Allow: /n/
Disallow: /api/
Disallow: /app
Disallow: /settings
Disallow: /sessions

Sitemap: ${config.pitOrigin}/sitemap.xml
`);
});

/**
 * Every name and ending in the pit, as one file.
 *
 * Generated rather than stored: the namespace changes whenever somebody claims
 * something, and a sitemap that lags the registry is worse than none — it
 * advertises URLs that did not exist yet and omits the ones that do.
 */
moshpitRouter.get("/sitemap.xml", async (_req, res) => {
  const [names, tlds] = await Promise.all([listAllNames(), listTlds({ limit: 5000 })]);

  // Endings are listed now that `/n/<ending>` is a page rather than a 400 — an
  // ending with names under it is exactly the sort of thing worth finding.
  const urls = [
    `${config.pitOrigin}/pit`,
    ...tlds.map((t) => nameUrl(t.tld)),
    ...names.map((n) => nameUrl(`${n.label}.${n.tld}`)),
  ];

  res.type("application/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${esc(u)}</loc></url>`).join("\n")}
</urlset>
`);
});

/**
 * GET /n/:name — what a Moshpit name actually shows.
 *
 * The destination every resolver and the TronBrowser extension already points
 * at. Two outcomes: a name with a target is fetched and returned, and a name
 * without one gets a directory instead of a dead end — what else lives under
 * this ending, and which other endings are worth a look. A parked name is the
 * commonest thing anyone will land on, so it is the page that has to earn its
 * keep.
 */
moshpitRouter.get("/n/:name", async (req, res) => {
  const resolution = await resolveMoshpitName(req.params.name);
  if (!resolution) {
    // `/n/torklink` and `/n/.torklink` are an ending, not a name — and an
    // ending somebody holds is a real thing with names under it. It answered
    // "not a Moshpit name", which is true of the string and useless about the
    // registry. A leading dot is how people write endings, so accept it.
    const ending = normalizeTld(String(req.params.name || "").replace(/^\.+/, ""));
    const owner = ending ? await getTldWithPrice(ending) : null;
    if (owner) {
      const [names, aliasesTo, sameOwner, popular] = await Promise.all([
        listNames(ending),
        listAliasesTo(ending),
        listTldsForUser(owner.user_id, { limit: 50 }),
        popularLabels(),
      ]);
      // What could go under it next — the third question, after what is under
      // it and what is near it.
      const suggestions = suggestedLabels({
        tld: ending,
        taken: names.map((n) => n.label),
        popular,
      });
      return res.status(200).send(page({
        title: `.${ending}`,
        head: endingHead(ending, owner),
        body: endingDirectory({ tld: ending, owner, names, aliasesTo, sameOwner, suggestions, user: req.user, req }),
      }));
    }
    // Still 400 for an ending nobody holds: otherwise every typo under /n/
    // becomes a page, and the pit already answers "claim it" for a whole name.
    return res.status(400).send(page({ title: "moshpit", body: notAName(req.params.name) }));
  }

  const parsed = parseMoshpitName(resolution.resolved);
  const tld = parsed?.tld;

  if (resolution.target) {
    const check = await checkTarget(resolution.target);
    if (!check.ok) {
      // Named plainly rather than shown as a generic failure: the owner is the
      // only one who can fix it, and "target is link-local" tells them how.
      return res.status(502).send(page({
        title: resolution.name,
        body: unreachable(resolution, check.error),
      }));
    }
    return proxyToOrigin(req, res, resolution, check);
  }

  // No target: the directory.
  const [names, tlds] = await Promise.all([
    tld ? listNames(tld) : Promise.resolve([]),
    listTlds({ limit: 200 }),
  ]);
  const owner = tld ? await getTldWithPrice(tld) : null;

  // Quoted rather than assumed: quoteName is the same call the checkout makes,
  // so an offer shown here is one the next click can actually honour — no
  // button for a name that is reserved, already sold, or on an ending whose
  // owner never set a price.
  const quote = !resolution.name_registered && req.user && tld
    ? await quoteName({ tld, label: parsed.label, buyerId: req.user.id })
    : null;

  // 200, not 404, even when nobody holds the name. The URL does have a
  // resource — this directory is the parking page every resolver and the
  // browser extension send unpointed names to, and it is the answer, not the
  // absence of one. A 404 makes a working page read as broken to the browser,
  // to a link checker, and to anything that treats the status before the body.
  res.status(200).send(page({
    title: resolution.name,
    head: nameHead(resolution),
    body: directory({ resolution, tld, owner, names, tlds, quote, user: req.user, req }),
  }));
});

/** Fetch the origin and hand the result back, bounded in time and size. */
async function proxyToOrigin(req, res, resolution, check) {
  const name = resolution.resolved;
  const headers = forwardableHeaders(req.headers, name);
  const path = req.originalUrl.replace(/^\/n\/[^/?]+/, "") || "/";

  try {
    let upstream = await fetchOrigin({
      host: check.host,
      port: check.port,
      path,
      headers,
      timeoutMs: ORIGIN_TIMEOUT_MS,
      maxBytes: MAX_BODY_BYTES,
    });

    // An origin that upgrades to HTTPS is the normal shape for a Moshpit name.
    // Handing that redirect to the browser is useless — it cannot resolve the
    // name, and no CA will have issued for the ending — so follow it here,
    // authenticating the origin against the pin its owner published.
    const upgrade = upstream.status >= 300 && upstream.status < 400
      ? tlsRedirect(upstream.headers.location, { name, host: check.host })
      : null;

    if (upgrade) {
      const parsed = parseMoshpitName(name);
      const pins = parsed
        ? (await listPins(parsed.tld, parsed.label, "tls")).map((row) => row.pin)
        : [];
      try {
        upstream = await fetchOriginTls({
          host: check.host,
          port: upgrade.port,
          servername: name,
          path: upgrade.path,
          headers,
          pins,
          timeoutMs: ORIGIN_TIMEOUT_MS,
          maxBytes: MAX_BODY_BYTES,
        });
      } catch (error) {
        // Distinguished from a generic failure because each has exactly one
        // fix and it belongs to a different person: the owner publishes a pin,
        // or somebody works out why the key changed.
        const why = error.name === "NoPinError"
          ? "this name redirects to HTTPS, but its owner has not published a key pin — "
            + "without one there is no way to tell the real origin from an impostor"
          : error.name === "PinError"
            ? `the origin's key does not match the pin published for this name — ${error.message}`
            : "the origin could not be reached over HTTPS";
        return res.status(502).send(page({ title: resolution.name, body: unreachable(resolution, why) }));
      }
    }

    // Only what a page needs. Passing the origin's Set-Cookie through would let
    // a name's owner set cookies on app.moshcode.sh, which is where accounts
    // live — that is a session-fixation hole, not a feature.
    const type = upstream.headers["content-type"];
    if (type) res.set("content-type", type);
    res.set("x-moshpit-name", resolution.resolved);
    res.set("content-security-policy", "sandbox allow-scripts allow-forms allow-popups");

    if (upstream.truncated) {
      return res.status(502).send(page({ title: resolution.name, body: unreachable(resolution, "response too large") }));
    }
    return res.status(upstream.status).send(upstream.body);
  } catch (error) {
    const why = error.name === "AbortError" ? "the origin did not answer in time" : "the origin could not be reached";
    return res.status(504).send(page({ title: resolution.name, body: unreachable(resolution, why) }));
  }
}

/** Head tags for an ending's page — the same treatment a name's page gets. */
function endingHead(tld, owner) {
  const canonical = `${config.pitOrigin}/n/${encodeURIComponent(tld)}`;
  const description = owner?.price_usd != null
    ? `Names under .${tld} on the Moshpit network cost $${owner.price_usd}.`
    : `.${tld} is claimed on the Moshpit network.`;
  return `<link rel="canonical" href="${esc(canonical)}">
<meta name="description" content="${esc(description)}">
<meta property="og:type" content="website">
<meta property="og:title" content=".${esc(tld)}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:description" content="${esc(description)}">`;
}

/**
 * The page for an ending somebody holds.
 *
 * Deliberately not the name directory with a blank label: what a visitor can do
 * here is different. There is no specific name to buy, so the offer is the
 * ending's price and a box to pick a name under it — and the listing is the
 * whole ending rather than "what else lives near the name you asked for".
 */
function endingDirectory({ tld, owner, names, aliasesTo = [], sameOwner = [], suggestions = [], user, req }) {
  const live = names.filter((n) => n.target);
  const claimed = names.filter((n) => !n.target);
  const nameLink = (n) =>
    `<a class="mono acid" href="/n/${esc(n.label)}.${esc(tld)}">${esc(n.label)}.${esc(tld)}</a>`;
  // An ending links to its own page — there is no label to carry across here,
  // which is what makes this different from the name directory's version.
  const endingLink = (t) => `<a class="mono" href="/n/${esc(t.tld)}">.${esc(t.tld)}</a>`;
  const mine = Boolean(user && owner.user_id === user.id);

  // Aliases are an explicit statement that two endings belong together, so they
  // are named as pointers rather than folded into "related". Shared ownership
  // is the next best signal and fills the rest.
  const pointedHereBy = aliasesTo.filter((t) => t.tld !== tld);
  const alreadyShown = new Set([tld, owner.alias_of, ...pointedHereBy.map((t) => t.tld)]);
  const related = sameOwner.filter((t) => !alreadyShown.has(t.tld)).slice(0, 24);

  // Facts already public through /api/moshpit/tlds, gathered where somebody
  // deciding whether to buy under this ending will actually see them. Owner
  // email is deliberately not among them: the API exposing it is not a reason
  // to put it on a page built to be crawled.
  const claimedOn = Number(owner.created_at)
    ? new Date(Number(owner.created_at)).toISOString().slice(0, 10)
    : null;
  const facts = [
    `${names.length} name${names.length === 1 ? "" : "s"}`,
    `${live.length} pointed somewhere`,
    owner.price_usd != null ? `$${owner.price_usd} a name` : "not for sale",
    owner.alias_of ? `points at .${owner.alias_of}` : null,
    // The verb agrees too: "1 ending points here", "2 endings point here".
    pointedHereBy.length
      ? `${pointedHereBy.length} ending${pointedHereBy.length === 1 ? " points" : "s point"} here`
      : null,
    claimedOn ? `claimed ${claimedOn}` : null,
  ].filter(Boolean);

  // A suggestion goes to the claim box with the name already filled in, which
  // is the same path the "See if it is free" form takes — so the offer and the
  // shortcut cannot disagree about what happens next.
  const suggestionLink = (label) =>
    `<a class="mono" href="/pit?name=${encodeURIComponent(`${label}.${tld}`)}">${esc(label)}.${esc(tld)}</a>`;

  return `
<section class="pit-panel">
  <h1 class="acid">.${esc(tld)}</h1>
  <p class="dim">
    ${mine ? "You hold this ending." : "Somebody holds this ending."}
    ${owner.price_usd != null
      ? `Names under it cost <span class="mono acid">$${esc(String(owner.price_usd))}</span>.`
      : "Names under it are not for sale right now."}
  </p>
  <p class="mono faint" style="font-size:.72rem">${facts.map(esc).join(" &middot; ")}</p>

  ${owner.alias_of
    ? `<p class="mono faint" style="font-size:.72rem">.${esc(tld)} &rarr; <a class="mono acid" href="/n/${esc(owner.alias_of)}">.${esc(owner.alias_of)}</a> &mdash; names here resolve under that ending.</p>`
    : ""}
  ${pointedHereBy.length ? `
  <p class="mono faint" style="font-size:.72rem">Pointed here by ${pointedHereBy.map((t) => `${endingLink(t)} &rarr; .${esc(tld)}`).join(" &middot; ")}</p>` : ""}

  ${owner.price_usd != null && !mine ? `
  <form method="get" action="/pit" class="pit-form" style="margin-top:18px">
    <label class="pit-field"><input name="name" placeholder="yourname.${esc(tld)}"
      aria-label="the name you want under this ending" autocomplete="off" spellcheck="false" required></label>
    <button class="btn acid" type="submit">See if it is free</button>
  </form>` : ""}

  ${live.length ? `
  <h2 class="acid" style="font-size:.9rem;margin-top:26px">Sites on .${esc(tld)}</h2>
  <ul class="pit-dir">${live.map((n) => `<li>${nameLink(n)} <span class="faint mono">&rarr; ${esc(n.target)}</span></li>`).join("")}</ul>` : ""}

  ${claimed.length ? `
  <h2 class="acid" style="font-size:.9rem;margin-top:26px">Claimed, not pointed anywhere</h2>
  <ul class="pit-dir">${claimed.map((n) => `<li>${nameLink(n)}</li>`).join("")}</ul>` : ""}

  ${names.length ? "" : `<p class="mono faint" style="font-size:.72rem;margin-top:26px">Nothing lives under .${esc(tld)} yet.</p>`}

  ${suggestions.length ? `
  <h2 class="acid" style="font-size:.9rem;margin-top:26px">${mine ? `Yours to mint` : `Still free under .${esc(tld)}`}</h2>
  <p class="mono faint" style="font-size:.72rem">${mine
    ? "You hold this ending, so these cost nothing."
    : "Nobody has taken these yet."}</p>
  <p class="pit-dir-row">${suggestions.map(suggestionLink).join(" &middot; ")}</p>` : ""}

  ${related.length ? `
  <h2 class="acid" style="font-size:.9rem;margin-top:22px">Related endings</h2>
  <p class="pit-dir-row">${related.map(endingLink).join(" &middot; ")}</p>` : ""}

  <p style="margin-top:26px"><a class="btn" href="/pit">the pit &rarr;</a></p>
</section>`;
}

const notAName = (typed) => `
<section class="pit-panel">
  <h1 class="acid">not a Moshpit name</h1>
  <p class="dim"><span class="mono">${esc(typed)}</span> is not one label and one ending.</p>
  <p><a class="btn acid" href="/pit">the pit →</a></p>
</section>`;

const unreachable = (resolution, why) => `
<section class="pit-panel">
  <h1 class="acid">${esc(resolution.name)}</h1>
  <p class="dim">This name points somewhere that could not be served: ${esc(why)}.</p>
  <p class="mono faint" style="font-size:.72rem">Its owner can repoint it from the pit.</p>
  <p><a class="btn" href="/pit">the pit →</a></p>
</section>`;

/**
 * The page a parked name shows.
 *
 * Everything here is a link to something else in the namespace, because the
 * person reading it typed a name that has nothing behind it and the useful
 * answer is what does. Live sites first — they are the only entries that go
 * anywhere real — then the rest of the ending, then other endings.
 */
function directory({ resolution, tld, owner, names, tlds, quote, user, req }) {
  const live = names.filter((n) => n.target);
  const claimed = names.filter((n) => !n.target);

  // "Related" without a taxonomy: an alias is an explicit statement by an
  // operator that two endings belong together, and shared ownership is the
  // next best signal. Everything else is just the rest of the namespace.
  const related = tlds.filter((t) =>
    t.tld !== tld && (t.alias_of === tld || (owner && t.user_id === owner.user_id)));
  const others = tlds.filter((t) => t.tld !== tld && !related.includes(t)).slice(0, 24);

  const nameLink = (n) =>
    `<a class="mono acid" href="/n/${esc(n.label)}.${esc(tld)}">${esc(n.label)}.${esc(tld)}</a>`;
  // An ending in this list goes to the name you are already reading, under that
  // ending — from scrambled.eggs, `.yolks` is /n/scrambled.yolks. The label is
  // the question the visitor asked; the ending is the only part being offered
  // as an alternative, so carrying the label across is what "related" is for.
  //
  // These used to point at /pit?tab=theirs&q=, which answers a different
  // question: it leaves the name behind and drops you in the operator's
  // listing. That is a detour on the one page whose whole job is to say where
  // else this name could live.
  //
  // Every ending here goes to /n/, without exception. A name whose halves are
  // both numeric is refused by parseMoshpitName as an IPv4 literal, so
  // /n/420.187 answers 400 — that is accepted deliberately. The namespace is
  // the destination, and one ending quietly leaving it for a search page is a
  // worse inconsistency than a link that says plainly it is not a name.
  const label = parseMoshpitName(resolution.resolved)?.label ?? null;
  const tldLink = (t) =>
    `<a class="mono" href="/n/${esc(label)}.${esc(t.tld)}">.${esc(t.tld)}</a>`;

  return `
<section class="pit-panel">
  <h1 class="acid">${esc(resolution.name)}</h1>
  <p class="dim">
    ${resolution.name_registered
      ? "This name is claimed but does not point anywhere yet."
      : "Nobody holds this name."}
  </p>
  ${resolution.name_registered ? "" : buyBox({ resolution, tld, owner, quote, user, req })}

  ${live.length ? `
  <h2 class="acid" style="font-size:.9rem;margin-top:26px">Sites on .${esc(tld)}</h2>
  <ul class="pit-dir">${live.map((n) => `<li>${nameLink(n)} <span class="faint mono">→ ${esc(n.target)}</span></li>`).join("")}</ul>`
    : `<p class="mono faint" style="font-size:.72rem;margin-top:26px">No site under .${esc(tld)} points anywhere yet.</p>`}

  ${claimed.length ? `
  <h2 class="acid" style="font-size:.9rem;margin-top:22px">Also claimed on .${esc(tld)}</h2>
  <ul class="pit-dir">${claimed.slice(0, 40).map((n) => `<li>${nameLink(n)}</li>`).join("")}</ul>` : ""}

  ${related.length ? `
  <h2 class="acid" style="font-size:.9rem;margin-top:22px">Related endings</h2>
  <p class="pit-dir-row">${related.map(tldLink).join(" · ")}</p>` : ""}

  ${others.length ? `
  <h2 class="acid" style="font-size:.9rem;margin-top:22px">More endings</h2>
  <p class="pit-dir-row">${others.map(tldLink).join(" · ")}</p>` : ""}

  <p style="margin-top:26px"><a class="btn acid" href="/pit">the pit →</a></p>
</section>`;
}

/**
 * The offer on an unclaimed name.
 *
 * Every branch here is a different reason someone cannot just buy it, and each
 * says which — "not for sale" and "sign in first" and "you own this ending" are
 * three different problems and a single greyed-out button would tell you none
 * of them.
 *
 * The price comes from a real quote, so the button is only shown when the
 * checkout behind it would succeed.
 */
function buyBox({ resolution, tld, owner, quote, user, req }) {
  const name = esc(resolution.name);

  if (!user) {
    return `<p class="pit-buy"><a class="btn acid" href="/">Sign in to claim ${name} →</a></p>`;
  }
  if (owner && owner.user_id === user.id) {
    // Your own ending: minting is free, so offering to sell it to you would be
    // charging for something you already have.
    return `<p class="pit-buy">
      <span class="dim">.${esc(tld)} is yours — mint this name for nothing.</span>
      <a class="btn acid" href="/pit?tab=yours">the pit →</a></p>`;
  }
  if (!owner) {
    return `<p class="pit-buy">
      <span class="dim">Nobody holds .${esc(tld)} either.</span>
      <a class="btn acid" href="/pit">Claim the whole ending →</a></p>`;
  }
  if (!quote?.ok) {
    const why = quote?.taken ? esc(quote.error) : `.${esc(tld)} is not for sale`;
    return `<p class="pit-buy"><span class="dim">${why}.</span></p>`;
  }

  return `
<form method="post" action="/pit/${esc(tld)}/buy" class="pit-buy">
  ${csrfInput(req)}
  <input type="hidden" name="label" value="${esc(quote.label)}">
  <button class="btn acid" type="submit">Buy ${name} — $${esc(String(quote.priceUsd))}</button>
  <span class="mono faint" style="font-size:.7rem">one-time, paid in crypto via CoinPay</span>
</form>`;
}

/* ---- the keys a name may present ---- */

/**
 * GET /api/moshpit/pins?name=scrambled.eggs[&kind=tls] — public.
 *
 * The lookup every Moshpit client makes before it will talk to anything. The
 * status codes carry meaning the body does not, because clients cache on them:
 *
 *   400  not a Moshpit name      a definite no, cacheable as long as a real answer
 *   404  no key published        also definite — nobody has vouched for a key here
 *   200  { pins: [...] }         the keys a peer may present
 *
 * What matters is that both differ from a 5xx or a timeout. A definite no means
 * refuse the connection; an outage means try again later. A client that treats
 * them alike either fails closed forever or fails open once, and the second is
 * how pinning gets quietly defeated.
 */
moshpitRouter.get("/api/moshpit/pins", async (req, res) => {
  const name = String(req.query.name ?? "").trim();
  if (!name) return bad(res, "name is required");

  const requested = req.query.kind ? String(req.query.kind) : null;
  const kind = requested ? normalizePinKind(requested) : null;
  if (requested && !kind) return bad(res, `kind must be one of ${PIN_KINDS.join(", ")}`);

  const found = await pinsForName(name, kind);
  if (!found) return bad(res, "not a Moshpit name");

  const body = {
    name: found.name,
    resolved: found.resolved,
    tld: found.tld,
    label: found.label,
    target: found.target,
    // A flat array of strings first: that is all a client needs in order to
    // compare against what a peer actually presented.
    pins: found.pins.map((p) => p.pin),
    entries: found.pins.map((p) => ({ pin: p.pin, kind: p.kind, note: p.note })),
  };
  return found.pins.length ? res.json(body) : res.status(404).json(body);
});

/** GET /api/moshpit/tlds/:tld/pins?label=blue — public; pins are public by nature. */
moshpitRouter.get("/api/moshpit/tlds/:tld/pins", async (req, res) => {
  const tld = normalizeTld(req.params.tld);
  const label = normalizeLabel(req.query.label);
  if (!tld || !label) return bad(res, "tld and label are required");

  const requested = req.query.kind ? String(req.query.kind) : null;
  const kind = requested ? normalizePinKind(requested) : null;
  if (requested && !kind) return bad(res, `kind must be one of ${PIN_KINDS.join(", ")}`);

  res.json({ tld, label, pins: await listPins(tld, label, kind) });
});

/**
 * POST /api/moshpit/tlds/:tld/pins { label, pin, kind, note? } — publish a key.
 *
 * Adds rather than replaces, so rotation has a window: publish the new key
 * alongside the old, deploy it, then withdraw the old. Replacing outright would
 * break every client between the write and the deploy.
 */
moshpitRouter.post("/api/moshpit/tlds/:tld/pins", async (req, res) => {
  if (!req.user) return unauthorized(res);
  const result = await addPin({
    tld: req.params.tld,
    label: req.body?.label,
    pin: req.body?.pin,
    kind: req.body?.kind,
    note: req.body?.note,
    userId: req.user.id,
  });
  // 409 when the pin is already published under another kind: the request was
  // well formed, it just contradicts what is already there.
  if (!result.ok) return bad(res, result.error || "could not publish that pin", result.taken ? 409 : 400);
  res.status(201).json({ tld: normalizeTld(req.params.tld), label: normalizeLabel(req.body?.label), kind: req.body?.kind });
});

/** DELETE /api/moshpit/tlds/:tld/pins { label, pin } — withdraw a key. */
moshpitRouter.delete("/api/moshpit/tlds/:tld/pins", async (req, res) => {
  if (!req.user) return unauthorized(res);
  const result = await removePin({
    tld: req.params.tld, label: req.body?.label, pin: req.body?.pin, userId: req.user.id,
  });
  if (!result.ok) return bad(res, result.error || "could not withdraw that pin", 404);
  res.json({ tld: normalizeTld(req.params.tld), label: normalizeLabel(req.body?.label), withdrawn: true });
});

/* ---- the market ---- */

/** TLDs other people hold. `?for_sale=1` narrows to the buyable ones. */
moshpitRouter.get("/api/moshpit/market", async (req, res) => {
  const tlds = await listTldsNotOwnedBy(req.user?.id ?? null, { forSale: Boolean(req.query.for_sale) });
  res.json({
    tlds: tlds.map((t) => ({
      tld: t.tld, alias_of: t.alias_of, price_usd: t.price_usd,
      for_sale: t.price_usd !== null && t.price_usd !== undefined,
    })),
  });
});

/** What a name would cost, and whether it can be bought at all. */
moshpitRouter.get("/api/moshpit/tlds/:tld/quote", async (req, res) => {
  const q = await quoteName({ tld: req.params.tld, label: req.query.label, buyerId: req.user?.id ?? null });
  if (!q.ok) return bad(res, q.error, q.taken ? 409 : 400);
  res.json({ tld: q.tld, label: q.label, price_usd: q.priceUsd });
});

moshpitRouter.put("/api/moshpit/tlds/:tld/price", async (req, res) => {
  if (!req.user) return unauthorized(res);
  const result = await setTldPrice({ tld: req.params.tld, userId: req.user.id, priceUsd: req.body?.price_usd });
  if (!result.ok) return bad(res, result.error || "could not set that price");
  res.json({ tld: result.tld, price_usd: result.priceUsd });
});

/**
 * Start a CoinPay checkout for `label.tld`.
 *
 * The quote is taken again here rather than trusted from the page the buyer was
 * looking at: prices change, and names get taken, between rendering and
 * clicking. settleNamePurchase checks a third time, because the gap between
 * paying and confirming is where the last race lives.
 */
async function startCheckout(req, res, { json }) {
  const q = await quoteName({ tld: req.params.tld, label: req.body?.label, buyerId: req.user.id });
  if (!q.ok) {
    return json ? bad(res, q.error, q.taken ? 409 : 400) : back(res, { err: q.error }, "theirs");
  }
  if (!config.coinpay.businessId) {
    const msg = "payments are not configured yet";
    return json ? bad(res, msg, 503) : back(res, { err: msg }, "theirs");
  }

  try {
    const r = await fetch(`${config.coinpay.apiBase}/api/payments/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        business_id: config.coinpay.businessId,
        amount: q.priceUsd,
        currency: "USD",
        payment_method: "both",
        metadata: { app: "moshcode", kind: "moshpit_name", user_id: req.user.id, tld: q.tld, label: q.label },
        redirect_url: `${config.origin}/pit?bought=${encodeURIComponent(`${q.label}.${q.tld}`)}`,
      }),
    });
    const pay = await r.json();
    const payId = pay.id || pay.payment_id;
    if (!payId) throw new Error("no payment id in response");

    // Recorded before the buyer leaves for the payment page: the webhook can
    // arrive before they are redirected back, and with no row it has nothing
    // to settle.
    await openNamePurchase({ paymentId: payId, tld: q.tld, label: q.label, userId: req.user.id, amountUsd: q.priceUsd });

    const url = pay.hosted_url || pay.url || `${config.coinpay.apiBase}/pay/${payId}`;
    return json ? res.status(201).json({ payment_id: payId, checkout_url: url, price_usd: q.priceUsd }) : res.redirect(url);
  } catch (e) {
    console.error("[moshpit] checkout failed:", e.message);
    const msg = "could not start checkout";
    return json ? bad(res, msg, 502) : back(res, { err: msg }, "theirs");
  }
}

moshpitRouter.post("/api/moshpit/tlds/:tld/buy", async (req, res) => {
  if (!req.user) return unauthorized(res);
  return startCheckout(req, res, { json: true });
});

/**
 * Resolve a name, and say what a resolver should DO with the answer.
 *
 * `mode` is the tronbrowser.dev setting: "clearnet" (default) keeps legacy DNS
 * authoritative and uses the pit only to fill gaps; "moshpit" lets a registered
 * name outrank DNS, which is how a squatted `profullstack.ai` gets backfilled
 * by the pit's own `profullstack.ai`.
 *
 * We do not check whether clearnet answers -- the extension is the thing
 * holding the DNS result, and an ICANN TLD list baked in here would be stale
 * within the week. The server states the rule; the client applies it.
 */
moshpitRouter.get("/api/moshpit/resolve", async (req, res) => {
  const mode = normalizeMode(req.query.mode);
  const resolution = await resolveMoshpitName(req.query.name);
  if (!resolution) {
    return res.status(400).json({
      error: "not a valid moshpit name — expected <label>.<tld>",
      name: String(req.query.name ?? ""), mode,
    });
  }
  // `?records=1` only. Every DNS query on the network lands here, and the
  // records are a second query against a second table — a resolver that only
  // wants an address (which is all the bridge and the DoH server ask for) must
  // not pay for a lookup it will throw away. Callers that want the whole set
  // ask for it, or use /api/moshpit/records.
  const resolved = parseMoshpitName(resolution.resolved);
  const records = req.query.records && resolution.name_registered && resolved
    ? await listRecords(resolved.tld, resolved.label)
    : null;

  res.json({
    ...resolution,
    ...(records ? { records: records.map((r) => ({ type: r.type, value: r.value, ttl: r.ttl, ...(r.priority === null ? {} : { priority: r.priority }) })) } : {}),
    mode,
    prefer: resolutionPreference({ registered: resolution.registered, mode }),
  });
});

/* ---------- the human page ---------- */

/**
 * The settings applied to everything a single submission claims.
 *
 * Optional, and blank means "leave it alone" rather than "clear it" — the same
 * two knobs a claimed ending already has on its own row, offered at the moment
 * you claim it so a list of forty does not need forty follow-up edits.
 */
const claimDefaults = (req) => `
<div class="pit-defaults">
  <label>Price each
    <span class="pit-dot">$</span><input name="price_usd" type="number" min="0.01" step="0.01" max="${MAX_LISTING_PRICE_USD}"
      value="${DEFAULT_TLD_PRICE_USD}" placeholder="unlisted" autocomplete="off"
      aria-label="price per name, in dollars — what you charge is yours to set; clear it to keep them off the market"></label>
  <label>Point at
    <span class="pit-dot">.</span><input name="alias_of" placeholder="nothing"
      autocomplete="off" spellcheck="false" aria-label="an ending you already hold"></label>
</div>`;

const claimForm = (req, prefill = "") => `
<form method="post" action="/pit/claim" class="pit-form">
  ${csrfInput(req)}
  <label class="pit-field"><span class="pit-dot">.</span
    ><input name="tld" placeholder="eggs — or scrambled.eggs"
      aria-label="the ending you want, or a whole name under it" autocomplete="off" spellcheck="false"
      value="${esc(prefill)}" required></label>
  ${claimDefaults(req)}
  <button class="btn acid" type="submit">Claim it</button>
</form>`;

/**
 * The same claim, for a list.
 *
 * Behind a <details> because one ending at a time is the common case and a
 * textarea would otherwise be the loudest thing on the page. Open, it accepts
 * whatever shape the list arrived in — a pasted column, a comma-separated
 * export, dots on or off.
 */
const bulkClaimForm = (req) => `
<details class="pit-bulk">
  <summary>…or paste a list</summary>
  <form method="post" action="/pit/claim-bulk">
    ${csrfInput(req)}
    <textarea name="tlds" rows="8" spellcheck="false" autocomplete="off" required
      aria-label="endings to claim, one per line"
      placeholder=".eggs
.yeah $5USD
.toplevel .redirect $2.00USD
oranges, pears, plums
# one per line · dots optional · add a price and/or an ending to point at
# anything on a line beats the defaults below · # comments ignored"></textarea>
    ${claimDefaults(req)}
    <p class="mono faint" style="font-size:.7rem;margin:8px 0 10px">
      Up to ${shortCount(MAX_BULK_TLDS)} at a time. Ones already taken are reported, not fatal —
      the rest still land. The price and target below apply to every ending that
      lands, unless a line says otherwise.
    </p>
    <button class="btn acid" type="submit">Claim them all</button>
  </form>
</details>`;

/**
 * The card someone lands on after typing `mosh.whatever` somewhere.
 *
 * A resolver or the gateway sent them here because the name did not resolve to
 * a site. They have just demonstrated demand for a name, so the page opens
 * with the shortest path from wanting it to holding it — and says plainly when
 * there is no such path, rather than inviting them into a flow that does not
 * exist.
 */
const landingCard = (req, landing) => {
  if (!landing || landing.kind === "none") return "";
  const name = `<span class="mono acid">${esc(landing.name)}</span>`;
  const tld = `<span class="mono acid">.${esc(landing.tld)}</span>`;

  if (landing.kind === "claim-tld") {
    return `<div class="pit-land">
      <p class="label">you asked for ${esc(landing.name)}</p>
      <h2>Nobody holds ${tld}.</h2>
      <p class="pit-copy">Claim the ending and ${name} — plus every other name under it — is yours to
        point wherever you like. First come, first served, and nobody can take it back.</p>
      ${req.user ? claimForm(req, landing.tld)
        : `<p class="pit-copy">Sign in with your moshcode account to claim it — the same login the CLI uses.</p>
           <p><a class="btn acid" href="/">Sign in →</a></p>`}
    </div>`;
  }

  if (landing.kind === "mint-name") {
    return `<div class="pit-land">
      <p class="label">you asked for ${esc(landing.name)}</p>
      <h2>${tld} is yours. ${name} is one click away.</h2>
      <p class="pit-copy">Register the name and point it at whatever should answer for it — a host, an
        address, or nothing yet.</p>
      <form method="post" action="/pit/${esc(landing.tld)}/names" class="pit-row">
        ${csrfInput(req)}
        <input type="hidden" name="label" value="${esc(landing.label)}">
        <span class="mono acid">${esc(landing.name)}</span>
        <input name="target" placeholder="points at… (IPv6 or hostname, optional)" autocomplete="off">
        <button class="btn acid" type="submit">Register it</button>
      </form>
    </div>`;
  }

  if (landing.kind === "yours") {
    return `<div class="pit-land">
      <p class="label">you asked for ${esc(landing.name)}</p>
      <h2>${name} is already yours.</h2>
      <p class="pit-copy">It is in your list below — change where it points, or release it.</p>
    </div>`;
  }

  if (landing.kind === "taken") {
    return `<div class="pit-land">
      <p class="label">you asked for ${esc(landing.name)}</p>
      <h2>${name} is taken.</h2>
      <p class="pit-copy">Someone else holds ${tld} and has minted this name${
        landing.target ? `, pointing it at <span class="mono">${esc(landing.target)}</span>` : ""
      }. Claim an ending of your own below and you will never have to ask anyone for a name again.</p>
    </div>`;
  }

  if (landing.kind === "buy") {
    const price = esc(String(landing.priceUsd));
    return `<div class="pit-land">
      <p class="label">you asked for ${esc(landing.name)}</p>
      <h2>${name} is free. ${tld} sells names at $${price}.</h2>
      <p class="pit-copy">Buy it and it is yours to point wherever you like — the operator of the ending
        keeps the money, and nobody can take the name back.</p>
      ${req.user ? `
      <form method="post" action="/pit/${esc(landing.tld)}/buy" class="pit-row">
        ${csrfInput(req)}
        <input type="hidden" name="label" value="${esc(landing.label)}">
        <span class="mono acid">${esc(landing.name)}</span>
        <button class="btn acid" type="submit">Buy for $${price}</button>
      </form>`
      : `<p class="pit-copy">Sign in with your moshcode account to buy it — the same login the CLI uses.</p>
         <p><a class="btn acid" href="/">Sign in →</a></p>`}
    </div>`;
  }

  // not-for-sale: the name is free, but the operator has not put a price on
  // names under their ending, and `quoteName` refuses without one. Saying so
  // beats a checkout button that dead-ends.
  return `<div class="pit-land">
    <p class="label">you asked for ${esc(landing.name)}</p>
    <h2>${name} is free, but ${tld} is not selling.</h2>
    <p class="pit-copy">Whoever holds the ending has not put a price on names under it. Claim an ending
      of your own below — or take the same label under one that is selling.</p>
  </div>`;
};

const PIT_CSS = `
.pit-form{display:flex;gap:10px;flex-wrap:wrap;align-items:stretch;margin:18px 0 8px}
.pit-field{display:flex;align-items:center;gap:2px;background:var(--surface);border:1px solid var(--line-2);
  border-radius:var(--r);padding:0 14px;min-width:240px;flex:1 1 240px}
.pit-field:focus-within{border-color:var(--acid)}
.pit-dot{font-family:var(--mono);color:var(--acid);font-size:1.2rem}
.pit-field input{flex:1;background:transparent;border:0;outline:0;color:var(--text);
  font-family:var(--mono);font-size:1.2rem;padding:13px 0}
.pit-field input::placeholder{color:var(--faint)}
.pit-tld{border:1px solid var(--line);border-radius:var(--r);background:var(--surface);padding:14px 16px;margin-bottom:10px}
.pit-tld h3{font-family:var(--mono);font-size:1.1rem;text-transform:none}
.pit-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:10px}
.pit-row input{background:var(--bg-tint);border:1px solid var(--line-2);border-radius:8px;color:var(--text);
  font-family:var(--mono);font-size:.82rem;padding:8px 10px;min-width:120px}
.pit-names{margin-top:12px;padding-top:10px;border-top:1px dashed var(--line)}
.pit-name{background:var(--bg-tint);border-radius:8px;padding:6px 10px;margin-bottom:6px}
.pit-name .mono{min-width:150px}
.pit-forsale{border-color:color-mix(in srgb,var(--acid) 35%,var(--line))}
.pit-tab .count{font-size:.68rem;color:var(--faint);margin-left:6px}
.pit-tab.on .count{color:var(--acid)}
.pit-msg{border-radius:8px;padding:10px 14px;margin:14px 0;font-family:var(--mono);font-size:.84rem}
.pit-msg.err{border:1px solid var(--danger);color:var(--danger)}
.pit-msg.ok{border:1px solid var(--acid);color:var(--acid)}
.pit-defaults{display:flex;gap:12px;flex-wrap:wrap;margin:10px 0 4px}
.pit-defaults label{display:flex;align-items:center;gap:6px;font-family:var(--mono);
  font-size:.72rem;letter-spacing:.06em;color:var(--dim);white-space:nowrap}
.pit-defaults input{width:11ch;padding:7px 9px;font-size:.78rem}
.pit-buy{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:16px 0 4px;
  padding:14px;border:1px solid var(--line);border-radius:8px;background:var(--bg)}
.pit-dir{list-style:none;padding:0;margin:10px 0;display:grid;gap:4px}
.pit-dir li{font-size:.82rem}
.pit-dir-row{line-height:2;max-width:70ch}
.pit-dir-row a{color:var(--dim);text-decoration:none}
.pit-dir-row a:hover{color:var(--acid)}
.pit-bulk{margin:0 0 18px;max-width:62ch}
.pit-bulk summary{font-family:var(--mono);font-size:.74rem;letter-spacing:.08em;color:var(--dim);cursor:pointer;padding:6px 0}
.pit-bulk summary:hover{color:var(--acid)}
.pit-bulk textarea{width:100%;box-sizing:border-box;background:var(--bg);color:var(--text);
  border:1px solid var(--line);border-radius:6px;padding:10px 12px;font-family:var(--mono);
  font-size:.8rem;line-height:1.55;resize:vertical;min-height:9em}
.pit-bulk textarea:focus{outline:none;border-color:var(--acid)}
.pit-tabs{display:flex;gap:4px;margin:22px 0 26px;border-bottom:1px solid var(--line)}
.pit-filter{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:0 0 16px}
.pit-filter input[name=q]{flex:1;min-width:220px}
.pit-hits{display:flex;flex-direction:column;gap:2px;margin:0 0 18px}
.pit-hit{display:flex;justify-content:space-between;gap:12px;padding:7px 10px;border:1px solid var(--line);border-radius:6px;text-decoration:none;font-size:.78rem}
.pit-hit:hover{border-color:var(--acid)}
.pit-pager{display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap;margin:22px 0 4px;font-size:.72rem}
.pit-pager .btn[aria-disabled]{opacity:.4;pointer-events:none}
.pit-tab{font-family:var(--mono);font-size:.76rem;letter-spacing:.12em;text-transform:uppercase;color:var(--dim);
  padding:11px 15px;border-bottom:2px solid transparent;margin-bottom:-1px}
.pit-tab:hover{color:var(--text)}
.pit-tab.on{color:var(--acid);border-bottom-color:var(--acid)}
.pit-addrs{display:flex;flex-wrap:wrap;gap:10px;margin:16px 0 12px;padding:0;list-style:none}
.pit-addrs li{background:var(--surface);border:1px solid var(--line);border-left:3px solid var(--acid);
  border-radius:var(--r);padding:12px 16px;display:flex;flex-direction:column;gap:3px}
/* The address is what people copy, so it gets the size and the contrast. */
.pit-addrs .ip{font-family:var(--mono);font-size:1.2rem;color:var(--acid);user-select:all}
.pit-addrs .host{font-family:var(--mono);font-size:.7rem;color:var(--faint)}
.pit-pre{background:var(--bg-tint);border:1px solid var(--line);border-left:3px solid var(--acid);border-radius:var(--r);
  padding:14px 16px;overflow-x:auto;font-family:var(--mono);font-size:.8rem;line-height:1.75;color:var(--text);margin:14px 0}
.pit-steps{margin:0;padding-left:20px;line-height:1.8;max-width:66ch}
.pit-steps li{margin-bottom:10px}
.pit-steps code,.pit-copy code{font-family:var(--mono);color:var(--acid);font-size:.86em}
.pit-copy{max-width:66ch;color:var(--dim)}
.pit-land{border:1px solid var(--line-2);border-left:3px solid var(--acid);border-radius:var(--r);
  background:linear-gradient(180deg,var(--surface),var(--bg-tint));padding:20px 22px;margin:0 0 26px}
.pit-land h2{font-size:1.35rem;text-transform:none;margin:6px 0 10px}
.pit-land .pit-form,.pit-land .pit-row{margin-bottom:0}

/* ---- DNS Records ---- */
/* A zone is a table, and the reason to draw it as one is scanning: an owner
   checking a name reads down the type column, not across four labelled fields
   per row. It stays a table on a phone by scrolling in its own box rather than
   collapsing to cards -- a wrapped record is a record you cannot compare. */
.pit-zone{width:100%;border-collapse:collapse;font-family:var(--mono);font-size:.8rem;margin:8px 0 0}
.pit-zone th{text-align:left;font-size:.66rem;letter-spacing:.12em;text-transform:uppercase;
  color:var(--faint);font-weight:400;padding:0 10px 6px 0;white-space:nowrap}
.pit-zone td{padding:7px 10px 7px 0;border-top:1px solid var(--line);vertical-align:middle}
.pit-zone tr:first-child td{border-top:1px solid var(--line-2)}
.pit-zone .rtype{color:var(--acid);white-space:nowrap}
/* The value is the long one and the only one worth selecting whole. */
.pit-zone .rvalue{word-break:break-all;user-select:all;min-width:22ch}
.pit-zone .rnum{color:var(--dim);text-align:right;white-space:nowrap;font-size:.74rem}
.pit-zone .ract{text-align:right;width:1%;white-space:nowrap}
.pit-zone form{display:inline}
.pit-scroll{overflow-x:auto}
.pit-rec{border:1px solid var(--line);border-radius:var(--r);background:var(--surface);padding:14px 16px;margin-bottom:10px}
.pit-rec.empty{border-style:dashed}
.pit-rec h3{font-family:var(--mono);font-size:1rem;text-transform:none;margin:0}
.pit-rec-head{display:flex;gap:12px;align-items:baseline;justify-content:space-between;flex-wrap:wrap}
.pit-rec-add{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:12px;padding-top:10px;
  border-top:1px dashed var(--line)}
.pit-rec-add select,.pit-rec-add input{background:var(--bg-tint);border:1px solid var(--line-2);border-radius:8px;
  color:var(--text);font-family:var(--mono);font-size:.82rem;padding:8px 10px}
.pit-rec-add select:focus,.pit-rec-add input:focus{outline:none;border-color:var(--acid)}
.pit-rec-add .value{flex:1 1 22ch;min-width:16ch}
.pit-rec-add .ttl,.pit-rec-add .prio{width:9ch}
/* Priority belongs to MX alone. Hidden by script for the other three; without
   the script it stays visible and labelled, which is honest rather than broken. */
.pit-rec-add [data-prio][hidden]{display:none}
.pit-hint{font-family:var(--mono);font-size:.7rem;color:var(--faint);margin:6px 0 0;max-width:66ch}
.pit-btn-x{background:transparent;border:1px solid var(--line-2);border-radius:6px;color:var(--dim);
  font-family:var(--mono);font-size:.7rem;padding:5px 9px;cursor:pointer}
.pit-btn-x:hover{border-color:var(--danger);color:var(--danger)}
.pit-empty{font-family:var(--mono);font-size:.74rem;color:var(--faint);margin:10px 0 0}`;

/**
 * The tab strip: the endings you hold, the ones you can buy from, and how to
 * reach any of them from a machine. One strip rather than tabs inside tabs --
 * these are three views of the same namespace, and a link buried in a paragraph
 * is not how anyone finds the last one.
 *
 * `counts` is omitted on /pit/dns, which does not load the registry.
 */
const pitTabs = (active, counts = null, query = "") => {
  // Switching tabs keeps the filter: having typed `def*` once, being handed the
  // unfiltered other half is the surprising outcome, not the helpful one.
  const q = query ? `&q=${encodeURIComponent(query)}` : "";
  return `
<nav class="pit-tabs">
  <a class="pit-tab${active === "yours" ? " on" : ""}" href="/pit?tab=yours${q}">Yours${
    counts?.yours === undefined ? "" : `<span class="count">${counts.yours}</span>`}</a>
  <a class="pit-tab${active === "theirs" ? " on" : ""}" href="/pit?tab=theirs${q}">Theirs${
    counts?.theirs === undefined ? "" : `<span class="count">${counts.theirs}${counts.forSale ? ` · ${counts.forSale} for sale` : ""}</span>`}</a>
  <a class="pit-tab${active === "records" ? " on" : ""}" href="/pit/records${query ? `?q=${encodeURIComponent(query)}` : ""}">DNS Records${
    counts?.records === undefined ? "" : `<span class="count">${counts.records}</span>`}</a>
  <a class="pit-tab${active === "dns" ? " on" : ""}" href="/pit/dns">Use it (DNS)</a>
</nav>`;
};

/**
 * The filter box.
 *
 * A real GET form, so it works with the script blocked, on a browser that never
 * ran it, and in a bookmark. The script below upgrades it to filter as you
 * type; everything it does, submitting the form also does, just with a page
 * load in the middle.
 */
const filterBox = (tab, query, scope) => `
<form class="pit-filter" method="get" action="/pit" role="search" data-pit-filter data-scope="${esc(scope)}">
  <input type="hidden" name="tab" value="${esc(tab)}">
  <input name="q" value="${esc(query)}" autocomplete="off" spellcheck="false"
         placeholder="filter endings — eggs, .def*" aria-label="Filter endings"
         data-pit-filter-input>
  <button class="btn" type="submit">Filter</button>
  ${query ? `<a class="btn" href="/pit?tab=${esc(tab)}">Clear</a>` : ""}
  <span class="mono faint" style="font-size:.7rem">
    <code>eggs</code> anywhere in the name · <code>def*</code> starts with
  </span>
</form>
<div class="pit-hits" data-pit-hits hidden></div>`;

/**
 * The live half of the filter.
 *
 * Deliberately small, and the only script this page carries -- /pit locked
 * browsers up once already and it managed that with no JavaScript at all, so
 * the bar for adding some is that it makes the DOM smaller rather than larger.
 * This does: it answers "which endings match" in a dozen rows instead of a page
 * load.
 *
 * Debounced at 200ms, and the in-flight request is aborted when the next
 * keystroke lands. Without the abort a slow answer for `de` can arrive after
 * the fast one for `def*` and overwrite it, so the list flickers back to a
 * query nobody is typing any more.
 *
 * Plain ES5-ish JS with no template literals: it is embedded in a template
 * literal, and a backtick in here would end the string it lives in.
 */
const PIT_FILTER_JS = String.raw`
(function () {
  var form = document.querySelector('[data-pit-filter]');
  var input = document.querySelector('[data-pit-filter-input]');
  var out = document.querySelector('[data-pit-hits]');
  if (!form || !input || !out) return;

  var scope = form.getAttribute('data-scope') || 'all';
  var DEBOUNCE_MS = 200;
  var timer = null, inflight = null, rendered = null;

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function hide() { out.hidden = true; out.innerHTML = ''; rendered = null; }

  function row(t) {
    // Yours opens on its own; anybody else's filters Theirs down to it, which
    // is the panel that carries the buy form.
    var href = t.mine
      ? '/pit?tld=' + encodeURIComponent(t.tld)
      : '/pit?tab=theirs&q=' + encodeURIComponent(t.tld);
    var note = t.mine
      ? t.name_count + (t.name_count === 1 ? ' name' : ' names')
      : (t.price_usd === null || t.price_usd === undefined ? 'not for sale' : '$' + t.price_usd + ' a name');
    var alias = t.alias_of ? '<span class="faint"> to .' + esc(t.alias_of) + '</span>' : '';
    return '<a class="pit-hit" href="' + href + '">' +
      '<span class="mono acid">.' + esc(t.tld) + alias + '</span>' +
      '<span class="mono faint">' + esc(note) + '</span></a>';
  }

  function render(data) {
    var tlds = data.tlds || [];
    if (!tlds.length) {
      out.innerHTML = '<p class="mono faint" style="margin:0;font-size:.72rem">nothing here matches ' +
        esc(data.query) + '</p>';
      out.hidden = false;
      return;
    }
    var more = data.total > tlds.length
      ? '<p class="mono faint" style="margin:8px 0 0;font-size:.72rem">' + tlds.length + ' of ' +
        data.total + ' shown - press Enter for all of them</p>'
      : '';
    out.innerHTML = tlds.map(row).join('') + more;
    out.hidden = false;
  }

  function run() {
    var q = input.value.trim();
    if (!q) { hide(); return; }
    if (q === rendered) return;
    if (inflight) inflight.abort();
    var ctl = new AbortController();
    inflight = ctl;
    fetch('/api/moshpit/tlds?limit=12&scope=' + encodeURIComponent(scope) + '&q=' + encodeURIComponent(q),
      { signal: ctl.signal, headers: { accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (ctl.signal.aborted || !data) return;
        rendered = q;
        render(data);
      })
      .catch(function () { /* aborted, or offline: leave the last answer up */ });
  }

  function schedule() { clearTimeout(timer); timer = setTimeout(run, DEBOUNCE_MS); }

  input.addEventListener('keyup', schedule);
  input.addEventListener('input', schedule);   // paste and IME never fire keyup
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { input.value = ''; hide(); }
  });
})();
`;

const forSale = (t) => t.price_usd !== null && t.price_usd !== undefined;

/**
 * How much of the namespace one page may draw.
 *
 * /pit ships no script at all, and it still locked browsers up: the page grew
 * as endings x names-under-them, and neither end was bounded. Every name is a
 * form with a CSRF field, two inputs and two buttons, so an account holding 50
 * endings with 100 names each rendered 3 MiB of HTML and 36k elements. Nothing
 * has to be slow for that to jam -- it is the DOM, and the sticky blurred app
 * bar repainting over it on every scroll frame.
 *
 * So the page shows a window and says what it is not showing. `?tld=` opens one
 * ending in full, which is also where the "show all N" links go -- and where
 * TronBrowser's `mosh.<tld>` already pointed, on a page that until now ignored
 * the parameter and drew everything anyway.
 */
const TLDS_PER_PAGE = 20;
const NAMES_PER_TLD = 10;
const NAMES_FOCUSED = 250;

/** `?page=` as a 1-based page number; anything unreadable is page 1. */
const pageParam = (value) => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 1 ? n : 1;
};

/** Prev/next for a window into `total` rows, or nothing when it all fits. */
const pager = ({ page, total, perPage, href }) => {
  const pages = Math.max(1, Math.ceil(total / perPage));
  if (pages <= 1) return "";
  const link = (n, label) => `<a class="btn" href="${href(n)}">${label}</a>`;
  return `<nav class="pit-pager">
    ${page > 1 ? link(page - 1, "← Newer") : `<span class="btn faint" aria-disabled="true">← Newer</span>`}
    <span class="mono faint">page ${page} of ${pages} · ${total} endings</span>
    ${page < pages ? link(page + 1, "Older →") : `<span class="btn faint" aria-disabled="true">Older →</span>`}
  </nav>`;
};

/**
 * What to put in "points at", and what has to be listening at the other end.
 *
 * This sits next to the field rather than on a docs page because the field is
 * a bare text input whose one hint is a placeholder, and the thing it wants —
 * an address that a web server is already virtual-hosting the name on — is not
 * guessable from "points at…". Collapsed by default: the answer is three lines
 * once you know it, and this list is only in the way afterwards.
 */
function hostingHelp() {
  return `<details class="pit-bulk">
  <summary>how do I host a site at a name I hold?</summary>
  <ol class="pit-steps dim">
    <li><strong>Put your server's IPv6 address in "points at".</strong> Just the address —
      <code>2606:4700:4700::1111</code>. IPv4 literals are refused: an A record on a small host
      is usually leased or NATed and goes stale without telling anyone. A hostname
      (<code>box.example.com</code>) works too.</li>
    <li><strong>Turn the resolver on, on any machine that should reach the name:</strong>
      <code>sudo moshcode dns enable</code>. Moshpit endings are not in the public DNS root, so
      nothing resolves them until this is running — it answers <code>AAAA</code> for your names
      out of the registry and leaves every other lookup alone.</li>
    <li><strong>Serve the name on that address, port 80.</strong> The browser connects straight to
      your box and sends <code>Host: name.ending</code> — nothing proxies, nothing redirects, so
      your web server needs a block that answers to the name.</li>
  </ol>
  <p class="pit-copy" style="font-size:.84rem">Caddy — the <code>http://</code> is required, not a
    typo: no public CA will issue a certificate for an ending that is not in the DNS root, so
    automatic HTTPS has to stay off.</p>
  <div class="pit-pre">http://seo.rank {
    root * /var/www/seo.rank
    file_server
}</div>
  <p class="pit-copy" style="font-size:.84rem">nginx:</p>
  <div class="pit-pre">server {
    listen [::]:80;
    server_name seo.rank;
    root /var/www/seo.rank;
}</div>
  <p class="pit-copy" style="font-size:.84rem">Or skip the typing —
    <code>moshcode template install bun-caddy-sqlite</code> writes the Caddyfile, the systemd
    units and a Bun + SQLite service already wired up this way.
    <code>moshcode template list</code> shows what there is.</p>
  <p class="pit-copy" style="font-size:.84rem">Check it with <code>moshcode dns resolve seo.rank</code>,
    then <code>curl -6 http://seo.rank/</code>. A port other than 80 only works in the
    <code>/n/</code> view — DNS carries an address and has nowhere to put a port, so the browser
    goes to 80 whatever the target says.</p>
</details>`;
}

moshpitRouter.get("/pit", async (req, res) => {
  // An unknown ?tab= falls back to Yours rather than rendering an empty page.
  const tab = req.query.tab === "theirs" ? "theirs" : "yours";
  const pageNo = pageParam(req.query.page);

  // `?tld=` opens a single ending in full. Only meaningful for one you hold --
  // Theirs is one row per ending and has nothing to expand.
  const wanted = normalizeTld(req.query.tld) || null;
  const focused = tab === "yours" && req.user && wanted
    ? await getTld(wanted).then((t) => (t && t.user_id === req.user.id ? t : null))
    : null;

  // `?q=` filters the panel. The live filter is a script talking to the JSON
  // API, but the query still belongs in the URL: without it the filter would be
  // unbookmarkable, unshareable, and gone the moment the script failed to load.
  const filter = tldQuery(req.query.q);
  const offset = (pageNo - 1) * TLDS_PER_PAGE;
  const window = { limit: TLDS_PER_PAGE, offset };
  const search = (scope) => searchTlds(filter.like, { scope, userId: req.user?.id ?? null, exact: filter.exact, ...window });
  const searchTotal = (scope) => countSearchTlds(filter.like, { scope, userId: req.user?.id ?? null });

  const [theirs, theirsTotal, mine, mineTotal, bal] = await Promise.all([
    tab !== "theirs" ? []
      : filter ? search("theirs")
      : listTldsNotOwnedBy(req.user?.id ?? null, window),
    filter ? searchTotal("theirs") : countTldsNotOwnedBy(req.user?.id ?? null),
    !req.user || focused ? []
      : filter ? search("mine")
      : listTldsForUser(req.user.id, window),
    req.user ? (filter ? searchTotal("mine") : countTldsForUser(req.user.id)) : 0,
    req.user ? balance(req.user.id) : 0,
  ]);
  const shown = focused ? [focused] : mine;
  const qs = filter ? `&q=${encodeURIComponent(filter.query)}` : "";

  // `?name=mosh.whatever` — somebody typed a Moshpit name and ended up here
  // instead of at a site. Work out what they can actually do about it.
  const asked = parseMoshpitName(req.query.name);
  let landing = { kind: "none" };
  if (asked) {
    // With the price: a stranger can buy a name under an ending that is listed
    // for sale (#127), so the card has to know whether this one is.
    const owner = await getTldWithPrice(asked.tld);
    const entry = owner ? await getName(asked.tld, asked.label) : null;
    landing = landingFor(req.query.name, {
      tldOwned: Boolean(owner),
      ownedByViewer: Boolean(owner && req.user && owner.user_id === req.user.id),
      nameRegistered: Boolean(entry),
      target: entry?.target ?? null,
      priceUsd: owner?.price_usd ?? null,
    });
  }

  const forSaleCount = await countTldsNotOwnedBy(req.user?.id ?? null, { forSale: true });

  // Per-TLD detail is only needed by the endings actually on screen, and only
  // Yours has any: Theirs is one row per ending. That is the whole fix -- this
  // used to run one listNames per ending the account held, however many that
  // was, and then render every row it got back.
  const exemptions = new Map();
  const names = new Map();
  const nameTotals = new Map();
  if (tab === "yours") {
    // Exemptions are only meaningful for a TLD that points somewhere.
    await Promise.all(shown.filter((t) => t.alias_of).map(async (t) => exemptions.set(t.tld, await listExempt(t.tld))));
    await Promise.all(shown.map(async (t) => {
      names.set(t.tld, await listNames(t.tld, focused ? NAMES_FOCUSED : NAMES_PER_TLD));
      nameTotals.set(t.tld, await countNames(t.tld));
    }));
  }

  const msg = req.query.err ? `<p class="pit-msg err">${esc(req.query.err)}</p>`
    : req.query.ok ? `<p class="pit-msg ok">${esc(req.query.ok)}</p>` : "";

  const mineHtml = !req.user
    ? `<p class="dim">Sign in with your moshcode account to claim one — the same login the CLI uses.</p>
       <p><a class="btn acid" href="/">Sign in →</a></p>`
    : shown.length
      ? shown.map((t) => `
        <div class="pit-tld">
          <h3 class="acid">.${esc(t.tld)}</h3>
          <div class="mono faint" style="font-size:.72rem">
            ${t.alias_of ? `points at <span class="acid">.${esc(t.alias_of)}</span>` : "stands on its own"}
            · ${nameTotals.get(t.tld) ?? 0} name${(nameTotals.get(t.tld) ?? 0) === 1 ? "" : "s"}
          </div>
          <div class="pit-names">
            ${(names.get(t.tld) || []).length
              ? (names.get(t.tld) || []).map((n) => `
                <form method="post" action="/pit/${esc(t.tld)}/names" class="pit-row pit-name">
                  ${csrfInput(req)}
                  <input type="hidden" name="label" value="${esc(n.label)}">
                  <span class="mono acid">${esc(n.label)}.${esc(t.tld)}</span>
                  <input name="target" placeholder="points at… (IPv6 or hostname)" value="${esc(n.target || "")}" autocomplete="off">
                  <button class="btn" type="submit" name="retarget" value="1">Save</button>
                  <button class="btn" type="submit" name="release" value="1">Release</button>
                </form>`).join("")
              : `<p class="mono faint" style="font-size:.72rem;margin:6px 0">no names under .${esc(t.tld)} yet</p>`}
            ${(nameTotals.get(t.tld) ?? 0) > (names.get(t.tld) || []).length ? `
            <p class="mono faint" style="font-size:.72rem;margin:6px 0">
              ${(names.get(t.tld) || []).length} of ${nameTotals.get(t.tld)} shown${focused
                ? ` — this ending holds more than the ${NAMES_FOCUSED} a page will draw`
                : ` · <a class="acid" href="/pit?tld=${encodeURIComponent(t.tld)}">open .${esc(t.tld)} on its own →</a>`}
            </p>` : ""}
            <form method="post" action="/pit/${esc(t.tld)}/names" class="pit-row">
              ${csrfInput(req)}
              <input name="label" placeholder="new name" autocomplete="off" required>
              <span class="mono faint">.${esc(t.tld)}</span>
              <input name="target" placeholder="points at… (IPv6 or hostname, optional)" autocomplete="off">
              <button class="btn acid" type="submit">Add name</button>
            </form>
          </div>
          <form method="post" action="/pit/${esc(t.tld)}/alias" class="pit-row">
            ${csrfInput(req)}
            <input name="to" placeholder="point at .tld" value="${esc(t.alias_of || "")}" autocomplete="off">
            <button class="btn" type="submit">${t.alias_of ? "Repoint" : "Point"}</button>
            ${t.alias_of ? `<button class="btn" type="submit" name="clear" value="1">Unpoint</button>` : ""}
          </form>
          ${t.alias_of ? `
          <form method="post" action="/pit/${esc(t.tld)}/exempt" class="pit-row">
            ${csrfInput(req)}
            <input name="label" placeholder="name to hold back" autocomplete="off">
            <button class="btn" type="submit">Exempt</button>
            <span class="mono faint" style="font-size:.72rem">${
              (exemptions.get(t.tld) || []).map((l) => `${esc(l)}.${esc(t.tld)}`).join(" · ") || "none held back"
            }</span>
          </form>` : ""}
          <form method="post" action="/pit/${esc(t.tld)}/price" class="pit-row">
            ${csrfInput(req)}
            <span class="mono faint" style="font-size:.72rem">sell names for $</span>
            <input name="price_usd" inputmode="decimal" placeholder="0.00"
                   value="${t.price_usd === null || t.price_usd === undefined ? "" : esc(String(t.price_usd))}"
                   autocomplete="off" style="min-width:90px">
            <button class="btn" type="submit">${forSale(t) ? "Update price" : "List for sale"}</button>
            ${forSale(t) ? `<button class="btn" type="submit" name="unlist" value="1">Unlist</button>` : ""}
            <span class="mono ${forSale(t) ? "acid" : "faint"}" style="font-size:.72rem">${
              forSale(t) ? `anyone can buy a name under .${esc(t.tld)}` : "closed — only you can mint here"
            }</span>
          </form>
        </div>`).join("")
      : `<p class="dim">You don't hold a TLD yet. Claim one above.</p>`;

  // Sorted so the ones you can actually act on come first.
  const theirsHtml = theirs.length
    ? theirs.map((t) => `
      <div class="pit-tld${forSale(t) ? " pit-forsale" : ""}">
        <div class="pit-row" style="margin:0;justify-content:space-between">
          <h3 class="${forSale(t) ? "acid" : "dim"}" style="font-family:var(--mono);font-size:1.05rem;text-transform:none">
            .${esc(t.tld)}${t.alias_of ? `<span class="faint"> → .${esc(t.alias_of)}</span>` : ""}
          </h3>
          <span class="pill${forSale(t) ? " on" : ""}">${forSale(t) ? `$${esc(String(t.price_usd))} a name` : "not for sale"}</span>
        </div>
        ${forSale(t) ? (req.user ? `
        <form method="post" action="/pit/${esc(t.tld)}/buy" class="pit-row">
          ${csrfInput(req)}
          <input name="label" placeholder="the name you want" autocomplete="off" spellcheck="false" required>
          <span class="mono faint">.${esc(t.tld)}</span>
          <button class="btn acid" type="submit">Buy for $${esc(String(t.price_usd))}</button>
        </form>`
        : `<p class="mono faint" style="font-size:.72rem;margin:8px 0 0"><a class="acid" href="/">Sign in</a> to buy a name here.</p>`)
        : ""}
      </div>`).join("")
    : `<p class="dim">Nobody else holds a TLD yet.</p>`;

  res.type("html").send(page({
    title: "moshcode ▸ the pit",
    head: `<style>${PIT_CSS}</style>`,
    body: `${appBar(req.user, bal, req.csrfToken)}
<main class="wrap" style="padding:38px 24px 64px">
  <p class="label">the moshpit namespace</p>
  <h1 style="font-size:clamp(2rem,6vw,3.4rem)">Claim <span class="acid">.anything</span></h1>
  <p class="dim" style="max-width:62ch">
    One level deep, first come first served. Hold <span class="mono acid">.eggs</span> and every
    <span class="mono">name.eggs</span> under it is yours. Point a TLD at another one you own and the
    whole namespace follows — <span class="mono">.agentic → .agent</span> makes
    <span class="mono">foo.agentic</span> resolve to <span class="mono">foo.agent</span> — while any name
    you exempt stays exactly where it is.
  </p>
  ${landingCard(req, landing)}
  ${msg}
  ${req.user ? claimForm(req) + bulkClaimForm(req) : ""}
  ${pitTabs(tab, { yours: mineTotal, theirs: theirsTotal, forSale: filter ? 0 : forSaleCount }, filter?.query ?? "")}
  ${filterBox(tab, filter?.query ?? "", req.user ? (tab === "theirs" ? "theirs" : "mine") : "all")}

  <section class="pit-panel">
  ${tab === "yours" ? `
    ${focused ? `
    <p class="dim" style="max-width:62ch;margin:0 0 14px">
      <a class="acid" href="/pit">← all ${mineTotal} of your endings</a> · showing
      <span class="mono acid">.${esc(focused.tld)}</span> on its own.
    </p>` : `
    <p class="dim" style="max-width:62ch;margin:0 0 14px">
      Endings you hold. Names under them are yours to mint for nothing — or put a price on the
      ending and let anyone buy one.
    </p>`}
    ${hostingHelp()}
    ${mineHtml}
    ${focused ? "" : pager({
      page: pageNo, total: mineTotal, perPage: TLDS_PER_PAGE,
      href: (n) => `/pit?tab=yours&page=${n}${qs}`,
    })}
  ` : `
    <p class="dim" style="max-width:62ch;margin:0 0 14px">
      Endings somebody else holds. Where the operator has set a price you can buy a name under it —
      <span class="mono">foo.whatever</span> without owning <span class="mono">.whatever</span>. Paid in crypto
      through CoinPay; the name lands the moment the payment confirms.
    </p>
    ${theirsHtml}
    ${pager({
      page: pageNo, total: theirsTotal, perPage: TLDS_PER_PAGE,
      href: (n) => `/pit?tab=theirs&page=${n}${qs}`,
    })}
  `}
  </section>
</main>${footer}
<script>${PIT_FILTER_JS}</script>`,
  }));
});

/* ---------- the DNS Records tab ---------- */

/**
 * How many names one page of records may draw.
 *
 * Smaller than TLDS_PER_PAGE because each row here is a table of records plus a
 * form, not a line — and /pit already learned once what an unbounded list of
 * forms does to a browser.
 */
const NAMES_PER_RECORDS_PAGE = 25;

/**
 * The filter and page carried through a form post.
 *
 * Without them, publishing a record from a filtered page nine drops you back on
 * an unfiltered page one, hunting for the name you were just looking at. The
 * redirect can only put you back where you were if the form says where that
 * was.
 */
const whereYouWere = ({ q = "", page = 1 } = {}) =>
  `${q ? `<input type="hidden" name="q" value="${esc(q)}">` : ""}${
    page > 1 ? `<input type="hidden" name="page" value="${esc(String(page))}">` : ""}`;

/** The type picker, with the current choice kept across a failed submit. */
const typeSelect = (selected = "AAAA", attrs = "") => `
<select name="type" aria-label="Record type" ${attrs}>
  ${RECORD_TYPES.map((t) => `<option value="${t}"${t === selected ? " selected" : ""}>${t}</option>`).join("")}
</select>`;

/**
 * The row that publishes a record, drawn under every name.
 *
 * Per name rather than one form at the top with a name picker: the question
 * "which name is this record for" is already answered by where the form is, and
 * a picker is one more thing to get wrong on a page whose whole job is getting
 * four fields right.
 */
const addRecordRow = (req, name, ctx, { type = "AAAA", value = "", ttl = "", priority = "" } = {}) => `
<form method="post" action="/pit/records" class="pit-rec-add" data-rec-add>
  ${csrfInput(req)}
  ${whereYouWere(ctx)}
  <input type="hidden" name="name" value="${esc(name)}">
  ${typeSelect(type, "data-rec-type")}
  <input class="value" name="value" value="${esc(value)}" autocomplete="off" spellcheck="false"
         placeholder="${esc(RECORD_HELP[type].hint)}" aria-label="Record value" data-rec-value required>
  <input class="ttl" name="ttl" value="${esc(String(ttl))}" inputmode="numeric" autocomplete="off"
         placeholder="ttl" aria-label="TTL in seconds" title="Seconds. ${MIN_TTL}–${MAX_TTL}, default 300.">
  <span data-prio${type === "MX" ? "" : " hidden"}>
    <input class="prio" name="priority" value="${esc(String(priority))}" inputmode="numeric" autocomplete="off"
           placeholder="prio" aria-label="MX priority" title="Lowest priority wins. 10 if left blank.">
  </span>
  <button class="btn acid" type="submit">Publish</button>
</form>`;

/**
 * One name and everything it publishes.
 *
 * A name with no records still gets its box and its form. The empty state is
 * the one this tab exists for — an owner arrives here precisely because there
 * is nothing published yet — so hiding it behind "names with records" would
 * leave the page blank for exactly the person who came to fill it.
 */
const recordCard = (req, name, records, target, ctx) => {
  const label = `${name.label}.${name.tld}`;
  const rows = records.map((r) => `
    <tr>
      <td class="rtype">${r.type}</td>
      <td class="rvalue">${esc(r.value)}</td>
      <td class="rnum">${r.priority === null ? "—" : r.priority}</td>
      <td class="rnum">${r.ttl}s</td>
      <td class="ract">
        <form method="post" action="/pit/records/delete">
          ${csrfInput(req)}
          ${whereYouWere(ctx)}
          <input type="hidden" name="name" value="${esc(label)}">
          <input type="hidden" name="type" value="${esc(r.type)}">
          <input type="hidden" name="value" value="${esc(r.value)}">
          <button class="pit-btn-x" type="submit" aria-label="Remove this ${r.type} record">Remove</button>
        </form>
      </td>
    </tr>`).join("");

  return `
<div class="pit-rec${records.length ? "" : " empty"}">
  <div class="pit-rec-head">
    <h3 class="acid">${esc(label)}</h3>
    <span class="mono faint" style="font-size:.7rem">${
      records.length ? `${records.length} record${records.length === 1 ? "" : "s"}` : "nothing published"
    }${target ? ` · resolves to <span class="acid">${esc(target)}</span>` : " · parked"}</span>
  </div>
  ${records.length ? `
  <div class="pit-scroll">
    <table class="pit-zone">
      <thead><tr><th>type</th><th>value</th><th>prio</th><th>ttl</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
  <details class="pit-bulk" style="margin:10px 0 0">
    <summary>as a zone file</summary>
    <div class="pit-pre">${esc(records.map((r) => zoneLine(label, r)).join("\n"))}</div>
  </details>` : `
  <p class="pit-empty">No records yet — an AAAA pointing at the box that serves it is the usual first one.</p>`}
  ${addRecordRow(req, label, ctx)}
</div>`;
};

/**
 * Swap the placeholder to match the chosen type, and hide the priority box for
 * the three types that have no priority.
 *
 * Progressive enhancement, and small enough to stay inline: every field it
 * touches works without it, so a browser that never runs this gets a form with
 * a generic placeholder and one field it should leave alone — not a broken page.
 *
 * Plain ES5-ish, no template literals: it lives inside one.
 */
const RECORDS_JS = String.raw`
(function () {
  var HINTS = __HINTS__;
  var forms = document.querySelectorAll('[data-rec-add]');
  for (var i = 0; i < forms.length; i++) (function (form) {
    var select = form.querySelector('[data-rec-type]');
    var value = form.querySelector('[data-rec-value]');
    var prio = form.querySelector('[data-prio]');
    if (!select || !value) return;
    function sync() {
      var hint = HINTS[select.value];
      if (hint) value.setAttribute('placeholder', hint);
      if (prio) prio.hidden = select.value !== 'MX';
    }
    select.addEventListener('change', sync);
    sync();
  })(forms[i]);
})();
`;

/**
 * GET /pit/records — the records on every name you hold.
 *
 * The tab exists because "points at" was the only thing a name could say, and
 * one address is not a zone: a name that cannot publish a second address, a
 * mail exchanger or a proof-of-ownership string is a name you cannot actually
 * run anything on.
 *
 * Filtered over whole names rather than endings, because the thing an owner is
 * looking for here is a domain — `blue.eggs`, not `.eggs`. Paged for the reason
 * /pit is paged: this draws a table and a form per name.
 */
moshpitRouter.get("/pit/records", async (req, res) => {
  const bal = req.user ? await balance(req.user.id) : 0;
  const filter = nameQuery(req.query.q);
  const pageNo = pageParam(req.query.page);
  const offset = (pageNo - 1) * NAMES_PER_RECORDS_PAGE;

  const [names, total] = req.user
    ? await Promise.all([
      listRecordNames(req.user.id, {
        like: filter?.like ?? null, exact: filter?.exact ?? "",
        limit: NAMES_PER_RECORDS_PAGE, offset,
      }),
      countRecordNames(req.user.id, { like: filter?.like ?? null }),
    ])
    : [[], 0];

  const records = await listRecordsForNames(names);
  const published = names.reduce((n, name) => n + (name.record_count || 0), 0);
  const ctx = { q: filter?.query ?? "", page: pageNo };

  const msg = req.query.err ? `<p class="pit-msg err">${esc(req.query.err)}</p>`
    : req.query.ok ? `<p class="pit-msg ok">${esc(req.query.ok)}</p>` : "";

  const qs = filter ? `&q=${encodeURIComponent(filter.query)}` : "";

  const body = !req.user
    ? `<p class="dim">Sign in to publish records on the names you hold — the same login the CLI uses.</p>
       <p><a class="btn acid" href="/">Sign in →</a></p>`
    : names.length
      ? names.map((n) => recordCard(req, n, records.get(`${n.label}.${n.tld}`) || [], n.target, ctx)).join("")
      : filter
        ? `<p class="dim">No name of yours matches <span class="mono acid">${esc(filter.query)}</span>.
           <a class="acid" href="/pit/records">Show all of them →</a></p>`
        : `<p class="dim">You don't hold a name yet. Names live under an ending —
           <a class="acid" href="/pit">claim one in the pit</a>, then mint a name under it and it appears here.</p>`;

  res.type("html").send(page({
    title: "moshcode ▸ the pit ▸ dns records",
    head: `<style>${PIT_CSS}</style>`,
    body: `${appBar(req.user, bal, req.csrfToken)}
<main class="wrap" style="padding:38px 24px 64px">
  <p class="label">the moshpit namespace</p>
  <h1 style="font-size:clamp(2rem,6vw,3.4rem)">DNS <span class="acid">records</span></h1>
  <p class="dim" style="max-width:66ch">
    Real records on the names you hold: <span class="mono acid">AAAA</span> for the box that serves it,
    <span class="mono acid">CNAME</span> to send it somewhere else, <span class="mono acid">MX</span> for
    mail, <span class="mono acid">TXT</span> for everything that has to be proved. Published the moment
    you hit the button — no zone transfer, no propagation wait.
  </p>
  <p class="dim" style="max-width:66ch;font-size:.9rem">
    ${/* Which resolver answers what, said here rather than discovered from a dig
         that comes back empty. All four types are served now; the caveat that is
         left is a machine still running an older bridge, which answers addresses
         and NODATA for the rest. */""}
    <span class="acid mono">All four resolve.</span> <span class="mono">dig MX blue.eggs</span> through
    a Moshpit resolver answers from what you publish here, as do
    <span class="mono">TXT</span>, <span class="mono">CNAME</span> and <span class="mono">AAAA</span>.
    A machine running a bridge from before records existed answers addresses and nothing else —
    <span class="mono">moshcode update</span> is the fix, and
    <span class="mono">moshcode dns resolve blue.eggs</span> says which one you are talking to.
  </p>
  ${/* Only the count this page actually knows. Yours and Theirs would each cost
       a query to state truthfully, and a confident `0` next to an account
       holding forty endings is worse than no number at all. */""}
  ${pitTabs("records", { records: published }, filter?.query ?? "")}
  ${msg}

  <form class="pit-filter" method="get" action="/pit/records" role="search">
    <input name="q" value="${esc(filter?.query ?? "")}" autocomplete="off" spellcheck="false"
           placeholder="filter domains — blue.eggs, eggs, blue.*" aria-label="Filter your names">
    <button class="btn" type="submit">Filter</button>
    ${filter ? `<a class="btn" href="/pit/records">Clear</a>` : ""}
    <span class="mono faint" style="font-size:.7rem">
      <code>eggs</code> anywhere in the name · <code>blue.*</code> starts with
    </span>
  </form>

  <section class="pit-panel">
    ${req.user ? `
    <p class="dim" style="max-width:66ch;margin:0 0 14px">
      ${total} name${total === 1 ? "" : "s"}${filter ? " matching" : ""} · ${published} record${published === 1 ? "" : "s"}
      on this page. Records attach to the name itself: the namespace is one level deep, so there is no
      <span class="mono">www.</span> to put in front of one.
    </p>` : ""}
    ${body}
    ${pager({
      page: pageNo, total, perPage: NAMES_PER_RECORDS_PAGE,
      href: (n) => `/pit/records?page=${n}${qs}`,
    })}
  </section>

  ${recordsApiHelp()}
</main>${footer}
<script>${RECORDS_JS.replace("__HINTS__", JSON.stringify(Object.fromEntries(RECORD_TYPES.map((t) => [t, RECORD_HELP[t].hint]))))}</script>`,
  }));
});

/**
 * The same thing from a script.
 *
 * On the page rather than in a docs file because the person who wants it is the
 * person who just added the fourth record by hand and is wondering whether they
 * have to do the next forty the same way. `moshcode` already holds an API key
 * that this router accepts, so this is a real cut-and-paste, not an outline.
 */
function recordsApiHelp() {
  return `<details class="pit-bulk" style="margin-top:28px">
  <summary>publish records from a script</summary>
  <p class="pit-copy" style="font-size:.84rem">Every button on this page is an API call. The key is the one
    in <a class="acid" href="/settings">settings</a> — the same one <code>moshcode</code> uses.</p>
  <div class="pit-pre">export MOSH_KEY=mk_...

# publish an address
curl -X POST ${esc(config.pitOrigin)}/api/moshpit/tlds/eggs/records \\
  -H "authorization: Bearer $MOSH_KEY" -H 'content-type: application/json' \\
  -d '{"label":"blue","type":"AAAA","value":"2606:4700:4700::1111","ttl":300}'

# mail
curl -X POST ${esc(config.pitOrigin)}/api/moshpit/tlds/eggs/records \\
  -H "authorization: Bearer $MOSH_KEY" -H 'content-type: application/json' \\
  -d '{"label":"blue","type":"MX","value":"mx.example.com","priority":10}'

# read them back — no key needed, DNS is public
curl ${esc(config.pitOrigin)}/api/moshpit/records?name=blue.eggs

# withdraw one
curl -X DELETE ${esc(config.pitOrigin)}/api/moshpit/tlds/eggs/records \\
  -H "authorization: Bearer $MOSH_KEY" -H 'content-type: application/json' \\
  -d '{"label":"blue","type":"MX","value":"mx.example.com"}'</div>
  <p class="pit-copy" style="font-size:.84rem"><code>/api/moshpit/records</code> is what a resolver
    reads, and <code>/api/moshpit/resolve?name=…&amp;records=1</code> returns the address and the record
    set in one call — which is the one the bridge and the DoH server use when the question is a
    <code>CNAME</code>, <code>MX</code> or <code>TXT</code>. <code>moshcode dns resolve blue.eggs</code>
    shows what a machine actually gets.</p>
</details>`;
}

/** Back to the records tab, keeping the filter and the page you were on. */
const backToRecords = (req, res, params) =>
  res.redirect(`/pit/records?${new URLSearchParams({
    ...params,
    ...(req.body?.q ? { q: req.body.q } : {}),
    ...(req.body?.page && req.body.page !== "1" ? { page: req.body.page } : {}),
  })}`);

moshpitRouter.post("/pit/records", requireAuth, async (req, res) => {
  const parsed = parseMoshpitName(req.body?.name);
  if (!parsed) return backToRecords(req, res, { err: "which name? that is not one." });

  const result = await addRecord({
    tld: parsed.tld, label: parsed.label, userId: req.user.id,
    type: req.body?.type, value: req.body?.value, ttl: req.body?.ttl, priority: req.body?.priority,
  });
  if (!result.ok) return backToRecords(req, res, { err: result.error || "could not publish that record" });

  const record = result.record;
  backToRecords(req, res, {
    ok: `${parsed.label}.${parsed.tld} now publishes ${record.type} ${record.value}${
      record.priority === null || record.priority === undefined ? "" : ` (priority ${record.priority})`}.`,
  });
});

moshpitRouter.post("/pit/records/delete", requireAuth, async (req, res) => {
  const parsed = parseMoshpitName(req.body?.name);
  if (!parsed) return backToRecords(req, res, { err: "which name? that is not one." });

  const result = await removeRecord({
    tld: parsed.tld, label: parsed.label, userId: req.user.id,
    type: req.body?.type, value: req.body?.value,
  });
  if (!result.ok) return backToRecords(req, res, { err: result.error || "could not withdraw that record" });
  backToRecords(req, res, { ok: `${parsed.label}.${parsed.tld} no longer publishes that ${String(req.body?.type ?? "").toUpperCase()} record.` });
});

/**
 * GET /pit/dns — how to actually reach these names from a machine.
 *
 * A namespace nobody can resolve is a list of words. The resolvers answer
 * Moshpit names from this registry and forward everything else to the ordinary
 * internet, so the instruction is "change one setting", not "install a
 * browser".
 *
 * There is a second route, and leaving it off this page was a hole: TronBrowser
 * asks this registry over ordinary HTTPS before every navigation, so it needs no
 * network settings at all. It is listed after the resolvers because it only
 * fixes the browser -- curl, git and everything else on the machine still
 * resolve through DNS -- but it is the only route that works where DNS is
 * somebody else's to configure, and the only one that does not warn on https://.
 *
 * The addresses come from the environment (lib/moshpit-resolvers.mjs). When
 * none are configured this page says so and explains how to run one, rather
 * than inventing an address for a stranger to paste into their network
 * settings.
 */
moshpitRouter.get("/pit/dns", async (req, res) => {
  const bal = req.user ? await balance(req.user.id) : 0;
  const { resolvers, doh, published } = resolverConfig();
  const first = resolvers[0]?.address ?? "<resolver address>";

  const addresses = published
    ? `<ul class="pit-addrs">${resolvers.map((r) => `
        <li><span class="ip">${esc(r.address)}</span>${r.name ? `<span class="host">${esc(r.name)}</span>` : ""}</li>`).join("")}
       </ul>
       <p class="pit-copy">
         Use both, in that order — the second exists so the first can be rebooted without the
         namespace going with it. You type the <em>addresses</em>: a resolver's own name cannot be
         looked up until you already have a working resolver.
       </p>`
    : `<p class="pit-copy">
         <span class="acid mono">Not published yet.</span> The resolver is built and tested, but no
         public instance is announced here — and this page will not invent an address for you to
         paste into your network settings. Run your own below; it serves every name in the
         namespace, not just yours.
       </p>`;

  res.type("html").send(page({
    title: "moshcode ▸ the pit ▸ dns",
    head: `<style>${PIT_CSS}</style>`,
    body: `${appBar(req.user, bal, req.csrfToken)}
<main class="wrap" style="padding:38px 24px 64px">
  <p class="label">the moshpit namespace</p>
  <h1 style="font-size:clamp(2rem,6vw,3.4rem)">One setting. <span class="acid">.anything</span> resolves.</h1>
  <p class="dim" style="max-width:66ch">
    These names live outside the traditional DNS root, so a normal browser has nowhere to look them
    up. These resolvers know where. Point a laptop, a phone or a whole router at one and
    <span class="mono acid">.eggs</span>, <span class="mono acid">.moshpit</span>,
    <span class="mono acid">.yeah</span> resolve like any other name — while
    <span class="mono">.com</span>, <span class="mono">.org</span> and the rest of the internet keep
    working exactly as before, forwarded on to 8.8.8.8 and 1.1.1.1.
    If the DNS settings on the machine are not yours to change,
    <a class="acid" href="#tron">TronBrowser</a> resolves the same namespace without touching them.
  </p>
  ${pitTabs("dns")}

  <h2 style="font-size:1.2rem">The addresses</h2>
  ${addresses}

  <h2 style="margin-top:34px;font-size:1.2rem">Set it</h2>
  <ol class="pit-steps dim">
    <li><b class="acid">macOS</b> — System Settings → Network → your connection → Details → DNS, add it
      with <code>+</code>, drag it to the top, Save. Or:
      <code>networksetup -setdnsservers Wi-Fi ${esc(first)}</code></li>
    <li><b class="acid">Windows</b> — Settings → Network &amp; Internet → your adapter → DNS server
      assignment → Edit → Manual, IPv4 on, preferred server.</li>
    <li><b class="acid">Linux</b> — <code>resolvectl dns &lt;interface&gt; ${esc(first)}</code>, or a
      <code>nameserver</code> line in <code>/etc/resolv.conf</code>.</li>
    <li><b class="acid">Router</b> — hand it out over DHCP and every device on the network gets the
      namespace. This is the setup it is really for.</li>
    <li><b class="acid">A locked-down machine</b> where DNS is not yours to change — use DNS over HTTPS
      in the browser. Firefox: Privacy &amp; Security → DNS over HTTPS → custom provider. Chrome:
      Security → Use secure DNS → custom.
      ${doh ? `The endpoint is <code>${esc(doh)}</code>.` : "An endpoint appears here once a resolver is up."}
      Or run <a class="acid" href="#tron">TronBrowser</a>, which changes no network settings at all.</li>
  </ol>

  <h2 id="tron" style="margin-top:34px;font-size:1.2rem">Or change nothing: <span class="acid">TronBrowser</span></h2>
  <p class="pit-copy">
    <a class="acid" href="https://tronbrowser.dev" target="_blank" rel="noopener noreferrer">TronBrowser</a>
    resolves these names itself. Before every navigation it asks this registry, over ordinary HTTPS, who
    holds the name you typed. Nothing in your network settings changes, nothing needs admin rights, and
    it works on a machine where DNS is somebody else's to configure.
  </p>
  <pre class="pit-pre"><code>curl -fsSL https://tronbrowser.dev/install.sh | sh   <span class="faint"># macOS, Linux — Windows: the releases page</span>
tron http://scrambled.eggs                          <span class="faint"># or type it in the address bar</span></code></pre>
  <ol class="pit-steps dim">
    <li><b class="acid">Nothing to configure for a new ending.</b> <span class="mono">.eggs</span>,
      <span class="mono">.moshpit</span>, <span class="mono">.yeah</span> resolve out of the box — the
      legacy root has never heard of them, so there is nothing to conflict with.</li>
    <li><b class="acid">Contested names are a setting.</b> Settings → Name resolution → <em>When a name
      exists in both</em>. <b>Clearnet wins</b> is the default and never redirects a domain that already
      works; <b>Moshpit wins</b> lets a registered name override the clearnet one. It is the same
      decision the resolvers make with <code>MOSHPIT_RESOLVE_MODE</code>, taken per browser instead of
      per network.</li>
    <li><b class="acid">Claim from the address bar.</b> <code>mosh.eggs</code> opens the Pit for
      <span class="mono acid">.eggs</span>. <code>mosh.</code><em>anything</em> is reserved, so nobody
      can register that label and impersonate the page you register on.</li>
    <li><b class="acid">Your own pit</b> — Settings → Name resolution → Registry (advanced). Point it at
      the registry you run and it is looked up exactly like this one.</li>
    <li><b class="acid">Needs 3.8.8 or newer.</b> Older builds sent a claimed-but-unpointed name to a URL
      that has never existed, so parking 404'd. <code>tron upgrade</code> — and a stale address left in
      settings by one of those builds is discarded on the way, rather than outliving the fix.</li>
  </ol>
  <p class="pit-copy" style="font-size:.9rem">
    It fixes the browser, not the machine: <code>curl</code>, <code>git</code> and everything else still
    go through DNS. On a machine you control, run both.
  </p>

  <h2 style="margin-top:34px;font-size:1.2rem">Check it worked</h2>
  <pre class="pit-pre"><code>dig +short anything.moshpit     <span class="faint"># an address, not an error</span>
dig +short example.com          <span class="faint"># the ordinary internet, still fine</span>
nslookup anything.moshpit       <span class="faint"># the Windows spelling</span></code></pre>
  <p class="pit-copy" style="font-size:.9rem">
    A <code>TXT</code> lookup on any Moshpit name reports which registry and gateway answered — the
    fastest way to tell a resolver problem from a site problem.
  </p>
  <p class="pit-copy" style="font-size:.9rem">
    On the browser route there is nothing to <code>dig</code>: resolution never touches DNS. Open
    <code>mosh.eggs</code> — if the Pit loads, the browser is talking to this registry.
  </p>

  <h2 style="margin-top:34px;font-size:1.2rem">What still breaks</h2>
  <p class="pit-copy">
    <code>https://</code> on a Moshpit name will warn <em>on the resolver route</em>. No public
    certificate authority will issue for <span class="mono">scrambled.eggs</span>, because none of them
    recognise a namespace that does not descend from the ICANN root. Plain <code>http://</code> works,
    and so does this site. A certificate authority you opt into is the real answer, and it is not built
    yet.
  </p>
  <p class="pit-copy" style="font-size:.9rem">
    TronBrowser sidesteps it rather than solving it: it rewrites the navigation to this registry's own
    <code>https://</code> host, so the certificate is one the browser already trusts. The address bar
    shows where it landed, not what you typed — an honest trade, and the reason the two routes are
    documented separately.
  </p>
  <p class="pit-copy" style="font-size:.9rem">
    Clearnet lookups are forwarded to Google and Cloudflare, which is what a forwarder does. Run your
    own and point it wherever you like if that trade is wrong for you.
  </p>

  <h2 style="margin-top:34px;font-size:1.2rem">Run your own</h2>
  <p class="pit-copy">
    No dependencies, no database, reads this registry over ordinary HTTPS. Nothing about it privileges
    ours — a private pit points at a different registry, a household one runs on whatever is already
    on the shelf.
  </p>
  <pre class="pit-pre"><code>git clone https://github.com/moshcoder/moshcoding
cd moshcoding &amp;&amp; bun run dns    <span class="faint"># port 5354, no privileges needed</span>

dig @127.0.0.1 -p 5354 +short anything.moshpit</code></pre>
  <p class="pit-copy" style="font-size:.9rem">
    Setup, deployment and the operating notes:
    <a class="acid" href="https://github.com/moshcoder/moshcoding/blob/master/docs/moshpit-dns.md"
       target="_blank" rel="noopener noreferrer">docs/moshpit-dns.md</a>.
    Claim a name first over on <a class="acid" href="/pit">the namespace tab</a>.
  </p>
</main>${footer}`,
  }));
});

/* ---------- form posts (browser, CSRF-guarded) ---------- */

// Every form post lands back on /pit, so it has to say which tab it came from
// -- otherwise buying a name in Theirs bounces you to Yours to read the result.
const back = (res, params, tab = "yours") =>
  res.redirect(`/pit?${new URLSearchParams({ ...params, tab })}`);

/**
 * Claim a pasted list.
 *
 * Reported as `ok` when anything landed at all, even alongside collisions —
 * a list where 38 of 40 were claimed succeeded, and colouring it as an error
 * because two were taken would misread the normal case as a failure.
 *
 * A name counts as landing. Pasting `blue.eggs` under an ending you already
 * hold claims no ending at all, and judging that paste by the ending count
 * alone would flash red over a registration that worked.
 */
moshpitRouter.post("/pit/claim-bulk", requireAuth, async (req, res) => {
  const result = await registerTlds({
    input: req.body?.tlds, userId: req.user.id, ownerEmail: req.user.email ?? null,
    priceUsd: req.body?.price_usd, aliasOf: req.body?.alias_of,
  });
  // The flash rides back in the query string, so it has to stay short enough
  // to survive a URL.
  const summary = summarizeBulkClaim(result).slice(0, 500);
  const landed = result.claimed.length || result.names.length;
  return back(res, landed ? { ok: summary } : { err: summary });
});

/**
 * `scrambled.eggs` typed into the claim box, rather than the bare `eggs` it
 * was built for.
 *
 * Someone who wants a name should not have to know that holding it is two
 * steps — claim the ending, then mint the name under it. Do both, in that
 * order, and report the name they actually asked for.
 *
 * Someone else's ending is the one case this cannot finish: minting under it
 * is not ours to do, and whether it is for sale, taken, or simply unlisted is
 * a question `landingFor` already answers. Hand them that card instead of
 * inventing a second, thinner version of it here.
 */
async function claimFullName(req, res, { label, tld }) {
  const owner = await getTld(tld);
  if (owner && owner.user_id !== req.user.id) {
    return res.redirect(`/pit?${new URLSearchParams({ name: `${label}.${tld}` })}`);
  }

  if (!owner) {
    const claim = await registerTlds({
      input: tld, userId: req.user.id, ownerEmail: req.user.email ?? null,
      priceUsd: req.body?.price_usd, aliasOf: req.body?.alias_of,
    });
    // Lost the ending to a race, or it was reserved/malformed — either way the
    // name underneath it cannot follow.
    if (!claim.claimed.length) return back(res, { err: summarizeBulkClaim(claim).slice(0, 500) });
  }

  const minted = await registerName({ tld, label, userId: req.user.id, target: null });
  if (!minted.ok) return back(res, { err: minted.error || "could not register that name" });
  back(res, { ok: `${label}.${tld} is yours.` });
}

moshpitRouter.post("/pit/claim", requireAuth, async (req, res) => {
  // A whole name reaches registerTlds() as a dotted token it can only reject,
  // so it forks off before the list path rather than failing as a bad ending.
  const asked = parseMoshpitName(req.body?.tld);
  if (asked) return claimFullName(req, res, asked);

  // One ending goes through the same path as a list of one, so the settings
  // behave identically either way rather than being a bulk-only feature.
  const result = await registerTlds({
    input: req.body?.tld, userId: req.user.id, ownerEmail: req.user.email ?? null,
    priceUsd: req.body?.price_usd, aliasOf: req.body?.alias_of,
  });
  if (!result.claimed.length && !result.names.length) {
    return back(res, { err: summarizeBulkClaim(result).slice(0, 500) });
  }
  back(res, { ok: summarizeBulkClaim(result).slice(0, 500) });
});

moshpitRouter.post("/pit/:tld/alias", requireAuth, async (req, res) => {
  const result = req.body?.clear
    ? await clearAlias(req.params.tld, req.user.id)
    : await setAlias({ from: req.params.tld, to: req.body?.to, userId: req.user.id });
  if (!result.ok) return back(res, { err: result.error || "could not update that alias" });
  back(res, { ok: req.body?.clear ? `.${req.params.tld} stands on its own again.` : `.${req.params.tld} now points at .${normalizeTld(req.body?.to)}.` });
});

// One endpoint for add / retarget / release: all three are the same row, and a
// single form per name keeps the buttons next to the value they act on.
moshpitRouter.post("/pit/:tld/names", requireAuth, async (req, res) => {
  const tld = req.params.tld;
  const label = req.body?.label;
  const args = { tld, label, userId: req.user.id };

  let result, done;
  if (req.body?.release) {
    result = await releaseName(args);
    done = `${normalizeLabel(label)}.${normalizeTld(tld)} released.`;
  } else if (req.body?.retarget) {
    result = await setNameTarget({ ...args, target: req.body?.target });
    done = `${normalizeLabel(label)}.${normalizeTld(tld)} updated.`;
  } else {
    result = await registerName({ ...args, target: req.body?.target });
    done = `${normalizeLabel(label)}.${normalizeTld(tld)} is yours.`;
  }

  if (!result.ok) return back(res, { err: result.error || "could not update that name" });
  back(res, { ok: done });
});

moshpitRouter.post("/pit/:tld/price", requireAuth, async (req, res) => {
  const result = await setTldPrice({
    tld: req.params.tld, userId: req.user.id,
    priceUsd: req.body?.unlist ? null : req.body?.price_usd,
  });
  if (!result.ok) return back(res, { err: result.error || "could not set that price" });
  back(res, {
    ok: result.priceUsd === null
      ? `.${result.tld} is no longer for sale.`
      : `.${result.tld} names now cost $${result.priceUsd}.`,
  });
});

moshpitRouter.post("/pit/:tld/buy", requireAuth, (req, res) => startCheckout(req, res, { json: false }));

moshpitRouter.post("/pit/:tld/exempt", requireAuth, async (req, res) => {
  const result = await setExempt({ tld: req.params.tld, label: req.body?.label, userId: req.user.id });
  if (!result.ok) return back(res, { err: result.error || "could not exempt that name" });
  back(res, { ok: `${normalizeLabel(req.body?.label)}.${req.params.tld} stays put.` });
});
