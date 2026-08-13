// Settings sync — the account half of `/save` and `/load` in the pit.
//
//   PUT  /api/settings                     CLI saves a snapshot (Bearer key)
//   GET  /api/settings                     CLI reads the current one
//   GET  /api/settings/revisions           CLI/human: what has been saved
//   GET  /settings/sync                    human: the revisions, and what they carry
//   POST /settings/sync/:revision/restore  human: make an older one current
//   POST /settings/sync/forget             human: delete the lot
//
// The app treats a snapshot as opaque text with a size limit. It deliberately
// does not enforce moshcode's own list of which files sync: that list belongs to
// the release that reads it, and a CLI that starts syncing one more file must
// not need this service redeployed to do it. What the app does enforce is what
// only it can — that the body is small, that it is shaped like a snapshot, that
// no name in it is a path traversal, and that two machines saving at once cannot
// silently overwrite each other.
import { Router } from "express";
import { get, all, run } from "../db.mjs";
import { id, sha256 } from "../lib/crypto.mjs";
import { bearer, userForApiKey } from "../lib/apikey.mjs";
import { balance } from "../lib/credits.mjs";
import { page, footer, appBar, esc } from "../lib/html.mjs";
import { requireAuth, csrfInput } from "../lib/session.mjs";

export const settingsSyncRouter = Router();

/**
 * Revisions kept per account.
 *
 * Enough that a bad `/save` from the wrong machine is recoverable by looking at
 * the page and pressing a button, few enough that a scripted save loop can't
 * grow one account's row count without bound.
 */
export const KEEP_REVISIONS = 10;

/** Total snapshot size, and how many files one may carry. */
export const MAX_SNAPSHOT_BYTES = 256 * 1024;
export const MAX_FILES = 32;

/**
 * Is this shaped like a snapshot? Returns null when it is, else the reason.
 *
 * Structural only — see the header. The one substantive rule is on names: a
 * snapshot is applied by writing its keys as paths under ~/.moshcode, so a name
 * carrying `..`, a leading slash, a backslash or a NUL has no honest reading and
 * is refused at the door rather than stored for a client to refuse later.
 */
export function snapshotProblem(snapshot, { maxBytes = MAX_SNAPSHOT_BYTES } = {}) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return "not a snapshot";
  const files = snapshot.files;
  if (!files || typeof files !== "object" || Array.isArray(files)) return "no files in the snapshot";
  const names = Object.keys(files);
  if (!names.length) return "no files in the snapshot";
  if (names.length > MAX_FILES) return `too many files (${names.length}, the cap is ${MAX_FILES})`;
  for (const name of names) {
    if (!name || name.length > 200) return "a file name is empty or absurdly long";
    if (name.startsWith("/") || name.includes("..") || name.includes("\\") || name.includes("\0")) {
      return `"${name}" is not a settings path`;
    }
    if (typeof files[name]?.content !== "string") return `"${name}" has no contents`;
  }
  const bytes = Buffer.byteLength(JSON.stringify(snapshot));
  if (bytes > maxBytes) return `snapshot is ${bytes} bytes — the cap is ${maxBytes}`;
  return null;
}

/**
 * The digest the CLI computes, recomputed here so the stored one is ours.
 *
 * Byte-for-byte the same construction as `digestFiles` in
 * src/settings-sync.mjs: names sorted, each field framed by a NUL and preceded
 * by its byte length. Two implementations of one hash is a drift risk, so both
 * sides pin the digest of a fixed input in their tests — this one in
 * apps/pwa/test/settings-sync.test.mjs, the CLI's in test/settings-sync.test.mjs
 * — and any change to either framing fails both.
 */
export function digestSnapshot(snapshot) {
  const files = snapshot.files;
  let material = "";
  for (const name of Object.keys(files).sort()) {
    const content = String(files[name].content);
    material += `${name}\0${Buffer.byteLength(content)}\0${content}\0`;
  }
  return sha256(material);
}

async function cliAuth(req, res, next) {
  const user = await userForApiKey(bearer(req));
  if (!user) return res.status(401).json({ error: "invalid or missing API key" });
  req.apiUser = user;
  next();
}

const latest = (userId) =>
  get(`SELECT * FROM settings_snapshots WHERE user_id = ? ORDER BY revision DESC LIMIT 1`, [userId]);

/**
 * The current revision's metadata, for the /settings summary card. Never the
 * body — the page it feeds has no business rendering someone's config.
 */
export async function latestSnapshotMeta(userId) {
  const row = await get(
    `SELECT revision, host, version, size, created_at FROM settings_snapshots
     WHERE user_id = ? ORDER BY revision DESC LIMIT 1`,
    [userId]
  );
  return row
    ? { revision: Number(row.revision), host: row.host, version: row.version, size: Number(row.size), savedAt: Number(row.created_at) }
    : null;
}

/** An older body promoted to a new revision, or a fresh save — one code path. */
async function insertRevision({ userId, body, digest, host, version, ifRevision }) {
  const size = Buffer.byteLength(body);
  const row = { id: id(), created_at: Date.now() };

  // The revision is chosen inside the INSERT, and `ifRevision` is checked there
  // too, by a HAVING on the same aggregate. Reading MAX(revision) first and then
  // inserting is not enough against a network database: both requests see the
  // same maximum and one save silently replaces the other. Here the second one
  // either trips the HAVING (no row inserted — a conflict we can report) or the
  // unique index (an error we retry as a conflict).
  const sql = ifRevision === null
    ? `INSERT INTO settings_snapshots (id,user_id,revision,digest,host,version,size,body,created_at)
       SELECT ?, ?, COALESCE(MAX(revision),0) + 1, ?, ?, ?, ?, ?, ?
       FROM settings_snapshots WHERE user_id = ?
       RETURNING revision`
    // GROUP BY user_id is not decoration. A bare HAVING on an implicit
    // single-group aggregate is accepted by the SQLite that backs a `file:`
    // database and *rejected by Turso's parser*:
    //
    //   SQL string could not be parsed: near HAVING, "None": syntax error
    //
    // So this statement worked in every test and threw on every deployment,
    // which is what `/save` returning 502 actually was. `--force` sends
    // ifRevision: null and takes the branch above, which is why forcing was the
    // only way to save. The rows always exist here — the caller sets ifRevision
    // to null when the account has no current revision — so grouping by the
    // user cannot lose the row the HAVING is meant to test.
    : `INSERT INTO settings_snapshots (id,user_id,revision,digest,host,version,size,body,created_at)
       SELECT ?, ?, COALESCE(MAX(revision),0) + 1, ?, ?, ?, ?, ?, ?
       FROM settings_snapshots WHERE user_id = ?
       GROUP BY user_id
       HAVING COALESCE(MAX(revision),0) = ?
       RETURNING revision`;
  const args = [row.id, userId, digest, host, version, size, body, row.created_at, userId];
  if (ifRevision !== null) args.push(ifRevision);

  let inserted;
  try { inserted = await get(sql, args); }
  catch (e) {
    // The unique index fired: another save took this revision between our
    // aggregate and our insert. Same answer as a failed HAVING.
    if (/UNIQUE|constraint/i.test(String(e?.message || e))) return { conflict: true };
    throw e;
  }
  if (!inserted) return { conflict: true };

  const revision = Number(inserted.revision);
  // Prune by revision rather than by count: the index makes this one range
  // delete, and it cannot race with a concurrent save the way "delete all but
  // the newest N" can.
  await run(`DELETE FROM settings_snapshots WHERE user_id = ? AND revision <= ?`,
    [userId, revision - KEEP_REVISIONS]);
  return { revision, digest, savedAt: row.created_at, size };
}

/* --------------------------------------------------------------- CLI (Bearer) */

settingsSyncRouter.put("/api/settings", cliAuth, async (req, res) => {
  const snapshot = req.body?.snapshot;
  const problem = snapshotProblem(snapshot);
  if (problem) return res.status(400).json({ error: problem });

  // `ifRevision` absent or null means "save regardless" — `/save --force`, or a
  // machine that has never synced. A number means "only if the account is still
  // where I left it".
  const asked = req.body?.ifRevision;
  let ifRevision = asked === null || asked === undefined ? null : Number(asked);
  if (ifRevision !== null && !Number.isSafeInteger(ifRevision)) {
    return res.status(400).json({ error: "ifRevision must be an integer or null" });
  }

  const digest = digestSnapshot(snapshot);
  const current = await latest(req.apiUser.id);

  // Byte-identical to what is already current: answer with that revision and
  // insert nothing. The check lives here rather than in the CLI because only the
  // account knows what it holds — a CLI that skipped the request on the strength
  // of its own marker reported "already saved" to someone who had just deleted
  // everything from the web, and left them stuck behind a --force.
  if (current && current.digest === digest) {
    return res.json({
      revision: Number(current.revision),
      digest,
      savedAt: Number(current.created_at),
      unchanged: true,
    });
  }

  // A precondition against an account with nothing in it cannot be protecting
  // anything: the revisions it names are gone (forgotten from the web), so there
  // is no other machine's save to lose. Refusing here would strand every machine
  // behind --force after a perfectly deliberate delete.
  if (!current) ifRevision = null;

  const result = await insertRevision({
    userId: req.apiUser.id,
    body: JSON.stringify(snapshot),
    digest,
    host: snapshot.host ? String(snapshot.host).slice(0, 60) : null,
    version: snapshot.moshcode ? String(snapshot.moshcode).slice(0, 20) : null,
    ifRevision,
  });

  if (result.conflict) {
    const current = await latest(req.apiUser.id);
    return res.status(409).json({
      error: "the account has been saved from another machine since then",
      revision: current ? Number(current.revision) : 0,
    });
  }
  res.json({ revision: result.revision, digest: result.digest, savedAt: result.savedAt });
});

settingsSyncRouter.get("/api/settings", cliAuth, async (req, res) => {
  const row = await latest(req.apiUser.id);
  if (!row) return res.status(404).json({ error: "nothing saved yet" });
  let snapshot;
  // Stored as the CLI sent it, so a body that will not parse is a bug on this
  // side of the wire — say so rather than handing the CLI a 200 it can't use.
  try { snapshot = JSON.parse(row.body); }
  catch { return res.status(500).json({ error: "the stored snapshot is unreadable" }); }
  res.json({
    revision: Number(row.revision),
    digest: row.digest,
    savedAt: Number(row.created_at),
    host: row.host,
    version: row.version,
    snapshot,
  });
});

settingsSyncRouter.get("/api/settings/revisions", cliAuth, async (req, res) => {
  const rows = await all(
    `SELECT revision, digest, host, version, size, created_at FROM settings_snapshots
     WHERE user_id = ? ORDER BY revision DESC`,
    [req.apiUser.id]
  );
  res.json({
    revisions: rows.map((r) => ({
      revision: Number(r.revision),
      digest: r.digest,
      host: r.host,
      version: r.version,
      size: Number(r.size),
      savedAt: Number(r.created_at),
    })),
  });
});

/* ------------------------------------------------------------ human (cookies) */

const ago = (ts) => {
  const s = Math.max(0, Math.floor((Date.now() - Number(ts)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

/** The file names in a stored body, for the page. Never the contents. */
export function fileNames(body) {
  try {
    const files = JSON.parse(body)?.files;
    return files && typeof files === "object" ? Object.keys(files).sort() : [];
  } catch { return []; }
}

settingsSyncRouter.get("/settings/sync", requireAuth, async (req, res) => {
  const rows = await all(
    `SELECT * FROM settings_snapshots WHERE user_id = ? ORDER BY revision DESC`,
    [req.user.id]
  );
  const current = rows[0] || null;

  const revisionRows = rows.map((r, index) => {
    const names = fileNames(r.body);
    return `<div style="display:flex;gap:12px;align-items:center;padding:12px 0;border-bottom:1px solid var(--line)" class="mono">
      <span style="flex:1">
        <b>revision ${Number(r.revision)}</b>${index === 0 ? ` <span class="acid" style="font-size:.7rem">current</span>` : ""}
        <div class="faint" style="font-size:.72rem;margin-top:3px">
          ${esc(r.host || "unknown machine")}${r.version ? ` · v${esc(r.version)}` : ""} · ${ago(r.created_at)} · ${Number(r.size)}b
        </div>
        <div class="dim" style="font-size:.72rem;margin-top:2px">${names.length ? names.map((n) => esc(n)).join(" · ") : "no files"}</div>
      </span>
      ${index === 0 ? "" : `<form method="post" action="/settings/sync/${Number(r.revision)}/restore" style="margin:0">${csrfInput(req)}<button class="btn" style="padding:5px 10px;font-size:.72rem">make current</button></form>`}
    </div>`;
  }).join("");

  const body = `${appBar(req.user, await balance(req.user.id), req.csrfToken)}
  <main class="wrap" style="max-width:720px;padding-top:30px">
    <h1 style="font-size:1.5rem;margin-bottom:6px">Settings sync</h1>
    <p class="dim mono" style="font-size:.8rem;margin-bottom:20px">
      Your pit's configuration — aliases, herd rules — as saved by
      <span class="acid">/save</span>. Pull it onto any machine that is logged in with
      <span class="acid">/load</span>.
    </p>

    <div class="card" style="margin-bottom:22px"><div class="card-head"><span class="h">Saved revisions</span></div>
      <div class="card-body">
        ${rows.length ? revisionRows : `<div class="faint mono" style="font-size:.78rem;padding:6px 0">
          Nothing saved yet. In the pit: <span class="acid">/save</span>.
        </div>`}
        ${rows.length ? `<p class="faint mono" style="font-size:.72rem;margin-top:14px">
          The last ${KEEP_REVISIONS} saves are kept. "Make current" copies an older revision to the
          top of the list — the machines you run <span class="acid">/load</span> on then pick it up.
          No credentials are ever part of a snapshot.
        </p>` : ""}
      </div>
    </div>

    ${rows.length ? `<div class="card"><div class="card-head"><span class="h">Danger zone</span></div>
      <div class="card-body">
        <p class="dim mono" style="font-size:.78rem;margin-top:0">
          Deletes every saved revision. The settings on your machines are untouched —
          this only empties the account copy.
        </p>
        <form method="post" action="/settings/sync/forget" style="margin:0">${csrfInput(req)}
          <button class="btn danger" style="padding:6px 12px;font-size:.74rem">Forget saved settings</button>
        </form>
      </div>
    </div>` : ""}

    <p class="faint mono" style="font-size:.74rem;margin-top:18px">
      ${current ? `Current: revision ${Number(current.revision)} · digest ${esc(String(current.digest).slice(0, 12))}…` : ""}
      <a class="acid" href="/settings" style="margin-left:auto">← settings</a>
    </p>
  </main>${footer}`;
  res.type("html").send(page({ title: "moshcode ▸ settings sync", body }));
});

settingsSyncRouter.post("/settings/sync/:revision/restore", requireAuth, async (req, res) => {
  const wanted = Number(req.params.revision);
  if (!Number.isSafeInteger(wanted)) return res.redirect("/settings/sync");
  const row = await get(`SELECT * FROM settings_snapshots WHERE user_id = ? AND revision = ?`,
    [req.user.id, wanted]);
  if (!row) return res.redirect("/settings/sync");

  // Copied forward as a new revision rather than deleting the ones above it:
  // "make current" is then itself undoable, and a machine that had already
  // pulled revision 7 still sees a number it has never seen and knows to sync.
  await insertRevision({
    userId: req.user.id,
    body: row.body,
    digest: row.digest,
    host: row.host,
    version: row.version,
    ifRevision: null,
  });
  res.redirect("/settings/sync");
});

settingsSyncRouter.post("/settings/sync/forget", requireAuth, async (req, res) => {
  await run(`DELETE FROM settings_snapshots WHERE user_id = ?`, [req.user.id]);
  res.redirect("/settings/sync");
});
