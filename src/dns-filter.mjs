/**
 * Blocklist filtering for the Moshpit bridge.
 *
 * With catch-all routing on, the bridge already sees every lookup this machine
 * makes — that is what makes Moshpit names resolve at all. Filtering is the
 * other thing a resolver in that position can do: refuse the names that exist
 * only to track, mine, phish or advertise, before the connection is ever made.
 *
 * The policy lives here rather than in `dns.mjs` for two reasons. `dns.mjs` is a
 * vendored copy of `@moshcoder/moshpit-dns` and every line added to it is a line
 * to port by hand at the next sync; and the decision "is this name blocked" is
 * pure — a name, some sets, an answer — which is worth being able to test
 * without a socket.
 *
 * Three things this deliberately does not do:
 *
 *   - It never turns DNS routing on. `moshcode dns filter on` writes a file and
 *     nothing else; a machine with no bridge in its query path is unaffected by
 *     it. Enabling the bridge stays something a human types.
 *   - It never fetches a list on its own. Lists are downloaded by
 *     `dns filter update` and read from a cache after that, so a resolver in the
 *     hot path of every lookup on the machine never waits on the network to
 *     decide, and an offline box keeps answering exactly as it did.
 *   - An allow entry always beats a block entry. A blocklist someone else
 *     maintains will eventually take down something you need, and the fix has to
 *     be one command that cannot be undone by the next `update`.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export const FILTER_VERSION = 1;

/**
 * The lists on offer, all public and all fetched by URL at `update` time.
 *
 * `format` is how the file is written, not what it contains: `hosts` is the
 * `0.0.0.0 name` shape, `domains` is one name per line. Both are parsed by
 * `parseList`, which is lenient enough that the distinction is documentation —
 * it matters when reading a source, not when reading a cache.
 */
export const FILTER_CATALOG = [
  {
    id: "ads",
    title: "Ads and trackers",
    format: "hosts",
    url: "https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts",
    note: "StevenBlack unified — the baseline nearly every blocker starts from",
  },
  {
    id: "malware",
    title: "Malware distribution",
    format: "hosts",
    url: "https://urlhaus.abuse.ch/downloads/hostfile/",
    note: "URLhaus, abuse.ch — hosts serving malware payloads right now",
  },
  {
    id: "phishing",
    title: "Phishing",
    format: "domains",
    url: "https://phishing.army/download/phishing_army_blocklist_extended.txt",
    note: "Phishing Army, extended",
  },
  {
    id: "mining",
    title: "Cryptomining",
    format: "hosts",
    url: "https://raw.githubusercontent.com/hoshsadiq/adblock-nocoin-list/master/hosts.txt",
    note: "in-browser miners",
  },
  {
    id: "adult",
    title: "Adult content",
    format: "hosts",
    url: "https://raw.githubusercontent.com/StevenBlack/hosts/master/extensions/porn/clefspeare13/hosts",
    note: "off by default",
  },
  {
    id: "gambling",
    title: "Gambling",
    format: "hosts",
    url: "https://raw.githubusercontent.com/StevenBlack/hosts/master/extensions/gambling/sinfonietta/hosts",
    note: "off by default",
  },
  {
    id: "social",
    title: "Social networks",
    format: "hosts",
    url: "https://raw.githubusercontent.com/StevenBlack/hosts/master/extensions/social/sinfonietta/hosts",
    note: "off by default — blocks the sites themselves, not just their trackers",
  },
  {
    id: "fakenews",
    title: "Fake news",
    format: "hosts",
    url: "https://raw.githubusercontent.com/StevenBlack/hosts/master/extensions/fakenews/hosts",
    note: "off by default",
  },
];

export const CATALOG_BY_ID = new Map(FILTER_CATALOG.map((entry) => [entry.id, entry]));

/**
 * What `filter on` turns on when told nothing else: the four categories that
 * block things nobody asks for. Everything that blocks content a person might
 * actually want — adult, gambling, social, fakenews — is opt-in by name.
 */
export const DEFAULT_CATEGORIES = ["ads", "malware", "phishing", "mining"];

/**
 * How a blocked name is answered.
 *
 *   nxdomain  the name does not exist. Fastest failure in a browser, and the
 *             one that caches; the default for that reason.
 *   zero      0.0.0.0 / :: — an address that goes nowhere. Slower to fail, but
 *             it keeps the name existing, which some captive software insists
 *             on before it will show its own error rather than hang.
 *   refuse    REFUSED. Honest — "I will not answer this" — and the only mode a
 *             client can tell apart from a real absence, so it is the one to
 *             use while working out whether the filter is what broke something.
 */
export const BLOCK_MODES = ["nxdomain", "zero", "refuse"];
export const DEFAULT_MODE = "nxdomain";

/** Where the config, the cached lists and the counters live. */
export function filterDir(env = process.env, home = os.homedir()) {
  return env.MOSHCODE_DNS_FILTER_DIR || path.join(home, ".moshcode", "dns-filter");
}

export const configPath = (dir) => path.join(dir, "filter.json");
export const listPath = (dir, id) => path.join(dir, "lists", `${id}.txt`);
export const statsPath = (dir) => path.join(dir, "stats.json");

/**
 * A name as this module compares them: lowercase, no trailing dot, no leading
 * dot, and nothing that is not a name at all. Every entry in every set goes
 * through here too, so a list written with mixed case or absolute names matches
 * a query written the other way.
 */
export function normaliseName(name) {
  const clean = String(name ?? "").trim().toLowerCase().replace(/\.+$/, "").replace(/^\.+/, "");
  if (!clean || clean.length > 253) return null;
  if (!/^[a-z0-9_*](?:[a-z0-9_*.-]*[a-z0-9_*])?$/.test(clean)) return null;
  return clean;
}

// The left-hand column of a hosts file: where the list points a name it is
// killing. These are not names to block — blocking 0.0.0.0 is meaningless and
// blocking 127.0.0.1 would be a bad afternoon.
const SINKHOLES = new Set([
  "0.0.0.0", "127.0.0.1", "255.255.255.255", "::", "::1", "ff00::0", "ff02::1", "ff02::2", "ff02::3",
  "fe80::1%lo0", "0000:0000:0000:0000:0000:0000:0000:0000",
]);

// Names a hosts file always carries and that must never end up in a blocklist:
// they are the machine describing itself to itself.
const NEVER_BLOCK = new Set([
  "localhost", "localhost.localdomain", "local", "broadcasthost",
  "ip6-localhost", "ip6-loopback", "ip6-localnet", "ip6-mcastprefix",
  "ip6-allnodes", "ip6-allrouters", "ip6-allhosts",
]);

/**
 * Read a blocklist in any of the shapes these sources ship in.
 *
 * Hosts lines (`0.0.0.0 a.example b.example`), plain one-name-per-line lists,
 * and the `||name^` form an adblock-syntax list uses — the last only because it
 * costs one regex and turns a whole class of source from "unparseable" into
 * "works", not because anything in the catalogue needs it.
 *
 * Anything else on a line is dropped rather than guessed at. A blocklist parser
 * that improvises produces a resolver that blocks something nobody can explain.
 */
export function parseList(text) {
  const out = [];
  const seen = new Set();
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.split("#")[0].split("!")[0].trim();
    if (!line) continue;

    const fields = line.split(/\s+/);
    let candidates;
    if (fields.length > 1) {
      // A hosts line is only a hosts line if the first field is a sinkhole. A
      // two-field line that starts with a real address is somebody's actual
      // /etc/hosts entry and none of our business.
      if (!SINKHOLES.has(fields[0].toLowerCase())) continue;
      candidates = fields.slice(1);
    } else {
      const adblock = fields[0].match(/^\|\|([^/^$]+)\^?$/);
      candidates = [adblock ? adblock[1] : fields[0]];
    }

    for (const candidate of candidates) {
      const name = normaliseName(candidate);
      // A blocklist entry must have a dot. Without this rule one malformed line
      // reading `com` blocks the internet, and the failure looks like the
      // network being down rather than like a bad list.
      if (!name || !name.includes(".") || name.includes("*")) continue;
      if (NEVER_BLOCK.has(name) || SINKHOLES.has(name)) continue;
      if (seen.has(name)) continue;
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/**
 * Does `name`, or any parent of it, appear in `set`?
 *
 * Blocking a name blocks everything under it — a list naming `doubleclick.net`
 * means the tracker at `stats.g.doubleclick.net` too, and every list in the
 * catalogue is written on that assumption. Returns the entry that matched, so
 * the answer to "why was this blocked" is a rule someone can look up rather
 * than a boolean.
 *
 * The walk includes the bare rightmost label. No fetched list can contain one
 * (`parseList` requires a dot), so this only ever fires for something typed by
 * hand — which is how `filter block eggs` takes out a whole Moshpit ending.
 */
export function matchSuffix(name, set) {
  const clean = normaliseName(name);
  if (!clean || !set || set.size === 0) return null;
  const labels = clean.split(".");
  for (let i = 0; i < labels.length; i++) {
    const candidate = labels.slice(i).join(".");
    if (set.has(candidate)) return candidate;
  }
  return null;
}

const toSet = (names) => {
  const set = new Set();
  for (const name of names || []) {
    const clean = normaliseName(name);
    if (clean) set.add(clean);
  }
  return set;
};

/**
 * The decision half, with no filesystem under it.
 *
 * `lists` is a Map of category id to a Set of names, iterated in order so the
 * category reported for a name that several lists carry is stable rather than
 * whichever one happened to be built first.
 */
export function createFilter({
  enabled = true,
  mode = DEFAULT_MODE,
  lists = new Map(),
  allow = [],
  block = [],
} = {}) {
  const allowSet = toSet(allow);
  const blockSet = toSet(block);
  const counters = { queries: 0, blocked: 0, byList: Object.create(null), recent: [] };

  const decide = (name) => {
    counters.queries += 1;
    if (!enabled) return null;
    const clean = normaliseName(name);
    if (!clean) return null;

    // Allow first, and unconditionally. This is the escape hatch for a list
    // that took down something real, so nothing below may override it.
    if (matchSuffix(clean, allowSet)) return null;

    let hit = null;
    const custom = matchSuffix(clean, blockSet);
    if (custom) hit = { list: "custom", rule: custom };
    else {
      for (const [id, set] of lists) {
        const rule = matchSuffix(clean, set);
        if (rule) { hit = { list: id, rule }; break; }
      }
    }
    if (!hit) return null;

    counters.blocked += 1;
    counters.byList[hit.list] = (counters.byList[hit.list] || 0) + 1;
    // A short tail, not a log. Enough to answer "what did it just block" in
    // `filter status`; not enough to become a record of everything a person
    // looked up, which is not a thing a resolver should keep by default.
    counters.recent.unshift({ name: clean, ...hit });
    if (counters.recent.length > 20) counters.recent.pop();
    return { ...hit, mode };
  };

  return {
    enabled,
    mode,
    decide,
    counters,
    stats: () => ({
      queries: counters.queries,
      blocked: counters.blocked,
      byList: { ...counters.byList },
      recent: counters.recent.slice(),
    }),
    sizes: () => {
      const out = {};
      for (const [id, set] of lists) out[id] = set.size;
      if (blockSet.size) out.custom = blockSet.size;
      return out;
    },
  };
}

/** The shape written to `filter.json`, with every field defaulted. */
export function normaliseConfig(raw = {}) {
  const categories = Array.isArray(raw.categories)
    ? raw.categories.filter((id) => CATALOG_BY_ID.has(id))
    : DEFAULT_CATEGORIES.slice();
  return {
    version: FILTER_VERSION,
    enabled: Boolean(raw.enabled),
    mode: BLOCK_MODES.includes(raw.mode) ? raw.mode : DEFAULT_MODE,
    categories,
    block: Array.from(toSet(raw.block)),
    allow: Array.from(toSet(raw.allow)),
    updatedAt: raw.updatedAt || null,
  };
}

export async function readConfig(dir) {
  try {
    return normaliseConfig(JSON.parse(await fs.readFile(configPath(dir), "utf8")));
  } catch (err) {
    // A missing file is the default answer — filtering off — not an error. A
    // corrupt one is reported, because silently reverting to "off" is how a
    // machine ends up unfiltered while its owner believes otherwise.
    if (err?.code === "ENOENT") return normaliseConfig({ enabled: false });
    throw new Error(`${configPath(dir)} is not readable as JSON — ${err?.message || err}`);
  }
}

export async function writeConfig(dir, config) {
  const next = normaliseConfig(config);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(configPath(dir), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

/** What is cached for a category, without loading the whole thing. */
export async function listStatus(dir, id) {
  try {
    const stat = await fs.stat(listPath(dir, id));
    return { id, cached: true, bytes: stat.size, at: stat.mtime.toISOString() };
  } catch {
    return { id, cached: false, bytes: 0, at: null };
  }
}

export async function readCachedList(dir, id) {
  try {
    const text = await fs.readFile(listPath(dir, id), "utf8");
    return toSet(text.split("\n"));
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Fetch one category and write it to the cache.
 *
 * The write goes to a temporary file and is renamed into place, so a bridge
 * reloading in the middle of an update reads either the old list or the new one
 * and never half of either.
 */
export async function updateList(dir, id, { fetchImpl = fetch, timeoutMs = 60000 } = {}) {
  const source = CATALOG_BY_ID.get(id);
  if (!source) throw new Error(`no such list: ${id}`);
  const response = await fetchImpl(source.url, { signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
  if (!response.ok) throw new Error(`${source.url} answered ${response.status}`);
  const names = parseList(await response.text());
  // A source that parses to nothing is a source that changed shape, moved, or
  // answered with an error page carrying a 200. Overwriting a good cache with
  // that would quietly unfilter the machine.
  if (!names.length) throw new Error(`${source.url} parsed to nothing — leaving the cached copy alone`);
  await fs.mkdir(path.dirname(listPath(dir, id)), { recursive: true });
  const temp = `${listPath(dir, id)}.tmp`;
  await fs.writeFile(temp, `${names.join("\n")}\n`);
  await fs.rename(temp, listPath(dir, id));
  return { id, count: names.length, url: source.url };
}

/**
 * Load config and cached lists into a live filter, and keep it current.
 *
 * The bridge is a long-lived process and the config is edited by a separate
 * command, so a handle re-reads when the config file's mtime moves. It checks at
 * most every `reloadMs`, off the back of a query rather than on a timer: a timer
 * in a resolver is a thing that keeps a process alive after its socket has
 * closed, and this way an idle bridge does no work at all.
 */
export async function openFilter({ dir = filterDir(), reloadMs = 5000, now = () => Date.now() } = {}) {
  let filter = createFilter({ enabled: false });
  let config = normaliseConfig({ enabled: false });
  let stamp = null;
  let checkedAt = now();
  let loading = null;
  // Both clocks start now rather than at zero, so opening a handle does not
  // write a stats file and re-read a config on its very first query. A process
  // that asks one question and exits should leave nothing behind.
  let flushedAt = now();
  let flushing = false;

  const configStamp = async () => {
    try {
      return (await fs.stat(configPath(dir))).mtimeMs;
    } catch {
      return null;
    }
  };

  const load = async () => {
    config = await readConfig(dir);
    const lists = new Map();
    for (const id of config.categories) {
      const set = await readCachedList(dir, id);
      if (set) lists.set(id, set);
    }
    const carried = filter.counters;
    filter = createFilter({
      enabled: config.enabled,
      mode: config.mode,
      lists,
      allow: config.allow,
      block: config.block,
    });
    // Counters survive a reload. They describe what this bridge has done since
    // it started, and losing them every time a name is allowlisted would make
    // the numbers meaningless exactly when someone is watching them.
    Object.assign(filter.counters, carried);
    stamp = await configStamp();
    return filter;
  };

  const refresh = () => {
    if (loading) return loading;
    loading = (async () => {
      try {
        if (await configStamp() !== stamp) await load();
      } catch {
        // Keep serving with what is already loaded. A resolver that stops
        // answering because a config file went strange is worse than one
        // running a slightly stale policy.
      } finally {
        loading = null;
      }
    })();
    return loading;
  };

  const flush = () => {
    if (flushing) return;
    flushing = true;
    const payload = { at: new Date(now()).toISOString(), ...filter.stats(), lists: filter.sizes() };
    fs.mkdir(dir, { recursive: true })
      .then(() => fs.writeFile(statsPath(dir), `${JSON.stringify(payload, null, 2)}\n`))
      .catch(() => {})
      .finally(() => { flushing = false; });
  };

  await load();

  return {
    get config() { return config; },
    get mode() { return filter.mode; },
    get enabled() { return filter.enabled; },
    reload: load,
    stats: () => filter.stats(),
    sizes: () => filter.sizes(),
    decide(name) {
      const at = now();
      if (at - checkedAt >= reloadMs) {
        checkedAt = at;
        refresh(); // deliberately not awaited — this query uses the loaded policy
      }
      const verdict = filter.decide(name);
      if (at - flushedAt >= 10000) {
        flushedAt = at;
        flush();
      }
      return verdict;
    },
  };
}

export async function readStats(dir) {
  try {
    return JSON.parse(await fs.readFile(statsPath(dir), "utf8"));
  } catch {
    return null;
  }
}
