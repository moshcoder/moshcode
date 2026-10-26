#!/usr/bin/env bun
// Operator CLI for credit codes and invites, against the app's own DATABASE_URL.
//
//   bun apps/pwa/scripts/credit-codes.mjs mint --credits 1000 --label "for Preshy" [--max 1] [--expires-days 90] [--json]
//   bun apps/pwa/scripts/credit-codes.mjs list [--json]
//   bun apps/pwa/scripts/credit-codes.mjs revoke <code-id>
//   bun apps/pwa/scripts/credit-codes.mjs quota <email> <invites>
//
// On dev2: docker exec appmoshcodesh-app-1 bun apps/pwa/scripts/credit-codes.mjs mint --credits 1000 --label "for X"
// The plaintext code is printed once; only its hash is stored.
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    credits: { type: "string" },
    label: { type: "string", default: "" },
    max: { type: "string", default: "1" },
    "expires-days": { type: "string" },
    by: { type: "string", default: "operator" },
    json: { type: "boolean", default: false },
  },
});

const { mintCode, getCredits, getAffiliates, closeCodeStores } = await import("../src/lib/credit-codes.mjs");
const { get, db } = await import("../src/db.mjs");
const { config } = await import("../src/config.mjs");

const [cmd, ...rest] = positionals;
const out = (obj, text) => console.log(values.json ? JSON.stringify(obj, null, 2) : text);

try {
  if (cmd === "mint") {
    const m = await mintCode({ credits: values.credits, label: values.label, max: values.max, expiresInDays: values["expires-days"], createdBy: values.by });
    const url = `${config.origin}/redeem?code=${encodeURIComponent(m.code)}`;
    out({ ...m, url }, `${m.code}\n  ${m.grant.amount} credits, ${m.maxRedemptions} use(s)${m.expiresAt ? `, expires ${new Date(m.expiresAt).toISOString().slice(0, 10)}` : ""}\n  ${url}\n  id ${m.id}`);
  } else if (cmd === "list") {
    const codes = await (await getCredits()).list();
    out(codes, codes.map((c) => `${c.id}  ${c.grant.amount} ${c.grant.unit}  ${c.redemptions}/${c.maxRedemptions}${c.revokedAt ? "  revoked" : ""}  ${c.label}`).join("\n") || "no codes");
  } else if (cmd === "revoke" && rest[0]) {
    await (await getCredits()).revoke(rest[0]);
    out({ ok: true, id: rest[0] }, `revoked ${rest[0]}`);
  } else if (cmd === "quota" && rest[0] && rest[1]) {
    const user = await get(`SELECT id FROM users WHERE email = ?`, [rest[0].toLowerCase()]);
    if (!user) throw new Error(`no account with email ${rest[0]}`);
    const aff = await getAffiliates();
    await aff.setQuota(user.id, Number(rest[1]));
    const q = await aff.quota(user.id);
    out(q, `${rest[0]}: ${q.left} of ${q.total} invites left`);
  } else {
    console.error("usage: credit-codes.mjs mint --credits N [--label L] [--max N] [--expires-days N] | list | revoke <id> | quota <email> <n>");
    process.exitCode = 2;
  }
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await closeCodeStores();
  await db.close?.();
}
