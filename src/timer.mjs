// `/timer on` … `/timer off`. The whole feature, in two words.
//
// Deliberately its own thing. Time tracking is useful to somebody who bills
// nobody — a freelancer proving an estimate, an employee filling a timesheet,
// a person who just wants to know where Tuesday went — and coupling it to a
// payment gateway would mean nobody could use it until they had one. So the
// timer writes to a local ledger and knows nothing about money. `/billing`
// reads that ledger later and applies a rate to it; `/payments` is a third
// thing again. Each of the three is worth having without the other two.
//
// What the timer does know about is agents, because that is what makes this
// different from every other stopwatch. An hour of moshcode is not an hour of
// work — it is an hour times however many engines were running in it — and
// `--agents auto` reads that off the herd instead of asking you to remember.
import { loadBusiness, loadTimers, newId, saveTimers, updateTimers } from "./business-store.mjs";
import { clientLabel, parseFields, resolveClient } from "./clients.mjs";
import { chargeFor, describeRate, formatMoney, rateFor } from "./rates.mjs";
import { acid, amber, ash, bone, err, info, ok, table, warn } from "./ui.mjs";

/**
 * Parse "2h", "90m", "1h30m", "1:30", "45", "0.5h" into seconds.
 *
 * A bare number is minutes. That is the unit people say out loud when they are
 * logging time after the fact ("put 45 on that"), and hours are always written
 * with the h.
 */
export function parseDuration(text) {
  const raw = String(text ?? "").trim().toLowerCase();
  if (!raw) return null;
  const clock = raw.match(/^(\d+):([0-5]\d)$/);
  if (clock) return Number(clock[1]) * 3600 + Number(clock[2]) * 60;
  if (/^\d+(\.\d+)?$/.test(raw)) return Math.round(Number(raw) * 60);
  const parts = raw.match(/(\d+(?:\.\d+)?)\s*([hms])/g);
  if (!parts) return null;
  const scale = { h: 3600, m: 60, s: 1 };
  let total = 0;
  for (const part of parts) {
    const [, n, unit] = part.match(/(\d+(?:\.\d+)?)\s*([hms])/);
    total += Number(n) * scale[unit];
  }
  return Math.round(total);
}

/** "2h 15m", "45m", "12s" — the shortest thing that is still exact enough. */
export function humanDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  if (total < 60) return `${total}s`;
  const h = Math.floor(total / 3600);
  const m = Math.round((total % 3600) / 60);
  if (!h) return `${m}m`;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** Local date, as YYYY-MM-DD — the grouping every timesheet uses. */
export function dayOf(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * How many engines are running right now, for `--agents auto`.
 *
 * Imported lazily and wrapped: the timer must work on a box with no herd, no
 * state directory and no sessions, and a stopwatch that throws because the
 * roster could not be read would be a worse tool than one that says 1.
 */
export async function countRunningAgents() {
  try {
    const { roster } = await import("./herd-cli.mjs");
    const live = roster().filter((r) => r.kind !== "remote" && !["done", "exited", "dead"].includes(String(r.state || "").toLowerCase()));
    return Math.max(1, live.length);
  } catch {
    return 1;
  }
}

/** Seconds an open timer has run for. */
export function elapsed(active, now = Date.now()) {
  const started = new Date(active?.startedAt ?? 0).getTime();
  if (!Number.isFinite(started) || !started) return 0;
  return Math.max(0, Math.round((now - started) / 1000));
}

const USAGE = [
  "usage: /timer on [client] [--task \"…\"] [--agents N|auto] [--note …]",
  "       /timer off [--note …] · /timer status · /timer switch <client>",
  "       /timer log [--client <id>] [--today|--week|--since <date>] [--unbilled] [--json]",
  "       /timer add <client> <2h30m> [--task …] [--agents N] · /timer rm <id>",
];

export async function timerCommand(argv = [], { write = console.log, countAgents = countRunningAgents, now = () => Date.now() } = {}) {
  const verb = String(argv[0] ?? "status").toLowerCase();
  const args = argv.slice(1);

  if (["on", "start", "begin", "go"].includes(verb)) return startTimer(args, write, countAgents, now);
  if (["off", "stop", "end", "done"].includes(verb)) return stopTimer(args, write, now);
  if (["switch", "swap"].includes(verb)) return switchTimer(args, write, countAgents, now);
  if (["status", "", "show"].includes(verb)) return timerStatus(argv.includes("--json"), write, now);
  if (["log", "list", "ls", "entries"].includes(verb)) return timerLog(args, write, now);
  if (verb === "add") return addEntry(args, write, now);
  if (["rm", "remove", "delete"].includes(verb)) return removeEntry(args, write);

  write(err(`unknown /timer verb ${JSON.stringify(verb)} — it is on, off, status, log, add or rm`));
  USAGE.forEach(write);
  return 1;
}

async function startTimer(args, write, countAgents, now) {
  const { fields, rest } = parseFields(args);
  const state = loadTimers();
  if (state.active) {
    // Refuse rather than stack. Two open timers is not a state anyone means to
    // be in, and silently closing the first would rewrite history nobody asked
    // to have rewritten.
    write(err(`already running for ${bone(state.active.client || "no client")} — ${humanDuration(elapsed(state.active, now()))} so far`));
    write(`  ${acid("/timer off")} ${ash("to close it, or")} ${acid("/timer switch <client>")} ${ash("to do both at once")}`);
    return 1;
  }

  const business = loadBusiness();
  const token = rest[0] || fields.client;
  let clientId = null;
  if (token && token !== true) {
    const found = resolveClient(business, token);
    if (!found.ok) {
      if (found.reason === "ambiguous") { write(err(`${JSON.stringify(token)} matches ${found.matches.join(", ")} — say which`)); return 1; }
      // An unknown client is a typo far more often than a new client, and the
      // fix is one command away. Starting a timer against a name that does not
      // exist is how time ends up on an invoice nobody can send.
      write(err(`no client ${JSON.stringify(token)} — ${acid(`/client create ${token}`)} first, or ${acid("/timer on")} with no client`));
      return 1;
    }
    clientId = found.id;
  }

  const agents = fields.agents === "auto" || fields.agents === true
    ? await countAgents()
    : Math.max(1, Number(fields.agents) || 1);

  const active = {
    id: newId("t", now()),
    client: clientId,
    task: fields.task && fields.task !== true ? String(fields.task) : (rest.slice(1).join(" ") || null),
    agents,
    note: fields.note && fields.note !== true ? String(fields.note) : null,
    startedAt: new Date(now()).toISOString(),
  };
  updateTimers((data) => { data.active = active; });

  const who = clientId ? clientLabel(clientId, business.clients[clientId]) : ash("no client");
  write(ok(`timer on — ${who}${active.task ? ` ${ash("·")} ${active.task}` : ""}`));
  const rate = rateFor(business, clientId);
  if (rate) write(`  ${ash(describeRate(rate))}${agents > 1 ? ash(` · ${agents} agents`) : ""}`);
  else if (agents > 1) write(`  ${ash(`${agents} agents`)}`);
  return 0;
}

function stopTimer(args, write, now) {
  const { fields } = parseFields(args);
  const state = loadTimers();
  if (!state.active) {
    write(info("no timer running."));
    write(`  ${acid("/timer on <client>")}`);
    return 1;
  }
  const seconds = elapsed(state.active, now());
  const entry = {
    ...state.active,
    endedAt: new Date(now()).toISOString(),
    seconds,
    billed: false,
    invoice: null,
    note: fields.note && fields.note !== true ? String(fields.note) : state.active.note,
  };
  saveTimers({ ...state, active: null, entries: [...state.entries, entry] });

  const business = loadBusiness();
  const who = entry.client ? clientLabel(entry.client, business.clients[entry.client]) : ash("no client");
  write(ok(`timer off — ${bone(humanDuration(seconds))} on ${who}${entry.task ? ` ${ash("·")} ${entry.task}` : ""}`));

  const rate = rateFor(business, entry.client);
  const charge = chargeFor(entry, rate);
  if (charge?.amount != null) {
    const capped = rate.cap && entry.agents > rate.cap;
    write(`  ${acid(formatMoney(charge.amount, charge.currency))} ${ash(`at ${describeRate(rate)}`)}`);
    if (capped) write(`  ${ash(`${entry.agents} agents ran; billed ${rate.cap} — the cap you promised them`)}`);
  } else if (charge?.flat) {
    write(`  ${ash("flat project fee — /billing adds it once, not per entry")}`);
  } else if (!rate) {
    write(`  ${ash("no rate for this one —")} ${acid(`/rate set ${entry.client || "default"} $100/hour/agent`)}`);
  }
  write(`  ${ash(`entry ${entry.id}`)}`);
  return 0;
}

async function switchTimer(args, write, countAgents, now) {
  const state = loadTimers();
  if (state.active) {
    const code = stopTimer([], write, now);
    if (code) return code;
  }
  return startTimer(args, write, countAgents, now);
}

function timerStatus(json, write, now) {
  const state = loadTimers();
  const business = loadBusiness();
  if (json) {
    write(JSON.stringify({
      active: state.active ? { ...state.active, seconds: elapsed(state.active, now()) } : null,
      entries: state.entries.length,
    }, null, 2));
    return 0;
  }
  if (!state.active) {
    const today = state.entries.filter((e) => dayOf(e.endedAt) === dayOf(new Date(now()).toISOString()));
    const seconds = today.reduce((sum, e) => sum + (e.seconds || 0), 0);
    write(info(seconds ? `no timer running — ${humanDuration(seconds)} logged today` : "no timer running."));
    write(`  ${acid("/timer on <client>")}`);
    return 0;
  }
  const seconds = elapsed(state.active, now());
  const who = state.active.client ? clientLabel(state.active.client, business.clients[state.active.client]) : ash("no client");
  write(`  ${amber("●")} ${bone(humanDuration(seconds))} ${ash("on")} ${who}${state.active.task ? ` ${ash("·")} ${state.active.task}` : ""}`);
  const rate = rateFor(business, state.active.client);
  const charge = chargeFor({ seconds, agents: state.active.agents }, rate);
  if (charge?.amount != null) write(`  ${acid(formatMoney(charge.amount, charge.currency))} ${ash(`so far · ${describeRate(rate)}`)}`);
  return 0;
}

/**
 * Which entries a filter selects, oldest first.
 *
 * Exported because `/billing` selects the same way, and two filters that drift
 * apart would mean the invoice and the timesheet behind it disagree.
 */
export function selectEntries(entries, { client = null, since = null, until = null, unbilled = false } = {}) {
  const from = since ? new Date(since).getTime() : null;
  const to = until ? new Date(until).getTime() : null;
  return entries
    .filter((e) => (client ? e.client === client : true))
    .filter((e) => (unbilled ? !e.billed : true))
    .filter((e) => {
      if (from == null && to == null) return true;
      const at = new Date(e.endedAt || e.startedAt).getTime();
      if (from != null && at < from) return false;
      if (to != null && at > to) return false;
      return true;
    })
    .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
}

/** `--today`, `--week`, `--month`, `--since <date>` → an ISO lower bound. */
export function windowFrom(fields, now = Date.now()) {
  if (fields.since && fields.since !== true) return new Date(fields.since).toISOString();
  const d = new Date(now);
  if (fields.today) return new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString();
  if (fields.week) return new Date(now - 7 * 86400_000).toISOString();
  if (fields.month) return new Date(d.getFullYear(), d.getMonth(), 1).toISOString();
  return null;
}

function timerLog(args, write, now) {
  const { fields } = parseFields(args);
  const state = loadTimers();
  const business = loadBusiness();
  let clientId = null;
  if (fields.client && fields.client !== true) {
    const found = resolveClient(business, fields.client);
    if (!found.ok) { write(err(`no client ${JSON.stringify(fields.client)}`)); return 1; }
    clientId = found.id;
  }
  const rows = selectEntries(state.entries, {
    client: clientId,
    since: windowFrom(fields, now()),
    unbilled: Boolean(fields.unbilled),
  });
  if (fields.json) { write(JSON.stringify(rows, null, 2)); return 0; }
  if (!rows.length) { write(info("nothing tracked in that window.")); return 0; }

  const limit = Number(fields.limit) > 0 ? Number(fields.limit) : 50;
  const shown = rows.slice(-limit);
  write(table(
    shown.map((e) => [
      ash(e.id),
      ash(dayOf(e.startedAt)),
      bone(e.client || "—"),
      humanDuration(e.seconds),
      e.agents > 1 ? `${e.agents}×` : "",
      e.task || ash(e.note || ""),
      e.billed ? acid("billed") : "",
    ]),
    { columns: ["id", "day", "client", "time", "agents", "what", ""], indent: 2 },
  ));
  const seconds = rows.reduce((sum, e) => sum + (e.seconds || 0), 0);
  write(`  ${ash("total")} ${bone(humanDuration(seconds))} ${ash(`over ${rows.length} ${rows.length === 1 ? "entry" : "entries"}`)}`);
  if (shown.length < rows.length) write(`  ${ash(`showing the last ${shown.length} — --limit ${rows.length} for all of them`)}`);
  return 0;
}

function addEntry(args, write, now) {
  const { fields, rest } = parseFields(args);
  const business = loadBusiness();
  // `/timer add 2h` with no client is a legitimate thing to want, so the client
  // is whichever word is not a duration.
  const durationToken = rest.find((word) => parseDuration(word) != null);
  const clientToken = rest.find((word) => word !== durationToken);
  const seconds = parseDuration(durationToken);
  if (!seconds) { write(err("how long? /timer add acme 2h30m")); return 1; }

  let clientId = null;
  if (clientToken) {
    const found = resolveClient(business, clientToken);
    if (!found.ok) { write(err(`no client ${JSON.stringify(clientToken)} — ${acid(`/client create ${clientToken}`)}`)); return 1; }
    clientId = found.id;
  }
  const endedAt = fields.at && fields.at !== true ? new Date(fields.at) : new Date(now());
  if (Number.isNaN(endedAt.getTime())) { write(err(`can't read ${JSON.stringify(fields.at)} as a date`)); return 1; }

  const entry = {
    id: newId("t", now()),
    client: clientId,
    task: fields.task && fields.task !== true ? String(fields.task) : null,
    agents: Math.max(1, Number(fields.agents) || 1),
    note: fields.note && fields.note !== true ? String(fields.note) : null,
    startedAt: new Date(endedAt.getTime() - seconds * 1000).toISOString(),
    endedAt: endedAt.toISOString(),
    seconds,
    billed: false,
    invoice: null,
    manual: true,
  };
  updateTimers((data) => { data.entries.push(entry); });
  write(ok(`logged ${bone(humanDuration(seconds))} on ${entry.client ? bone(entry.client) : ash("no client")} ${ash(`(${entry.id})`)}`));
  return 0;
}

function removeEntry(args, write) {
  const id = String(args[0] ?? "").trim();
  if (!id) { write(err("usage: /timer rm <id>")); return 1; }
  const removed = updateTimers((data) => {
    const index = data.entries.findIndex((e) => e.id === id);
    if (index === -1) return null;
    const [entry] = data.entries.splice(index, 1);
    return entry;
  });
  if (!removed) { write(err(`no entry ${JSON.stringify(id)} — ${acid("/timer log")}`)); return 1; }
  if (removed.billed) write(warn(`that one was already billed (invoice ${removed.invoice || "?"}) — the invoice still says it happened`));
  write(ok(`dropped ${ash(id)} ${ash(`(${humanDuration(removed.seconds)})`)}`));
  return 0;
}

export { USAGE as TIMER_USAGE };
