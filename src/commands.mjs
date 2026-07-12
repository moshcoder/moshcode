// Built-in moshscript commands. Each is `async (ctx, args) => void`.
// Register your own with ctx.commands[name] = fn (see defaultCommands).
import crypto from "node:crypto";

const API = (process.env.MOSHCODE_API || "https://moshcoding.com").replace(/\/+$/, "");
const WEBHOOK_URL = process.env.MOSHCODE_WEBHOOK_URL || "";
const WEBHOOK_SECRET = process.env.MOSHCODE_WEBHOOK_SECRET || "";

/** Signs "<ts>.<body>" like the CoinPay/Standard-Webhooks scheme. */
function signedHeaders(body) {
  const headers = { "content-type": "application/json" };
  if (WEBHOOK_SECRET) {
    const ts = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac("sha256", WEBHOOK_SECRET).update(`${ts}.${body}`).digest("hex");
    headers["x-moshcode-signature"] = `t=${ts},v1=${sig}`;
  }
  return headers;
}

/**
 * notify() delivery: always pings moshcoding.com web notifications (signed with
 * MOSHCODE_WEBHOOK_SECRET so the /api/webhooks/moshcode receiver accepts it), and
 * also POSTs to a configured webhook (same signature) when MOSHCODE_WEBHOOK_URL
 * is set.
 */
async function deliver(type, data) {
  const body = JSON.stringify({ type, data, source: "moshcode" });
  const post = (url, label) =>
    fetch(url, { method: "POST", headers: signedHeaders(body), body })
      .then((r) => ({ target: label, ok: r.ok, status: r.status }))
      .catch((e) => ({ target: label, ok: false, error: String(e) }));

  const targets = [post(`${API}/api/webhooks/moshcode`, "moshcoding")];
  if (WEBHOOK_URL) targets.push(post(WEBHOOK_URL, "webhook"));
  return Promise.all(targets);
}

export function defaultCommands() {
  const expectNoArgs = (name, args) => {
    if (args.length > 0) {
      throw new Error(`moshscript: ${name}() does not take arguments`);
    }
  };

  return {
    code: (ctx, args) => {
      expectNoArgs("code", args);
      ctx.out("  ⌨  code()    → compiling features (no bugs)…");
    },
    mosh: (ctx, args) => {
      expectNoArgs("mosh", args);
      ctx.out("  🤘 mosh()    → opening the pit");
    },
    notify: async (ctx, args) => {
      const msg = args.length ? args.join(" ") : "moshcode ping 🤘";
      ctx.out(`  🔔 notify()  → ${msg}`);
      if (ctx.dryRun) return;
      const res = await deliver("moshscript.notify", { message: msg, iter: ctx.iter });
      for (const r of res) if (!r.ok) ctx.out(`     ! notify ${r.target} failed (${r.status || r.error})`);
    },
    repeat: (ctx, args) => {
      expectNoArgs("repeat", args);
      ctx.out("  ↻  repeat()  → back to the top");
    },
    // handy extras
    say: (ctx, args) => ctx.out(`  💬 ${args.join(" ")}`),
    sleep: async (_ctx, args) => {
      const ms = Number(args[0] || 0);
      if (ms > 0) await new Promise((r) => setTimeout(r, ms));
    },
    stop: (ctx, args) => {
      expectNoArgs("stop", args);
      ctx.vars.alive = false;
      ctx.out("  ⏹  stop()    → alive = false");
    },
  };
}
