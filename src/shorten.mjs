// `/shorten <url>` — mint a short link on the pit, and get `/f/<code>` back.
//
// The pit hands out long URLs constantly: a session mirror, an approval, a
// name's site, a release asset. The place they get pasted is a terminal, a chat
// line, a slide or a QR code, where a 140-character URL wraps and breaks in
// half. So this asks the registry for a short one and prints it.
//
// Everything here is one HTTP call to pit.moshcode.sh — the registry owns the
// codes, because a short link that only worked from the laptop that minted it
// would not be a link at all. The command is thin on purpose: parse, call,
// print, and be honest about what came back.
//
// Authenticated, always. An anonymous shortener is an open redirector with a
// database, which is the thing phishing kits are built out of; the account is
// what makes a link revocable and its owner findable.

import { loadCreds } from "./auth.mjs";
import { acid, ash, bone, err, info, ok } from "./ui.mjs";

/** Where the codes live. The registry, not the app — see the note above. */
export const DEFAULT_REGISTRY_BASE = "https://pit.moshcode.sh";

function registryBase(env = process.env) {
  return String(env.MOSHPIT_REGISTRY || env.MOSHCODE_PIT || DEFAULT_REGISTRY_BASE).replace(/\/+$/, "");
}

/** The token `moshcode login` wrote, or one set in the environment. */
export function apiToken(env = process.env, creds = loadCreds) {
  return env.MOSHCODE_API_KEY || creds()?.token || "";
}

/**
 * Split `/shorten` into what it was asked to do.
 *
 * A bare URL is the whole point of the command, so it needs no verb: `/shorten
 * https://…` shortens, and only `list` and `rm` are spelled out. Flags are
 * pulled out first so `--name` can sit anywhere, which is where people put it.
 *
 * @param {string[]} argv
 */
export function parseArgs(argv = []) {
  const args = (Array.isArray(argv) ? argv : []).map(String);
  const json = args.includes("--json");
  let name = null;
  const positional = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--json") continue;
    if (arg === "--name" || arg === "-n") { name = args[i + 1] ?? null; i += 1; continue; }
    if (arg.startsWith("--name=")) { name = arg.slice("--name=".length); continue; }
    positional.push(arg);
  }

  const first = (positional[0] || "").toLowerCase();
  if (!positional.length) return { verb: "help", json, name };
  if (first === "list" || first === "ls") return { verb: "list", json, name };
  if (first === "rm" || first === "delete" || first === "del") {
    return { verb: "rm", code: positional[1] || "", json, name };
  }
  // Anything else is the URL. Deliberately not validated here: the registry has
  // the one implementation of what may be shortened (lib/moshpit-links.mjs),
  // and a second, looser copy in the client is how the two drift apart.
  return { verb: "shorten", url: positional[0], json, name };
}

/**
 * One authenticated call to the registry, with the failures a person can act on.
 *
 * Every non-2xx is turned into `{ ok: false, error }` rather than thrown: this
 * runs at a prompt someone is sitting in front of, and a stack trace over a
 * 401 tells them nothing about the `moshcode login` that fixes it.
 */
async function call(path, { method = "GET", body = null, token, base, fetchImpl = fetch } = {}) {
  if (!token) {
    return { ok: false, needsAuth: true, error: "not logged in — run `/login` first" };
  }
  let response;
  try {
    response = await fetchImpl(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch (error) {
    return { ok: false, error: `${base} unreachable: ${error.message}` };
  }

  let payload = null;
  try { payload = await response.json(); } catch { payload = null; }

  if (response.status === 401) {
    return { ok: false, needsAuth: true, error: "the registry rejected the credentials — run `/login`" };
  }
  if (!response.ok) {
    return { ok: false, error: payload?.error || `the registry said ${response.status}` };
  }
  return { ok: true, status: response.status, body: payload ?? {} };
}

/** Mint one. Returns the link the registry stored, existing or new. */
export async function shorten(url, {
  name = null, env = process.env, token = apiToken(env), fetchImpl = fetch,
} = {}) {
  return call("/api/moshpit/links", {
    method: "POST",
    body: { url, ...(name ? { name } : {}) },
    token,
    base: registryBase(env),
    fetchImpl,
  });
}

/** What this account has minted. */
export async function listLinks({ env = process.env, token = apiToken(env), fetchImpl = fetch } = {}) {
  return call("/api/moshpit/links", { token, base: registryBase(env), fetchImpl });
}

/** Take one down. */
export async function removeLink(code, { env = process.env, token = apiToken(env), fetchImpl = fetch } = {}) {
  return call(`/api/moshpit/links/${encodeURIComponent(code)}`, {
    method: "DELETE", token, base: registryBase(env), fetchImpl,
  });
}

/**
 * How to run this, spelled the way the caller reached it.
 *
 * The pit writes its verbs with a slash and the CLI does not, and printing the
 * wrong one is a usage line that does not work when pasted back — `/games` does
 * the same thing for the same reason.
 */
function usage(out, prefix) {
  const lines = [
    ["<url>", "mint a short link — /f/<code> on the pit"],
    ["<url> --name <name>", "file it under a moshpit name you hold"],
    ["list", "every link you have minted, newest first"],
    ["rm <code>", "take one down"],
  ].map(([args, text]) => [`${prefix} ${args}`, text]);
  // The column is measured rather than fixed: `moshcode shorten` is twice as
  // wide as `/shorten`, and a hardcoded one leaves the longest line unaligned
  // in whichever spelling was not the one it was chosen for.
  const width = Math.max(...lines.map(([invocation]) => invocation.length)) + 2;

  out(info("usage:"));
  for (const [invocation, text] of lines) {
    out(`  ${acid(invocation)}${ash(" ".repeat(width - invocation.length) + text)}`);
  }
}

/**
 * `/shorten` in the pit, and `moshcode shorten` on the command line.
 *
 * @param {string[]} argv
 * @param {{out?: (s: string) => void, err?: (s: string) => void, env?: object,
 *          token?: string, prefix?: string, fetchImpl?: typeof fetch}} [io]
 * @returns {Promise<number>} exit code
 */
export async function shortenCommand(argv = [], io = {}) {
  const out = io.out || ((s) => console.log(s));
  const say = io.err || ((s) => console.error(s));
  const env = io.env || process.env;
  const token = io.token ?? apiToken(env);
  const prefix = io.prefix || "/shorten";
  const fetchImpl = io.fetchImpl || fetch;
  const parsed = parseArgs(argv);

  if (parsed.verb === "help") {
    usage(out, prefix);
    return 1;
  }

  if (parsed.verb === "list") {
    const result = await listLinks({ env, token, fetchImpl });
    if (!result.ok) { say(err(result.error)); return 1; }
    const links = result.body.links || [];
    if (parsed.json) { out(JSON.stringify(links, null, 2)); return 0; }
    if (!links.length) {
      out(info(`no short links yet — ${prefix} <url> mints one`));
      return 0;
    }
    for (const link of links) {
      const hits = `${link.hits} hit${link.hits === 1 ? "" : "s"}`;
      out(`  ${acid(link.short)}  ${ash("→")} ${bone(link.url)}`);
      out(`    ${ash(`${hits}${link.name ? ` · ${link.name}` : ""}`)}`);
    }
    return 0;
  }

  if (parsed.verb === "rm") {
    if (!parsed.code) { say(err(`usage: ${prefix} rm <code>`)); return 1; }
    const result = await removeLink(parsed.code, { env, token, fetchImpl });
    if (!result.ok) { say(err(result.error)); return 1; }
    if (parsed.json) { out(JSON.stringify(result.body, null, 2)); return 0; }
    out(ok(`took down /f/${result.body.code ?? parsed.code}`));
    return 0;
  }

  const result = await shorten(parsed.url, { name: parsed.name, env, token, fetchImpl });
  if (!result.ok) { say(err(result.error)); return 1; }
  if (parsed.json) { out(JSON.stringify(result.body, null, 2)); return 0; }

  // Say when a code came back rather than being made. Shortening is idempotent
  // per account, and someone who ran it twice should see why the code is the
  // one they already have instead of wondering whether the second call worked.
  out(ok(`${acid(result.body.short)}  ${ash("→")} ${bone(result.body.url)}`));
  if (result.body.created === false) out(info("already shortened — same code as last time"));
  return 0;
}
