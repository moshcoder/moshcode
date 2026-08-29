// Who is allowed to do what, on a box you handed to somebody else.
//
// A devops shop runs moshcode on machines its own people and its clients sit
// at. "Preshy can use the CoinPay tool, the client can read invoices and
// nothing else" is a real sentence somebody needs to be able to write down, and
// until now the only place to write it was a wiki nobody reads.
//
// A permission is `surface:target` — `tools:coinpay`, `agents:*`,
// `billing:read`. Grants are additive and wildcards widen: `*` is everything,
// `tools:*` is every tool, and a bare `tools` means the same as `tools:*`
// because that is what somebody means when they type it.
//
// What this is NOT: security. moshcode runs as the person at the keyboard, with
// their files and their shell, and anyone who can type `/team` can also type
// `vim ~/.moshcode/business.json`. This is a guardrail — it stops the wrong
// command being run by accident and makes the intended split explicit and
// reviewable. A boundary that has to *hold* against someone is an OS account,
// a container, or a scoped credential, and this file will not pretend otherwise.
import { loadBusiness, slugify, updateBusiness } from "./business-store.mjs";
import { parseFields } from "./clients.mjs";
import { formatRate, parseRate } from "./rates.mjs";
import { acid, ash, bone, err, info, ok, table, warn } from "./ui.mjs";

/**
 * What each role can do before anybody grants it anything.
 *
 * Roles exist so the common case is one word instead of six permissions. They
 * are a starting set, not a ceiling: `/team grant` adds to whatever the role
 * already carries, and nothing here can be taken away except by changing the
 * role.
 */
export const ROLES = {
  owner: ["*"],
  admin: ["agents:*", "tools:*", "timer:*", "client:*", "rate:*", "billing:*", "team:read", "payments:read"],
  member: ["agents:*", "timer:*", "client:read", "rate:read", "billing:read"],
  // The client is on the outside of the relationship looking in: they can see
  // what they are being billed and the time behind it, and touch nothing.
  client: ["billing:read", "timer:read", "client:read"],
};

export const DEFAULT_ROLE = "member";

/** Surfaces a permission can name. Used to spot a typo'd grant at write time. */
export const SURFACES = ["agents", "tools", "timer", "client", "team", "rate", "billing", "payments", "herd", "shell", "*"];

/**
 * Normalise the several ways people write a permission down.
 *
 * `tools:coinpay`, `tools/coinpay` and `allow(tools/coinpay)` are the same
 * grant. The bracket form is how it gets said in conversation ("allow them
 * plugins/tools"), and a command that only accepts the canonical spelling
 * makes somebody translate their own sentence before they can use it.
 */
export function normalizePermission(raw) {
  let text = String(raw ?? "").trim().toLowerCase();
  const call = text.match(/^(?:allow|grant|deny)\(([^)]*)\)$/);
  if (call) text = call[1].trim();
  text = text.replace(/[/\s]+/g, ":").replace(/:+/g, ":").replace(/^:|:$/g, "");
  if (!text) return null;
  const [surface, ...rest] = text.split(":");
  const target = rest.join(":") || "*";
  return `${surface}:${target}`;
}

/** Does this grant list allow `permission`? */
export function can(grants, permission) {
  const want = normalizePermission(permission);
  if (!want) return false;
  const [surface, target] = want.split(":");
  return (grants || []).some((raw) => {
    const grant = normalizePermission(raw);
    if (!grant) return false;
    const [gSurface, gTarget] = grant.split(":");
    if (gSurface !== "*" && gSurface !== surface) return false;
    if (gTarget === "*" || gTarget === target) return true;
    // `billing:*` covers `billing:read`; `billing:read` does not cover
    // `billing:write`. Read is not a prefix of write on purpose.
    return false;
  });
}

/** Everything a member may do: their role's defaults plus their own grants. */
export function grantsFor(member) {
  const role = ROLES[member?.role] || ROLES[DEFAULT_ROLE];
  return [...new Set([...role, ...(member?.grants || [])])];
}

/**
 * The permission a pit line needs, or null when it needs none.
 *
 * Only the surfaces worth gating are listed. `/help`, `/pwd` and the arcade are
 * not access control problems, and pretending they are would make the gate
 * something people turn off.
 */
export function permissionFor(cmd, rest = []) {
  const verb = String(cmd || "").toLowerCase();
  const arg = String(rest[0] || "").toLowerCase();
  const map = {
    tools: () => `tools:${arg || "*"}`,
    agents: () => `agents:${arg || "*"}`,
    agent: () => `agents:${arg || "*"}`,
    start: () => `agents:${arg || "*"}`,
    herd: () => "herd:*",
    shell: () => "shell:*",
    sh: () => "shell:*",
    install: () => `tools:${arg || "*"}`,
    client: () => (isReadVerb(arg) ? "client:read" : "client:write"),
    business: () => (isReadVerb(arg) ? "client:read" : "client:write"),
    merchant: () => (isReadVerb(arg) ? "client:read" : "client:write"),
    customer: () => (isReadVerb(arg) ? "client:read" : "client:write"),
    team: () => (isReadVerb(arg) ? "team:read" : "team:write"),
    teams: () => (isReadVerb(arg) ? "team:read" : "team:write"),
    rate: () => (isReadVerb(arg) ? "rate:read" : "rate:write"),
    rates: () => (isReadVerb(arg) ? "rate:read" : "rate:write"),
    billing: () => (isBillingWrite(rest) ? "billing:write" : "billing:read"),
    invoice: () => (isBillingWrite(rest) ? "billing:write" : "billing:read"),
    payments: () => (isReadVerb(arg) ? "payments:read" : "payments:write"),
    timer: () => (["log", "status", "ls", "list", ""].includes(arg) ? "timer:read" : "timer:write"),
  };
  return map[verb] ? map[verb]() : null;
}

function isReadVerb(arg) {
  return ["", "list", "ls", "show", "get", "info", "can", "whoami", "status"].includes(arg);
}

function isBillingWrite(rest) {
  // Drafting an invoice reads; marking time billed or sending it to a gateway
  // writes. The flags are the difference, not the verb.
  return rest.some((a) => ["--mark", "--send", "--void"].includes(String(a).toLowerCase()))
    || ["mark", "send", "void"].includes(String(rest[0] || "").toLowerCase());
}

/**
 * Who this pit is acting as: `MOSHCODE_MEMBER=acme/preshy`, or nobody.
 *
 * Env rather than a stored setting, deliberately. The owner's own pit has no
 * member set and is never gated; a machine handed to somebody else gets the
 * variable in its profile, which is a place an operator already knows how to
 * manage and a place the person at the keyboard can be seen to have changed.
 */
export function currentMember(business = loadBusiness(), env = process.env) {
  const raw = String(env.MOSHCODE_MEMBER || "").trim();
  if (!raw) return null;
  const [teamPart, handlePart] = raw.includes("/") ? raw.split("/") : [null, raw];
  const teams = business.teams || {};
  const teamId = teamPart ? slugify(teamPart) : Object.keys(teams).find((id) => teams[id]?.members?.[handlePart]);
  const team = teamId ? teams[teamId] : null;
  const member = team?.members?.[String(handlePart || "").toLowerCase()];
  if (!team || !member) return { teamId: teamId || teamPart, handle: handlePart, member: null, grants: [], unknown: true };
  return { teamId, team, handle: String(handlePart).toLowerCase(), member, grants: grantsFor(member) };
}

/**
 * The gate the pit calls before dispatching: `{ allowed, permission, reason }`.
 *
 * Allowed by default. No member set means the owner is at the keyboard, and an
 * unrecognised command needs no permission — a gate that fails closed on
 * everything it does not know about would break every command added after it.
 */
export function checkAccess(cmd, rest = [], { business = loadBusiness(), env = process.env } = {}) {
  const permission = permissionFor(cmd, rest);
  if (!permission) return { allowed: true, permission: null };
  const acting = currentMember(business, env);
  if (!acting) return { allowed: true, permission };
  if (acting.unknown) {
    return {
      allowed: false,
      permission,
      acting,
      reason: `MOSHCODE_MEMBER is set to ${env.MOSHCODE_MEMBER}, and no team here has that member`,
    };
  }
  if (can(acting.grants, permission)) return { allowed: true, permission, acting };
  return {
    allowed: false,
    permission,
    acting,
    reason: `${acting.handle} (${acting.member.role || DEFAULT_ROLE} on ${acting.teamId}) has no ${permission}`,
  };
}

const USAGE = [
  "usage: /team create <name> [--client <id>]",
  "       /team add <team> <handle> [--role owner|admin|member|client] [--email …] [--rate $80/hour]",
  "       /team grant <team> <handle> <permission…>  ·  /team revoke <team> <handle> <permission…>",
  "       /team [list] · /team show <team> · /team can <team>/<handle> <permission> · /team whoami",
  "  permissions: surface:target — tools:coinpay, agents:*, billing:read, timer:write",
];

export function teamCommand(argv = [], { write = console.log, env = process.env } = {}) {
  const verb = String(argv[0] ?? "list").toLowerCase();
  const args = argv.slice(1);

  if (["create", "new"].includes(verb)) return createTeam(args, write);
  if (["add", "invite", "hire"].includes(verb)) return addMember(args, write);
  if (["grant", "allow"].includes(verb)) return changeGrants(args, write, "grant");
  if (["revoke", "deny"].includes(verb)) return changeGrants(args, write, "revoke");
  if (["rm", "remove", "delete", "fire"].includes(verb)) return removeFromTeam(args, write);
  if (["show", "info"].includes(verb)) return showTeam(args, write);
  if (verb === "can") return checkCan(args, write);
  if (verb === "whoami") return whoAmI(write, env);
  if (["list", "ls"].includes(verb)) return listTeams(argv.includes("--json"), write);

  const found = resolveTeam(loadBusiness(), verb);
  if (found.ok) return showTeam([verb], write);

  write(err(`unknown /team verb ${JSON.stringify(verb)}`));
  USAGE.forEach(write);
  return 1;
}

/** Find a team by id, name, or unambiguous prefix — same contract as clients. */
export function resolveTeam(business, token) {
  const teams = business?.teams || {};
  const want = String(token ?? "").trim().toLowerCase();
  if (!want) {
    const ids = Object.keys(teams);
    // One team is the overwhelmingly common shape, and making somebody name it
    // every time is ceremony for its own sake.
    if (ids.length === 1) return { ok: true, id: ids[0], team: teams[ids[0]], inferred: true };
    return { ok: false, reason: "no team named", matches: ids };
  }
  if (Object.hasOwn(teams, want)) return { ok: true, id: want, team: teams[want] };
  const slug = slugify(want);
  if (Object.hasOwn(teams, slug)) return { ok: true, id: slug, team: teams[slug] };
  const matches = Object.entries(teams).filter(([id, t]) =>
    id.startsWith(slug) || String(t.name || "").toLowerCase().includes(want));
  if (matches.length === 1) return { ok: true, id: matches[0][0], team: matches[0][1] };
  return { ok: false, reason: matches.length ? "ambiguous" : "unknown", matches: matches.map(([id]) => id) };
}

function createTeam(args, write) {
  const { fields, rest } = parseFields(args);
  const name = fields.name || rest.join(" ").trim();
  if (!name) { write(err("a team needs a name")); USAGE.forEach(write); return 1; }
  const id = String(fields.id || slugify(name));
  const business = loadBusiness();
  if (business.teams[id]) { write(err(`${bone(id)} already exists`)); return 1; }
  const team = {
    id,
    name,
    clients: fields.client ? [String(fields.client).toLowerCase()] : [],
    members: {},
    createdAt: new Date().toISOString(),
  };
  updateBusiness((data) => { data.teams[id] = team; });
  write(ok(`team ${bone(id)} — ${name}`));
  write(`  ${acid(`/team add ${id} <handle> --role member`)} ${ash("to put somebody on it")}`);
  return 0;
}

function addMember(args, write) {
  const { fields, rest } = parseFields(args);
  const business = loadBusiness();
  // `/team add preshy` with one team means that team; with two it must be said.
  const teamToken = rest.length > 1 ? rest[0] : null;
  const handleToken = rest.length > 1 ? rest[1] : rest[0];
  const found = resolveTeam(business, teamToken);
  if (!found.ok) return reportTeamMiss(found, teamToken, write);
  const handle = slugify(handleToken || fields.handle || "");
  if (!handle) { write(err("who? /team add <team> <handle>")); return 1; }
  if (found.team.members?.[handle]) { write(err(`${bone(handle)} is already on ${bone(found.id)}`)); return 1; }

  const role = String(fields.role || DEFAULT_ROLE).toLowerCase();
  if (!ROLES[role]) { write(err(`unknown role ${JSON.stringify(role)} — one of ${Object.keys(ROLES).join(", ")}`)); return 1; }

  let rate;
  if (fields.rate && fields.rate !== true) {
    try { rate = parseRate(fields.rate); }
    catch (e) { write(err(String(e.message || e))); return 1; }
  }

  const grants = [];
  for (const raw of String(fields.grant || "").split(",")) {
    const permission = normalizePermission(raw);
    if (permission) grants.push(permission);
  }

  const member = {
    handle,
    name: fields.name && fields.name !== true ? fields.name : handleToken,
    email: fields.email && fields.email !== true ? fields.email : undefined,
    role,
    grants,
    rate,
    addedAt: new Date().toISOString(),
  };
  updateBusiness((data) => {
    data.teams[found.id].members ||= {};
    data.teams[found.id].members[handle] = member;
  });
  write(ok(`${bone(handle)} joined ${bone(found.id)} as ${acid(role)}`));
  write(`  ${ash("can:")} ${grantsFor(member).join(" ")}`);
  if (rate) write(`  ${ash("rate:")} ${acid(formatRate(rate))}`);
  return 0;
}

function changeGrants(args, write, mode) {
  const business = loadBusiness();
  const words = args.filter((a) => !a.startsWith("--"));
  if (!words.length) { write(err(`usage: /team ${mode} <team> <handle> <permission…>`)); return 1; }

  // The team may be named or inferred, so work out which word is the handle by
  // asking the team that answers: a permission always contains a separator, a
  // handle does not.
  const permissionsStart = words.findIndex((w) => /[:/(]/.test(w));
  const head = permissionsStart === -1 ? words : words.slice(0, permissionsStart);
  const rawPermissions = permissionsStart === -1 ? [] : words.slice(permissionsStart);
  if (!rawPermissions.length) { write(err(`nothing to ${mode} — permissions look like tools:coinpay or agents:*`)); return 1; }

  const found = resolveTeam(business, head.length > 1 ? head[0] : null);
  if (!found.ok) return reportTeamMiss(found, head[0], write);
  const handle = slugify(head.length > 1 ? head[1] : head[0]);
  const member = found.team.members?.[handle];
  if (!member) { write(err(`no ${JSON.stringify(handle)} on ${bone(found.id)} — ${acid(`/team show ${found.id}`)}`)); return 1; }

  const permissions = [];
  for (const raw of rawPermissions) {
    const permission = normalizePermission(raw);
    if (!permission) { write(err(`can't read ${JSON.stringify(raw)} as a permission`)); return 1; }
    permissions.push(permission);
    const surface = permission.split(":")[0];
    if (!SURFACES.includes(surface)) {
      write(warn(`${bone(surface)} is not a surface moshcode gates — known: ${SURFACES.join(", ")}`));
    }
  }

  const after = updateBusiness((data) => {
    const record = data.teams[found.id].members[handle];
    const set = new Set(record.grants || []);
    for (const permission of permissions) {
      if (mode === "grant") set.add(permission);
      else set.delete(permission);
    }
    record.grants = [...set].sort();
    return record;
  });
  write(ok(`${bone(handle)} ${mode === "grant" ? "+" : "−"} ${acid(permissions.join(" "))}`));
  write(`  ${ash("can now:")} ${grantsFor(after).join(" ")}`);
  if (mode === "revoke" && permissions.some((p) => can(ROLES[after.role] || [], p))) {
    // Revoking something the role hands back is a no-op, and silently doing
    // nothing is the worst possible answer to "take that away from them".
    write(warn(`their role (${after.role}) still grants it — change the role to actually remove it`));
  }
  return 0;
}

function removeFromTeam(args, write) {
  const business = loadBusiness();
  const words = args.filter((a) => !a.startsWith("--"));
  const found = resolveTeam(business, words.length > 1 ? words[0] : (words[0] && business.teams[slugify(words[0])] ? words[0] : null));
  if (!found.ok) return reportTeamMiss(found, words[0], write);
  const handleToken = words.length > 1 ? words[1] : (found.inferred ? words[0] : null);
  if (!handleToken) {
    updateBusiness((data) => { delete data.teams[found.id]; });
    write(ok(`dropped team ${bone(found.id)}`));
    return 0;
  }
  const handle = slugify(handleToken);
  if (!found.team.members?.[handle]) { write(err(`no ${JSON.stringify(handle)} on ${bone(found.id)}`)); return 1; }
  updateBusiness((data) => { delete data.teams[found.id].members[handle]; });
  write(ok(`${bone(handle)} left ${bone(found.id)}`));
  return 0;
}

function listTeams(json, write) {
  const { teams } = loadBusiness();
  const ids = Object.keys(teams).sort();
  if (json) { write(JSON.stringify(teams, null, 2)); return 0; }
  if (!ids.length) {
    write(info("no teams yet."));
    write(`  ${acid("/team create Profullstack")} ${ash("then")} ${acid("/team add profullstack preshy --role member")}`);
    return 0;
  }
  write(table(
    ids.map((id) => [
      bone(id),
      teams[id].name || "",
      String(Object.keys(teams[id].members || {}).length),
      ash((teams[id].clients || []).join(", ")),
    ]),
    { columns: ["team", "name", "people", "clients"], indent: 2 },
  ));
  return 0;
}

function showTeam(args, write) {
  const business = loadBusiness();
  const found = resolveTeam(business, args[0]);
  if (!found.ok) return reportTeamMiss(found, args[0], write);
  if (args.includes("--json")) { write(JSON.stringify(found.team, null, 2)); return 0; }
  write(`  ${bone(found.id)} ${ash(found.team.name || "")}`);
  const members = Object.values(found.team.members || {});
  if (!members.length) {
    write(`  ${info("nobody on it yet")} ${acid(`/team add ${found.id} <handle>`)}`);
    return 0;
  }
  write(table(
    members.map((m) => [
      bone(m.handle),
      acid(m.role || DEFAULT_ROLE),
      m.rate ? formatRate(m.rate) : ash("—"),
      ash(grantsFor(m).join(" ")),
    ]),
    { columns: ["handle", "role", "rate", "can"], indent: 2 },
  ));
  return 0;
}

function checkCan(args, write) {
  const business = loadBusiness();
  const [who, ...rest] = args.filter((a) => !a.startsWith("--"));
  const permission = normalizePermission(rest.join(" "));
  if (!who || !permission) { write(err("usage: /team can <team>/<handle> <permission>")); return 1; }
  const [teamToken, handleToken] = who.includes("/") ? who.split("/") : [null, who];
  const found = resolveTeam(business, teamToken);
  if (!found.ok) return reportTeamMiss(found, teamToken, write);
  const member = found.team.members?.[slugify(handleToken)];
  if (!member) { write(err(`no ${JSON.stringify(handleToken)} on ${bone(found.id)}`)); return 1; }
  const allowed = can(grantsFor(member), permission);
  write(allowed
    ? ok(`${bone(member.handle)} may ${acid(permission)}`)
    : err(`${bone(member.handle)} may not ${acid(permission)}`));
  if (!allowed) write(`  ${acid(`/team grant ${found.id} ${member.handle} ${permission}`)}`);
  return allowed ? 0 : 1;
}

function whoAmI(write, env) {
  const business = loadBusiness();
  const acting = currentMember(business, env);
  if (!acting) {
    write(info("this pit is not acting as a team member — nothing is gated."));
    write(`  ${ash("set")} ${acid("MOSHCODE_MEMBER=<team>/<handle>")} ${ash("to run it as one")}`);
    return 0;
  }
  if (acting.unknown) {
    write(err(`MOSHCODE_MEMBER=${env.MOSHCODE_MEMBER} names nobody on any team here`));
    return 1;
  }
  write(`  ${bone(acting.handle)} ${ash("on")} ${bone(acting.teamId)} ${ash(`(${acting.member.role || DEFAULT_ROLE})`)}`);
  write(`  ${ash("can:")} ${acting.grants.join(" ")}`);
  return 0;
}

function reportTeamMiss(found, token, write) {
  if (found.reason === "ambiguous") {
    write(err(`${JSON.stringify(token)} matches ${found.matches.join(", ")} — say which`));
    return 1;
  }
  if (!token && found.matches?.length > 1) {
    write(err(`say which team — ${found.matches.join(", ")}`));
    return 1;
  }
  write(err(`no team ${JSON.stringify(token ?? "")} — ${acid("/team create <name>")}`));
  return 1;
}

export { USAGE as TEAM_USAGE };
