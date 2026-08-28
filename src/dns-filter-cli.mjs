/**
 * `moshcode dns filter` — the verb over the policy in `dns-filter.mjs`.
 *
 * Kept out of `dns.mjs` for the same reason the policy is: that file is vendored
 * from `@moshcoder/moshpit-dns` and is ported by hand, so it gets the hook and
 * nothing else.
 *
 * The thing this command has to be honest about, in every subcommand that could
 * mislead, is that a filter only filters what passes through the bridge. Writing
 * `enabled: true` into a file on a machine whose resolver has never heard of the
 * bridge changes nothing at all, and a status line that says `on` without saying
 * that is the same lie as `bridge started` being printed by a run that never
 * wrote the routing.
 */

import {
  BLOCK_MODES,
  CATALOG_BY_ID,
  DEFAULT_CATEGORIES,
  DEFAULT_MODE,
  FILTER_CATALOG,
  configPath,
  filterDir,
  listPath,
  listStatus,
  matchSuffix,
  normaliseName,
  readCachedList,
  readConfig,
  readStats,
  updateList,
  writeConfig,
} from "./dns-filter.mjs";
import { DEFAULT_HOST, DEFAULT_PORT, bridgePresence, describeBridge, parseDnsPort } from "./dns.mjs";
import { daemonStatus } from "./dns-system.mjs";

const USAGE = `moshcode dns filter — block names before they are ever looked up

  moshcode dns filter                  what is on, what it has blocked
  moshcode dns filter on               start filtering (${DEFAULT_CATEGORIES.join(", ")})
  moshcode dns filter off              stop filtering; keeps the lists and the rules
  moshcode dns filter lists            the catalogue, and what is cached here
  moshcode dns filter add <list>...    turn a category on
  moshcode dns filter remove <list>... turn one off
  moshcode dns filter update [<list>]  fetch the lists — nothing downloads on its own
  moshcode dns filter block <name>...  always block this name and everything under it
  moshcode dns filter allow <name>...  never block it, whatever any list says
  moshcode dns filter unblock <name>...
  moshcode dns filter unallow <name>...
  moshcode dns filter test <name>      would this be blocked, and by which rule

  --mode nxdomain|zero|refuse   how a blocked name is answered (default ${DEFAULT_MODE})
  --lists a,b                   with \`on\`: the categories to run, instead of the default
  --json                        with status, lists or test: one document for scripts

Filtering happens in the bridge, so it applies to exactly the queries the bridge
sees: with \`dns enable\` on, that is every lookup this machine makes. Changes are
picked up by a running bridge within about five seconds — no restart, no reload.
This command never turns DNS routing on.`;

const flagValue = (args, name) => {
  const index = args.indexOf(name);
  if (index >= 0 && args[index + 1]) return args[index + 1];
  const inline = args.find((a) => a.startsWith(`${name}=`));
  return inline ? inline.slice(name.length + 1) : null;
};

const positional = (args) => {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--mode" || arg === "--lists" || arg === "--port") { i += 1; continue; }
    if (arg.startsWith("-")) continue;
    out.push(arg);
  }
  return out;
};

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Is there a bridge that could be applying this policy?
 *
 * Probed rather than read from the pidfile. A bridge started by systemd, by
 * hand, or by an escalated `dns enable` leaves no pidfile this process can see,
 * and reporting "no bridge" for a machine that is filtering every lookup would
 * send someone to fix the wrong thing.
 */
async function bridgeLine({ host, port, presence = bridgePresence, recorded = daemonStatus }) {
  try {
    const found = await presence({ host, port, recorded: await recorded().catch(() => undefined) });
    return { found, text: describeBridge(found, { host, port }) };
  } catch {
    return { found: { kind: "unknown", answering: false }, text: "could not be determined" };
  }
}

export async function filterCommand(args = [], out = console.log, deps = {}) {
  const {
    dir = filterDir(),
    fetchImpl = fetch,
    presence = bridgePresence,
    recorded = daemonStatus,
    now = () => new Date(),
  } = deps;

  const sub = positional(args)[0] || "status";
  const rest = positional(args).slice(1);
  const json = args.includes("--json");
  const host = DEFAULT_HOST;
  const port = parseDnsPort(flagValue(args, "--port")) || DEFAULT_PORT;

  if (sub === "help" || args.includes("--help") || args.includes("-h")) {
    out(USAGE);
    return 0;
  }

  let config;
  try {
    config = await readConfig(dir);
  } catch (err) {
    out(`! ${err.message}`);
    out(`  fix or remove ${configPath(dir)} — filtering is off until it parses`);
    return 1;
  }

  /* ------------------------------------------------------------------ lists */

  if (sub === "lists") {
    const rows = [];
    for (const entry of FILTER_CATALOG) {
      const cached = await listStatus(dir, entry.id);
      rows.push({ ...entry, ...cached, on: config.categories.includes(entry.id) });
    }
    if (json) {
      out(JSON.stringify({ dir, categories: config.categories, lists: rows }, null, 2));
      return 0;
    }
    for (const row of rows) {
      const state = row.on ? "on " : "off";
      const cache = row.cached
        ? `cached ${row.bytes < 1024 ? "<1" : Math.round(row.bytes / 1024)}k, ${row.at.slice(0, 10)}`
        : "not fetched";
      out(`  ${state}  ${row.id.padEnd(9)} ${row.title.padEnd(22)} ${cache}`);
      out(`       ${row.note}`);
    }
    out("");
    out("fetch what is on with: moshcode dns filter update");
    return 0;
  }

  /* ------------------------------------------------------------------- test */

  if (sub === "test") {
    const name = rest[0];
    if (!name) {
      out("usage: moshcode dns filter test <name>");
      return 1;
    }
    const clean = normaliseName(name);
    if (!clean) {
      out(`! ${name} is not a name this can match`);
      return 1;
    }
    // Read straight from the cache rather than through a filter handle: this
    // has to answer for a category that is cached but switched off, so that
    // "why is this not blocked" has an answer other than silence.
    const allowed = matchSuffix(clean, new Set(config.allow));
    const blockedBy = matchSuffix(clean, new Set(config.block));
    const hits = [];
    if (blockedBy) hits.push({ list: "custom", rule: blockedBy, on: true });
    for (const entry of FILTER_CATALOG) {
      const set = await readCachedList(dir, entry.id);
      if (!set) continue;
      const rule = matchSuffix(clean, set);
      if (rule) hits.push({ list: entry.id, rule, on: config.categories.includes(entry.id) });
    }
    const live = hits.filter((h) => h.on);
    const blocked = config.enabled && !allowed && live.length > 0;

    if (json) {
      out(JSON.stringify({ name: clean, blocked, mode: config.mode, allowed, hits }, null, 2));
      return 0;
    }
    if (!config.enabled) out("filtering is off — this is what would happen with it on");
    if (allowed) {
      out(`${clean} — allowed by your rule \`${allowed}\``);
      if (hits.length) out(`  (${plural(hits.length, "list")} would otherwise block it: ${hits.map((h) => h.list).join(", ")})`);
      return 0;
    }
    if (!live.length) {
      out(`${clean} — not blocked`);
      const dormant = hits.filter((h) => !h.on);
      if (dormant.length) {
        out(`  it is in ${dormant.map((h) => h.list).join(", ")}, which ${dormant.length === 1 ? "is" : "are"} not switched on`);
        out(`  turn one on with: moshcode dns filter add ${dormant[0].list}`);
      }
      return 0;
    }
    out(`${clean} — blocked by ${live[0].list} (rule \`${live[0].rule}\`), answered as ${config.mode}`);
    if (live.length > 1) out(`  also in: ${live.slice(1).map((h) => h.list).join(", ")}`);
    out(`  keep it working with: moshcode dns filter allow ${clean}`);
    return 0;
  }

  /* ----------------------------------------------------------------- update */

  if (sub === "update") {
    const wanted = rest.length ? rest : config.categories;
    if (!wanted.length) {
      out("no categories are on — nothing to fetch");
      out(`  turn one on with: moshcode dns filter add ${DEFAULT_CATEGORIES[0]}`);
      return 1;
    }
    const unknown = wanted.filter((id) => !CATALOG_BY_ID.has(id));
    if (unknown.length) {
      out(`! no such list: ${unknown.join(", ")}`);
      out(`  the catalogue is: ${FILTER_CATALOG.map((e) => e.id).join(", ")}`);
      return 1;
    }
    let failed = 0;
    for (const id of wanted) {
      try {
        const result = await updateList(dir, id, { fetchImpl });
        out(`ok ${id.padEnd(9)} ${result.count.toLocaleString()} names`);
      } catch (err) {
        failed += 1;
        // Named and survived rather than thrown: one dead source should not
        // stop the other seven from refreshing.
        out(`!  ${id.padEnd(9)} ${err?.message || err}`);
      }
    }
    await writeConfig(dir, { ...config, updatedAt: now().toISOString() });
    if (failed) out(`\n${plural(failed, "list")} did not refresh — the cached copy is still in use`);
    if (config.enabled) out("\na running bridge picks these up within about five seconds");
    else out("\nfiltering is off — turn it on with: moshcode dns filter on");
    return failed === wanted.length ? 1 : 0;
  }

  /* --------------------------------------------------------------- on / off */

  if (sub === "on" || sub === "off") {
    const mode = flagValue(args, "--mode");
    if (mode && !BLOCK_MODES.includes(mode)) {
      out(`! --mode must be one of: ${BLOCK_MODES.join(", ")}`);
      return 1;
    }
    const chosen = flagValue(args, "--lists");
    const categories = chosen
      ? chosen.split(",").map((s) => s.trim()).filter(Boolean)
      : (config.categories.length ? config.categories : DEFAULT_CATEGORIES.slice());
    const unknown = categories.filter((id) => !CATALOG_BY_ID.has(id));
    if (unknown.length) {
      out(`! no such list: ${unknown.join(", ")}`);
      out(`  the catalogue is: ${FILTER_CATALOG.map((e) => e.id).join(", ")}`);
      return 1;
    }
    const next = await writeConfig(dir, {
      ...config,
      enabled: sub === "on",
      mode: mode || config.mode,
      categories,
    });
    if (sub === "off") {
      out("filtering off — lists and rules kept, nothing is being blocked");
      return 0;
    }

    const missing = [];
    for (const id of next.categories) {
      if (!(await listStatus(dir, id)).cached) missing.push(id);
    }
    out(`filtering on — ${next.categories.join(", ")}, blocked names answered as ${next.mode}`);
    if (missing.length) {
      // The state that would otherwise read as success and block nothing.
      out(`! ${plural(missing.length, "list")} ${missing.length === 1 ? "has" : "have"} never been fetched: ${missing.join(", ")}`);
      out("  nothing is blocked from them until you run: moshcode dns filter update");
    }
    const bridge = await bridgeLine({ host, port, presence, recorded });
    if (!bridge.found.answering) {
      out(`! no bridge is answering on ${host}:${port} — ${bridge.text}`);
      out("  the filter runs inside the bridge, so nothing is filtered until one does.");
      out("  turn DNS on deliberately with: sudo moshcode dns enable");
    } else if (bridge.found.forwards === false) {
      out(`! the bridge on ${host}:${port} answers Moshpit names but does not forward clearnet ones`);
      out("  it is not in the path of ordinary lookups, so only Moshpit names are filtered");
    }
    return 0;
  }

  /* ------------------------------------------------------ categories, rules */

  const listVerbs = { add: true, remove: true };
  if (listVerbs[sub]) {
    if (!rest.length) {
      out(`usage: moshcode dns filter ${sub} <list>...`);
      return 1;
    }
    const unknown = rest.filter((id) => !CATALOG_BY_ID.has(id));
    if (unknown.length) {
      out(`! no such list: ${unknown.join(", ")}`);
      out(`  the catalogue is: ${FILTER_CATALOG.map((e) => e.id).join(", ")}`);
      return 1;
    }
    const set = new Set(config.categories);
    for (const id of rest) (sub === "add" ? set.add(id) : set.delete(id));
    const next = await writeConfig(dir, { ...config, categories: Array.from(set) });
    out(next.categories.length ? `lists: ${next.categories.join(", ")}` : "lists: none");
    if (sub === "add") {
      const missing = [];
      for (const id of rest) if (!(await listStatus(dir, id)).cached) missing.push(id);
      if (missing.length) out(`  fetch ${missing.join(", ")} with: moshcode dns filter update ${missing.join(" ")}`);
    }
    return 0;
  }

  const ruleVerbs = {
    block: { field: "block", add: true, said: "blocked" },
    allow: { field: "allow", add: true, said: "allowed" },
    unblock: { field: "block", add: false, said: "no longer blocked by rule" },
    unallow: { field: "allow", add: false, said: "no longer allowed by rule" },
  };
  if (ruleVerbs[sub]) {
    const { field, add, said } = ruleVerbs[sub];
    if (!rest.length) {
      out(`usage: moshcode dns filter ${sub} <name>...`);
      return 1;
    }
    const names = [];
    for (const raw of rest) {
      const clean = normaliseName(raw);
      if (!clean) {
        out(`! ${raw} is not a name`);
        return 1;
      }
      names.push(clean);
    }
    const set = new Set(config[field]);
    for (const name of names) (add ? set.add(name) : set.delete(name));
    const next = await writeConfig(dir, { ...config, [field]: Array.from(set) });
    out(`${names.join(", ")} — ${said}${add ? ", along with everything under it" : ""}`);
    out(`  ${plural(next[field].length, "rule")} in your ${field} list`);
    if (!next.enabled) out("  filtering is off, so this takes effect when you turn it on");
    return 0;
  }

  /* ----------------------------------------------------------------- status */

  if (sub !== "status") {
    out(`unknown: moshcode dns filter ${sub}`);
    out(USAGE);
    return 1;
  }

  const stats = await readStats(dir);
  const cached = [];
  for (const id of config.categories) cached.push(await listStatus(dir, id));
  const bridge = await bridgeLine({ host, port, presence, recorded });

  if (json) {
    out(JSON.stringify({
      dir,
      enabled: config.enabled,
      mode: config.mode,
      categories: config.categories,
      block: config.block,
      allow: config.allow,
      lists: cached,
      bridge: { kind: bridge.found.kind, answering: Boolean(bridge.found.answering), forwards: Boolean(bridge.found.forwards) },
      stats,
    }, null, 2));
    return 0;
  }

  out(`filter    ${config.enabled ? `on — answering blocked names as ${config.mode}` : "off"}`);
  out(`bridge    ${bridge.text}`);
  out(`lists     ${config.categories.length ? config.categories.join(", ") : "none"}`);
  const never = cached.filter((c) => !c.cached);
  if (never.length) out(`          ! never fetched: ${never.map((c) => c.id).join(", ")} — run \`moshcode dns filter update\``);
  if (config.block.length || config.allow.length) {
    out(`rules     ${plural(config.block.length, "block")}, ${plural(config.allow.length, "allow")}`);
  }
  if (stats) {
    const share = stats.queries ? `${((stats.blocked / stats.queries) * 100).toFixed(1)}%` : "0%";
    out(`blocked   ${stats.blocked.toLocaleString()} of ${stats.queries.toLocaleString()} queries (${share}) as of ${String(stats.at).slice(0, 19).replace("T", " ")}`);
    for (const [id, count] of Object.entries(stats.byList || {}).sort((a, b) => b[1] - a[1])) {
      out(`          ${String(count).padStart(7)}  ${id}`);
    }
    if (stats.recent?.length) {
      out("recent    " + stats.recent.slice(0, 5).map((r) => r.name).join(", "));
    }
  } else if (config.enabled) {
    // The counters are written by the bridge, so their absence is a fact about
    // the bridge rather than about the filter.
    out("blocked   no counts yet — the bridge writes them once it is answering");
  }

  if (config.enabled && !bridge.found.answering) {
    out("");
    out(`! nothing is being filtered: the filter runs inside the bridge and none is answering on ${host}:${port}`);
    out("  turn DNS on deliberately with: sudo moshcode dns enable");
  }
  out("");
  out(`config    ${configPath(dir)}`);
  out(`lists at  ${listPath(dir, "<list>")}`);
  return 0;
}
