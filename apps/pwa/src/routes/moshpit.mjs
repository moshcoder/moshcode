// The Moshpit namespace: claim `.<whatever>`, alias it, exempt names from the
// alias, and resolve.
//
//   GET    /api/moshpit/tlds                  the public registry (`?mine=1` for yours)
//   POST   /api/moshpit/tlds                  claim `.<whatever>`
//   GET    /api/moshpit/tlds/:tld             availability lookup, no auth
//   PUT    /api/moshpit/tlds/:tld/alias       point .tld at another TLD you own
//   DELETE /api/moshpit/tlds/:tld/alias       stop pointing it anywhere
//   GET    /api/moshpit/tlds/:tld/exempt      names held back from the alias
//   POST   /api/moshpit/tlds/:tld/exempt      hold one back
//   DELETE /api/moshpit/tlds/:tld/exempt      let it follow the alias again
//   GET    /api/moshpit/resolve?name=&mode=   resolve + precedence for a client resolver
//   GET    /pit                               the human page
//   GET    /pit/dns                           how to reach these names from a machine
import { Router } from "express";
import { page, footer, appBar, esc } from "../lib/html.mjs";
import { requireAuth, csrfInput } from "../lib/session.mjs";
import { balance } from "../lib/credits.mjs";
import { resolverConfig } from "../lib/moshpit-resolvers.mjs";
import { landingFor } from "../lib/moshpit-landing.mjs";
import {
  addPin,
  clearAlias,
  clearExempt,
  getName,
  getTld,
  getTldWithPrice,
  listExempt,
  listNames,
  listPins,
  listTlds,
  listTldsForUser,
  listTldsNotOwnedBy,
  MAX_BULK_TLDS,
  normalizeLabel,
  normalizeMode,
  normalizePinKind,
  normalizeTld,
  openNamePurchase,
  parseMoshpitName,
  PIN_KINDS,
  pinsForName,
  quoteName,
  registerName,
  registerTld,
  registerTlds,
  releaseName,
  removePin,
  resolutionPreference,
  resolveMoshpitName,
  setAlias,
  setExempt,
  setNameTarget,
  setTldPrice,
  summarizeBulkClaim,
  tldRejection,
} from "../moshpit.mjs";
import { config } from "../config.mjs";

export const moshpitRouter = Router();

const bad = (res, error, status = 400) => res.status(status).json({ error });
const unauthorized = (res) => res.status(401).json({ error: "sign in first" });

/* ---------- API ---------- */

moshpitRouter.get("/api/moshpit/tlds", async (req, res) => {
  if (req.query.mine) {
    if (!req.user) return unauthorized(res);
    return res.json({ tlds: await listTldsForUser(req.user.id) });
  }
  res.json({ tlds: await listTlds() });
});

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
  res.json({ ...resolution, mode, prefer: resolutionPreference({ registered: resolution.registered, mode }) });
});

/* ---------- the human page ---------- */

const claimForm = (req, prefill = "") => `
<form method="post" action="/pit/claim" class="pit-form">
  ${csrfInput(req)}
  <label class="pit-field"><span class="pit-dot">.</span
    ><input name="tld" placeholder="eggs" aria-label="the TLD you want" autocomplete="off" spellcheck="false"
      value="${esc(prefill)}" required></label>
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
.yeah
oranges
# dots optional · commas or newlines · # comments ignored"></textarea>
    <p class="mono faint" style="font-size:.7rem;margin:8px 0 10px">
      Up to ${MAX_BULK_TLDS} at a time. Ones already taken are reported, not fatal —
      the rest still land.
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
        <input name="target" placeholder="points at… (optional)" autocomplete="off">
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
.pit-bulk{margin:0 0 18px;max-width:62ch}
.pit-bulk summary{font-family:var(--mono);font-size:.74rem;letter-spacing:.08em;color:var(--dim);cursor:pointer;padding:6px 0}
.pit-bulk summary:hover{color:var(--acid)}
.pit-bulk textarea{width:100%;box-sizing:border-box;background:var(--bg);color:var(--text);
  border:1px solid var(--line);border-radius:6px;padding:10px 12px;font-family:var(--mono);
  font-size:.8rem;line-height:1.55;resize:vertical;min-height:9em}
.pit-bulk textarea:focus{outline:none;border-color:var(--acid)}
.pit-tabs{display:flex;gap:4px;margin:22px 0 26px;border-bottom:1px solid var(--line)}
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
.pit-land .pit-form,.pit-land .pit-row{margin-bottom:0}`;

/**
 * The tab strip: the endings you hold, the ones you can buy from, and how to
 * reach any of them from a machine. One strip rather than tabs inside tabs --
 * these are three views of the same namespace, and a link buried in a paragraph
 * is not how anyone finds the last one.
 *
 * `counts` is omitted on /pit/dns, which does not load the registry.
 */
const pitTabs = (active, counts = null) => `
<nav class="pit-tabs">
  <a class="pit-tab${active === "yours" ? " on" : ""}" href="/pit?tab=yours">Yours${
    counts ? `<span class="count">${counts.yours}</span>` : ""}</a>
  <a class="pit-tab${active === "theirs" ? " on" : ""}" href="/pit?tab=theirs">Theirs${
    counts ? `<span class="count">${counts.theirs}${counts.forSale ? ` · ${counts.forSale} for sale` : ""}</span>` : ""}</a>
  <a class="pit-tab${active === "dns" ? " on" : ""}" href="/pit/dns">Use it (DNS)</a>
</nav>`;

const forSale = (t) => t.price_usd !== null && t.price_usd !== undefined;

moshpitRouter.get("/pit", async (req, res) => {
  const [theirs, mine, bal] = await Promise.all([
    listTldsNotOwnedBy(req.user?.id ?? null, { limit: 100 }),
    req.user ? listTldsForUser(req.user.id) : [],
    req.user ? balance(req.user.id) : 0,
  ]);

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

  // An unknown ?tab= falls back to Yours rather than rendering an empty page.
  const tab = req.query.tab === "theirs" ? "theirs" : "yours";
  const forSaleCount = theirs.filter(forSale).length;

  // Per-TLD detail is only needed by the panel actually on screen, and only
  // Yours has any: Theirs is one row per ending.
  const exemptions = new Map();
  const names = new Map();
  if (tab === "yours") {
    // Exemptions are only meaningful for a TLD that points somewhere.
    await Promise.all(mine.filter((t) => t.alias_of).map(async (t) => exemptions.set(t.tld, await listExempt(t.tld))));
    await Promise.all(mine.map(async (t) => names.set(t.tld, await listNames(t.tld))));
  }

  const msg = req.query.err ? `<p class="pit-msg err">${esc(req.query.err)}</p>`
    : req.query.ok ? `<p class="pit-msg ok">${esc(req.query.ok)}</p>` : "";

  const mineHtml = !req.user
    ? `<p class="dim">Sign in with your moshcode account to claim one — the same login the CLI uses.</p>
       <p><a class="btn acid" href="/">Sign in →</a></p>`
    : mine.length
      ? mine.map((t) => `
        <div class="pit-tld">
          <h3 class="acid">.${esc(t.tld)}</h3>
          <div class="mono faint" style="font-size:.72rem">
            ${t.alias_of ? `points at <span class="acid">.${esc(t.alias_of)}</span>` : "stands on its own"}
          </div>
          <div class="pit-names">
            ${(names.get(t.tld) || []).length
              ? (names.get(t.tld) || []).map((n) => `
                <form method="post" action="/pit/${esc(t.tld)}/names" class="pit-row pit-name">
                  ${csrfInput(req)}
                  <input type="hidden" name="label" value="${esc(n.label)}">
                  <span class="mono acid">${esc(n.label)}.${esc(t.tld)}</span>
                  <input name="target" placeholder="points at…" value="${esc(n.target || "")}" autocomplete="off">
                  <button class="btn" type="submit" name="retarget" value="1">Save</button>
                  <button class="btn" type="submit" name="release" value="1">Release</button>
                </form>`).join("")
              : `<p class="mono faint" style="font-size:.72rem;margin:6px 0">no names under .${esc(t.tld)} yet</p>`}
            <form method="post" action="/pit/${esc(t.tld)}/names" class="pit-row">
              ${csrfInput(req)}
              <input name="label" placeholder="new name" autocomplete="off" required>
              <span class="mono faint">.${esc(t.tld)}</span>
              <input name="target" placeholder="points at… (optional)" autocomplete="off">
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
  ${pitTabs(tab, { yours: mine.length, theirs: theirs.length, forSale: forSaleCount })}

  <section class="pit-panel">
  ${tab === "yours" ? `
    <p class="dim" style="max-width:62ch;margin:0 0 14px">
      Endings you hold. Names under them are yours to mint for nothing — or put a price on the
      ending and let anyone buy one.
    </p>
    ${mineHtml}
  ` : `
    <p class="dim" style="max-width:62ch;margin:0 0 14px">
      Endings somebody else holds. Where the operator has set a price you can buy a name under it —
      <span class="mono">foo.whatever</span> without owning <span class="mono">.whatever</span>. Paid in crypto
      through CoinPay; the name lands the moment the payment confirms.
    </p>
    ${theirsHtml}
  `}
  </section>
</main>${footer}`,
  }));
});

/**
 * GET /pit/dns — how to actually reach these names from a machine.
 *
 * A namespace nobody can resolve is a list of words. The resolvers answer
 * Moshpit names from this registry and forward everything else to the ordinary
 * internet, so the instruction is "change one setting", not "install a
 * browser".
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
      ${doh ? `The endpoint is <code>${esc(doh)}</code>.` : "An endpoint appears here once a resolver is up."}</li>
  </ol>

  <h2 style="margin-top:34px;font-size:1.2rem">Check it worked</h2>
  <pre class="pit-pre"><code>dig +short anything.moshpit     <span class="faint"># an address, not an error</span>
dig +short example.com          <span class="faint"># the ordinary internet, still fine</span>
nslookup anything.moshpit       <span class="faint"># the Windows spelling</span></code></pre>
  <p class="pit-copy" style="font-size:.9rem">
    A <code>TXT</code> lookup on any Moshpit name reports which registry and gateway answered — the
    fastest way to tell a resolver problem from a site problem.
  </p>

  <h2 style="margin-top:34px;font-size:1.2rem">What still breaks</h2>
  <p class="pit-copy">
    <code>https://</code> on a Moshpit name will warn. No public certificate authority will issue for
    <span class="mono">scrambled.eggs</span>, because none of them recognise a namespace that does not
    descend from the ICANN root. Plain <code>http://</code> works, and so does this site. A
    certificate authority you opt into is the real answer, and it is not built yet.
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
 */
moshpitRouter.post("/pit/claim-bulk", requireAuth, async (req, res) => {
  const result = await registerTlds({
    input: req.body?.tlds, userId: req.user.id, ownerEmail: req.user.email ?? null,
  });
  // The flash rides back in the query string, so it has to stay short enough
  // to survive a URL.
  const summary = summarizeBulkClaim(result).slice(0, 500);
  return back(res, result.claimed.length ? { ok: summary } : { err: summary });
});

moshpitRouter.post("/pit/claim", requireAuth, async (req, res) => {
  const result = await registerTld({
    tld: req.body?.tld, userId: req.user.id, ownerEmail: req.user.email ?? null,
  });
  if (!result.ok) return back(res, { err: result.error || "could not register that TLD" });
  back(res, { ok: `.${result.tld.tld} is yours.` });
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
