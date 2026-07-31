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
import { Router } from "express";
import { page, footer, appBar, esc } from "../lib/html.mjs";
import { requireAuth, csrfInput } from "../lib/session.mjs";
import { balance } from "../lib/credits.mjs";
import {
  getTld, listTlds, listTldsForUser, registerTld, normalizeLabel,
  setAlias, clearAlias, listExempt, setExempt, clearExempt,
  listNames, registerName, setNameTarget, releaseName,
  resolveMoshpitName, normalizeTld, tldRejection,
  normalizeMode, resolutionPreference,
} from "../moshpit.mjs";

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

const claimForm = (req) => `
<form method="post" action="/pit/claim" class="pit-form">
  ${csrfInput(req)}
  <label class="pit-field"><span class="pit-dot">.</span
    ><input name="tld" placeholder="eggs" aria-label="the TLD you want" autocomplete="off" spellcheck="false" required></label>
  <button class="btn acid" type="submit">Claim it</button>
</form>`;

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
.pit-msg{border-radius:8px;padding:10px 14px;margin:14px 0;font-family:var(--mono);font-size:.84rem}
.pit-msg.err{border:1px solid var(--danger);color:var(--danger)}
.pit-msg.ok{border:1px solid var(--acid);color:var(--acid)}`;

moshpitRouter.get("/pit", async (req, res) => {
  const [registry, mine, bal] = await Promise.all([
    listTlds(50),
    req.user ? listTldsForUser(req.user.id) : [],
    req.user ? balance(req.user.id) : 0,
  ]);

  // Exemptions are only meaningful for a TLD that points somewhere, so only
  // those cost a query.
  const exemptions = new Map();
  await Promise.all(mine.filter((t) => t.alias_of).map(async (t) => exemptions.set(t.tld, await listExempt(t.tld))));

  const names = new Map();
  await Promise.all(mine.map(async (t) => names.set(t.tld, await listNames(t.tld))));

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
        </div>`).join("")
      : `<p class="dim">You don't hold a TLD yet. Claim one above.</p>`;

  const registryHtml = registry.length
    ? `<ul class="mono dim" style="line-height:1.9;padding-left:18px">${registry.map((t) =>
        `<li><span class="acid">.${esc(t.tld)}</span>${t.alias_of ? ` → .${esc(t.alias_of)}` : ""}</li>`).join("")}</ul>`
    : `<p class="dim">Nothing claimed yet.</p>`;

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
  ${msg}
  ${req.user ? claimForm(req) : ""}
  <h2 style="margin-top:34px;font-size:1.2rem">Yours</h2>
  ${mineHtml}
  <h2 style="margin-top:34px;font-size:1.2rem">The registry</h2>
  ${registryHtml}
</main>${footer}`,
  }));
});

/* ---------- form posts (browser, CSRF-guarded) ---------- */

const back = (res, params) => res.redirect(`/pit?${new URLSearchParams(params)}`);

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

moshpitRouter.post("/pit/:tld/exempt", requireAuth, async (req, res) => {
  const result = await setExempt({ tld: req.params.tld, label: req.body?.label, userId: req.user.id });
  if (!result.ok) return back(res, { err: result.error || "could not exempt that name" });
  back(res, { ok: `${normalizeLabel(req.body?.label)}.${req.params.tld} stays put.` });
});
