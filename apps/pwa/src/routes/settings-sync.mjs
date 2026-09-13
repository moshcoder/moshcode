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
import {
  KEEP_REVISIONS as PACKAGE_KEEP_REVISIONS,
  digestSnapshot as digestPackageSnapshot,
  handleGet,
  handlePut,
  handleRevisions,
  snapshotProblem as packageSnapshotProblem,
} from "@profullstack/synconfig/server";
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
export const KEEP_REVISIONS = PACKAGE_KEEP_REVISIONS;

/** Total snapshot size, and how many files one may carry. */
export const MAX_SNAPSHOT_BYTES = 256 * 1024;
export const MAX_FILES = 32;

/** The caps as @profullstack/synconfig takes them. Per-file matches the CLI's MAX_FILE_BYTES. */
const LIMITS = { maxFileBytes: 64 * 1024, maxTotalBytes: MAX_SNAPSHOT_BYTES, maxFiles: MAX_FILES };

/**
 * Is this shaped like a snapshot? Returns null when it is, else the reason.
 *
 * Structural only, and the package's: the body is small, it is shaped like a
 * snapshot, no name in it is a path traversal. moshcode's own list of which
 * files sync stays in the CLI, so a release that syncs one more file needs
 * no deploy here.
 */
export function snapshotProblem(snapshot, { maxBytes = MAX_SNAPSHOT_BYTES } = {}) {
  return packageSnapshotProblem(snapshot, { ...LIMITS, maxTotalBytes: maxBytes });
}

/**
 * The digest the CLI computes, recomputed here so the stored one is ours.
 * Both sides are the package now; the pinned fixture in both suites stays.
 */
export function digestSnapshot(snapshot) {
  return digestPackageSnapshot(snapshot);
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

const shape = (row) => ({
  revision: Number(row.revision),
  digest: row.digest,
  host: row.host,
  version: row.version,
  size: Number(row.size),
  body: JSON.parse(row.body),
  savedAt: Number(row.created_at),
});

/**
 * The package's SnapshotStore over this app's database.
 *
 * The revision is chosen inside the INSERT, and `ifRevision` is checked there
 * too, by a HAVING on the same aggregate. Reading MAX(revision) first and then
 * inserting is not enough against a network database: both requests see the
 * same maximum and one save silently replaces the other. Here the second one
 * either trips the HAVING (no row inserted — a conflict we can report) or the
 * unique index (an error we retry as a conflict).
 *
 * GROUP BY user_id is not decoration. A bare HAVING on an implicit
 * single-group aggregate is accepted by the SQLite that backs a `file:`
 * database and *rejected by Turso's parser*:
 *
 *   SQL string could not be parsed: near HAVING, "None": syntax error
 *
 * So the unconditional insert takes the branch with no HAVING at all.
 */
export const snapshotStore = {
  async latest(userId) {
    const row = await latest(userId);
    return row ? shape(row) : null;
  },

  async insert(userId, entry, ifRevision) {
    const body = JSON.stringify(entry.body);
    const row = { id: id(), created_at: Date.now() };
    const sql = ifRevision === null
      ? `INSERT INTO settings_snapshots (id,user_id,revision,digest,host,version,size,body,created_at)
         SELECT ?, ?, COALESCE(MAX(revision),0) + 1, ?, ?, ?, ?, ?, ?
         FROM settings_snapshots WHERE user_id = ?
         RETURNING revision`
      : `INSERT INTO settings_snapshots (id,user_id,revision,digest,host,version,size,body,created_at)
         SELECT ?, ?, COALESCE(MAX(revision),0) + 1, ?, ?, ?, ?, ?, ?
         FROM settings_snapshots WHERE user_id = ?
         GROUP BY user_id
         HAVING COALESCE(MAX(revision),0) = ?
         RETURNING revision`;
    const args = [row.id, userId, entry.digest, entry.host, entry.version, entry.size, body, row.created_at, userId];
    if (ifRevision !== null) args.push(ifRevision);

    let inserted;
    try { inserted = await get(sql, args); }
    catch (e) {
      if (/UNIQUE|constraint/i.test(String(e?.message || e))) inserted = null;
      else throw e;
    }
    if (!inserted) {
      const current = await latest(userId);
      return { conflict: true, revision: current ? Number(current.revision) : 0 };
    }
    const revision = Number(inserted.revision);
    // Prune by revision rather than by count: the index makes this one range
    // delete, and it cannot race with a concurrent save the way "delete all but
    // the newest N" can.
    await run(`DELETE FROM settings_snapshots WHERE user_id = ? AND revision <= ?`,
      [userId, revision - KEEP_REVISIONS]);
    return { revision, savedAt: row.created_at };
  },

  async list(userId, limit) {
    const rows = await all(
      `SELECT revision, digest, host, version, size, created_at FROM settings_snapshots
       WHERE user_id = ? ORDER BY revision DESC LIMIT ?`,
      [userId, limit]
    );
    return rows.map((r) => ({
      revision: Number(r.revision),
      digest: r.digest,
      host: r.host,
      version: r.version,
      size: Number(r.size),
      savedAt: Number(r.created_at),
    }));
  },
};

/** An older body promoted to a new revision: the store's insert, unconditional. */
async function insertRevision({ userId, body, digest, host, version, ifRevision }) {
  return snapshotStore.insert(userId, { digest, host, version, size: Buffer.byteLength(body), body: JSON.parse(body) }, ifRevision);
}

/** Where moshcode keeps its version in a snapshot; `app` is what newer clients also send. */
const versionOf = (snapshot) => (snapshot.moshcode ? String(snapshot.moshcode).slice(0, 20) : snapshot.app ? String(snapshot.app).slice(0, 20) : null);

/* --------------------------------------------------------------- CLI (Bearer) */

settingsSyncRouter.put("/api/settings", cliAuth, async (req, res) => {
  const reply = await handlePut(snapshotStore, req.apiUser.id, req.body, { limits: LIMITS, versionOf });
  res.status(reply.status).json(reply.body);
});

settingsSyncRouter.get("/api/settings", cliAuth, async (req, res) => {
  const reply = await handleGet(snapshotStore, req.apiUser.id);
  res.status(reply.status).json(reply.body);
});

settingsSyncRouter.get("/api/settings/revisions", cliAuth, async (req, res) => {
  const reply = await handleRevisions(snapshotStore, req.apiUser.id, KEEP_REVISIONS);
  res.status(reply.status).json(reply.body);
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
