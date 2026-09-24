// Operator-only routes.
//
//   GET /api/admin/users/export?format=csv|json   every account with an email
//
// "Operator" is an allowlist, ADMIN_EMAILS, checked against the account behind
// the request: a CLI API key (what `moshcode export users` sends) or the
// browser session. Nobody else gets anything but a 403, and an unset allowlist
// means that is everybody.
import { Router } from "express";
import { bearer, userForApiKey } from "../lib/apikey.mjs";
import { EXPORT_COLUMNS, exportUsers, isAdmin, toCsv } from "../lib/user-export.mjs";

export const adminRouter = Router();

/**
 * Resolve the caller and require an operator.
 *
 * A Bearer header is authoritative when present: a request that sends a bad
 * key is refused even if it also carries a session cookie, so a script never
 * succeeds by accident on the strength of a browser login.
 */
export async function requireAdmin(req, res, next) {
  try {
    const sent = bearer(req);
    const user = sent ? await userForApiKey(sent) : req.user;
    if (!user) return res.status(401).json({ error: "sign in, or send an API key: Authorization: Bearer mck_..." });
    if (!isAdmin(user)) return res.status(403).json({ error: "operator access is required" });
    req.adminUser = user;
    next();
  } catch (error) {
    next(error);
  }
}

adminRouter.get("/api/admin/users/export", requireAdmin, async (req, res, next) => {
  try {
    const format = String(req.query.format || "csv").toLowerCase();
    if (!["csv", "json"].includes(format)) return res.status(400).json({ error: "format must be csv or json" });
    const { users, counts } = await exportUsers();
    // An address list is the last thing a shared cache should keep.
    res.set("Cache-Control", "no-store");
    console.log(`[admin] ${req.adminUser.email} exported ${users.length} users (${format})`);
    if (format === "json") return res.json({ columns: EXPORT_COLUMNS, users, counts });
    res.set("X-Users-Total", String(counts.total));
    res.set("X-Users-With-Email", String(counts.with_email));
    res.set("X-Users-Without-Email", String(counts.without_email));
    res.set("Content-Disposition", `attachment; filename="moshcode-users-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.type("text/csv; charset=utf-8").send(toCsv(users));
  } catch (error) {
    next(error);
  }
});
