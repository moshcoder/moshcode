// `moshcode cost` — what the herd is spending, right now.
//
// The roster answers "which agent is blocked". This answers the other question
// you have at 2am with six agents running: "what is this costing me". Same
// shape as `moshcode ps` on purpose — one row per session, one line of totals —
// because it is the same list of sessions seen through a different column.
//
// Everything it prints comes from the engines' own session logs (src/cost.mjs).
// Nothing is sampled, nothing is proxied, and a number the engine itself
// computed is never overwritten by our arithmetic.
import {
  DEFAULT_WINDOW_MS, UNCOSTED_ENGINES, attributeRuns, engineRuns,
  formatTokens, formatUsd, totals,
} from "./cost.mjs";
import { pricingFile } from "./cost-pricing.mjs";
import { EXIT, humanAge, roster } from "./herd-cli.mjs";
import { acid, ash, bone, dim, err, info, table, warn } from "./ui.mjs";

const tilde = (p) => {
  const home = process.env.HOME || "";
  return home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
};

/** "30m", "6h", "3d", "90s" — the same vocabulary `moshcode wait --timeout` takes. */
export function parseWindow(raw, fallback = DEFAULT_WINDOW_MS) {
  const m = /^(\d+(?:\.\d+)?)\s*([smhd])?$/.exec(String(raw ?? "").trim());
  if (!m) return fallback;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n * { s: 1e3, m: 60e3, h: 3600e3, d: 86400e3 }[m[2] || "h"];
}

function flagValue(argv, name) {
  const i = argv.indexOf(name);
  if (i === -1) return null;
  const next = argv[i + 1];
  return next && !next.startsWith("-") ? next : null;
}

/**
 * How confident the dollar figure is, in one character.
 *
 * `~` means we multiplied tokens by a published rate card; no marker means the
 * engine handed us the price. On a subscription the estimate is what the same
 * work would cost on the API — worth watching, not worth invoicing.
 */
function costCell(cost, source) {
  if (cost == null) return ash("—");
  const text = formatUsd(cost);
  if (source === "engine") return bone(text);
  return `${bone(text)}${dim("~")}`;
}

/**
 * Cache tokens get their own column rather than folding into `in`.
 *
 * On a long agent session they are most of the traffic and a tenth of the price
 * — a single "in" number that mixes them makes a $3 session look like a $60
 * one, and hides the thing you would actually act on.
 */
const cacheTokens = (u) => u.cacheRead + u.cacheWrite5m + u.cacheWrite1h;

/** The per-session table, shared by the one-shot report and `--watch`. */
export function renderCost(rows, { indent = "  " } = {}) {
  if (!rows.length) return "";
  return table(
    rows.map((r) => [
      bone(r.name),
      ash(String(r.engine)),
      ash(r.models?.length ? r.models.join(",") : "—"),
      dim(formatTokens(r.usage.input)),
      dim(formatTokens(r.usage.output)),
      dim(formatTokens(cacheTokens(r.usage))),
      costCell(r.cost, r.costSource),
      dim(humanAge(r.age)),
    ]),
    { columns: ["session", "engine", "model", "in", "out", "cache", "cost", "age"], header: true, indent: indent.length },
  );
}

/** The `--all` table: engine sessions as the engines recorded them. */
function renderRuns(runs, { indent = "  " } = {}) {
  if (!runs.length) return "";
  return table(
    runs.map((r) => [
      bone(String(r.id).slice(0, 8)),
      ash(r.engine),
      ash(r.models?.length ? r.models.join(",") : "—"),
      ash(tilde(r.cwd || "")),
      dim(formatTokens(r.usage.input)),
      dim(formatTokens(r.usage.output)),
      dim(formatTokens(cacheTokens(r.usage))),
      costCell(r.cost, r.costSource),
    ]),
    { columns: ["run", "engine", "model", "cwd", "in", "out", "cache", "cost"], header: true, indent: indent.length },
  );
}

/**
 * Gather everything once: the roster, the engine runs in the window, and the
 * attribution between them. Returned whole so `--json`, the table, and the
 * herd bar all read the same numbers.
 */
export async function costReport({ since, cwd = null, engines = null } = {}) {
  const sessions = roster();
  const runs = await engineRuns({ since, cwd, engines });
  const { rows, unattributed } = attributeRuns(sessions, runs);
  return { sessions, runs, rows, unattributed, since };
}

/**
 * The total is the total of the table above it, and anything the table left out
 * is its own line. A single grand total over rows that are not all shown reads
 * as "your herd cost $850" when the herd cost nothing and another terminal did.
 */
function footer(report, write, { attribution = true } = {}) {
  const shown = totals(report.rows);
  const loose = totals(report.unattributed);
  const all = totals([...report.rows, ...report.unattributed]);

  write("");
  write(`  ${bone("total")}  ${costCell(shown.cost, "rates")}  ${dim(`${formatTokens(shown.usage.input)} in · ${formatTokens(shown.usage.output)} out · ${formatTokens(cacheTokens(shown.usage))} cached`)}`);
  if (attribution && report.unattributed.length) {
    write(info(`plus ${formatUsd(loose.cost)} in ${report.unattributed.length} engine session(s) outside the herd — ${acid("moshcode cost --all")} shows them.`));
  }
  if (shown.cost != null || loose.cost != null) {
    write(dim(`  ~ estimated from published rates; unmarked figures are the engine's own.`));
  }
  if (all.unpriced.length) {
    write(warn(`no rate for ${all.unpriced.join(", ")} — tokens counted, cost omitted.`));
    write(info(`price them in ${tilde(pricingFile())}: { "${all.unpriced[0]}": { "input": 1.25, "output": 10 } }`));
  }
}

/**
 * `moshcode cost [name] [--all] [--since 6h] [--engine <name>] [--json] [--watch [secs]]`
 */
export async function costCommand(argv = [], { write = console.log } = {}) {
  const asJson = argv.includes("--json");
  const all = argv.includes("--all");
  const since = Date.now() - parseWindow(flagValue(argv, "--since"));
  const engineFlag = flagValue(argv, "--engine");
  const engines = engineFlag ? engineFlag.split(",").map((s) => s.trim()).filter(Boolean) : null;
  const watch = argv.includes("--watch");
  const flagWords = new Set([flagValue(argv, "--since"), flagValue(argv, "--engine"), flagValue(argv, "--watch")]);
  const name = argv.find((a) => !a.startsWith("-") && !flagWords.has(a)) || null;

  if (watch && asJson) {
    write(err("--watch and --json do not go together — pipe repeated `moshcode cost --json` instead."));
    return EXIT.usage;
  }

  const once = async () => {
    const report = await costReport({ since, engines });
    let rows = report.rows;
    if (name) {
      rows = rows.filter((r) => r.name === name);
      if (!rows.length) {
        write(err(`no session named ${JSON.stringify(name)} — ${acid("moshcode ps")}`));
        return EXIT.gone;
      }
    }

    if (asJson) {
      write(JSON.stringify({
        since,
        sessions: rows.map(({ name: n, engine, cwd, state, models, usage, cost, costSource, unpriced, runs }) => ({
          name: n, engine, cwd, state, models, usage, cost, costSource, unpriced,
          runs: runs.map((r) => ({ id: r.id, model: r.model, usage: r.usage, cost: r.cost, costSource: r.costSource, start: r.start, end: r.end })),
        })),
        unattributed: report.unattributed.map((r) => ({
          id: r.id, engine: r.engine, cwd: r.cwd, model: r.model, usage: r.usage, cost: r.cost, costSource: r.costSource, start: r.start, end: r.end,
        })),
        totals: totals([...rows, ...report.unattributed]),
      }, null, 2));
      return EXIT.matched;
    }

    if (all) {
      const runs = name ? rows.flatMap((r) => r.runs) : report.runs;
      if (!runs.length) {
        write(info("no engine sessions on disk in this window — widen it with `--since 7d`."));
        return EXIT.matched;
      }
      write(renderRuns(runs));
      // The runs ARE the rows here, so they are what the total totals. And the
      // "not tied to a herd session" note would be describing the whole table
      // back at itself, so it stays off.
      footer({ ...report, rows: runs, unattributed: [] }, write, { attribution: false });
      return EXIT.matched;
    }

    if (!rows.length) {
      write(info("the herd is empty — `moshcode herd start claude` puts something in it."));
      write(info(`already ran an agent outside the herd? ${acid("moshcode cost --all")}`));
      return EXIT.matched;
    }

    write(renderCost(rows));
    footer({ ...report, rows }, write);
    if (UNCOSTED_ENGINES.some((e) => rows.some((r) => r.engine === e))) {
      write(info(`${UNCOSTED_ENGINES.join(", ")} keep no usage log moshcode can read — those rows show no cost, not zero cost.`));
    }
    return EXIT.matched;
  };

  if (!watch) return once();

  // --watch is the "ongoing" part: the same report, re-read on an interval,
  // because the interesting thing about a running agent's cost is the slope.
  const every = Math.max(2, Number(flagValue(argv, "--watch") || 10)) * 1000;
  let stop = false;
  const onSigint = () => { stop = true; };
  process.on("SIGINT", onSigint);
  try {
    while (!stop) {
      if (process.stdout.isTTY) process.stdout.write("\x1b[2J\x1b[H");
      await once();
      write(dim(`  refreshing every ${Math.round(every / 1000)}s · ctrl-c to stop`));
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, every);
        // A timer must not hold the process open past a ctrl-c.
        timer.unref?.();
        const poll = setInterval(() => { if (stop) { clearTimeout(timer); clearInterval(poll); resolve(); } }, 100);
        poll.unref?.();
      });
    }
  } finally {
    process.off("SIGINT", onSigint);
  }
  return EXIT.matched;
}
