// Keeping the bridge running across reboots.
//
// `dns enable` sets up two halves with different lifetimes: a systemd-resolved
// drop-in, which is a file and survives a reboot on its own, and the bridge
// process, which does not. After a restart the routing still points at a port
// with nothing behind it and every Moshpit name stops resolving with no
// obvious cause. This is the missing half, and it is why Moshpit DNS has held
// on servers — which got a unit installed by hand — and quietly fallen over on
// desktops, which never did.
//
// The unit is *generated* rather than shipped as a file, because no static
// unit can be correct for this tool. moshcode installs under the invoking
// user's $HOME, and its wrapper execs whatever `node` is first on PATH — which
// on any mise, nvm or asdf box is another shim under $HOME. The unit that
// shipped in examples/templates said:
//
//     ExecStart=/usr/bin/env moshcode dns start --port 5354
//     DynamicUser=yes
//     ProtectHome=yes
//
// and could not start on an ordinary install three times over: `moshcode` is
// not on systemd's PATH, the `node` its wrapper needs is not on it either, and
// ProtectHome hides the install from the service even if both had been found.
// It starts only where moshcode and node are both installed system-wide, which
// is the server case — the one that was already working.
//
// So the unit is written from the running process instead. `process.execPath`
// is an interpreter demonstrably able to run this code, because it is running
// it, and the entry is the script this very command was invoked from. Nothing
// is guessed and nothing depends on PATH.
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { operatorHome } from "./trust.mjs";

export const UNIT_NAME = "moshcode-dns.service";

/**
 * Where the unit goes, and which systemctl reaches it.
 *
 * The user scope is the default because it is the one that fits how moshcode
 * is installed: a per-user tool, run by the user who owns the install, with
 * $HOME and the mise shims reachable exactly as they are in a shell. It also
 * puts the pidfile where the unprivileged `dns status` looks — systemd sets
 * XDG_RUNTIME_DIR for user units, so `pidfilePath()` resolves to
 * /run/user/<uid>/moshpit-dns.pid for the daemon and for the person asking
 * after it. Under a system unit those are two different paths.
 */
export function servicePaths({ system = false, home = operatorHome(), env = process.env } = {}) {
  return system
    ? { path: join("/etc/systemd/system", UNIT_NAME), systemctl: ["systemctl"], scope: "system" }
    : { path: join(home, ".config/systemd/user", UNIT_NAME), systemctl: userSystemctl(env), scope: "user" };
}

/**
 * How to reach the operator's own systemd from wherever this is running.
 *
 * `systemctl --user` talks to the session of whoever is running it. `dns enable`
 * escalates, so from there it is root's session — which has no bridge in it, has
 * never had one, and reports every query about one as "not loaded". Meanwhile
 * the operator's bridge keeps running with whatever it started with.
 *
 * That is why enabling proxy mode could be detected, written, and still not take
 * effect: the unit that had to change belongs to a session the escalated half of
 * the command cannot see.
 *
 * So an escalated run drops back to the invoking user, and hands them the runtime
 * directory their session bus lives in — deriving it rather than inheriting it,
 * because sudo does not carry XDG_RUNTIME_DIR across and the default under sudo
 * points at root's.
 */
export function userSystemctl(env = process.env, { home = operatorHome({ env }), owner = ownerOf } = {}) {
  const user = env.SUDO_USER || env.DOAS_USER;
  // Not escalated, or escalated from root itself: the session in reach is the
  // right one.
  if (!user || user === "root") return ["systemctl", "--user"];
  // sudo publishes the uid; doas publishes only the name. Falling back to the
  // owner of the operator's home covers that, and covers an escalator that
  // publishes neither — without it, a doas machine would quietly address root's
  // session, which has no bridge in it and never will.
  const uid = env.SUDO_UID || env.DOAS_UID || owner(home);
  if (uid === null || uid === undefined) return ["systemctl", "--user"];
  return ["sudo", "-u", user, "env", `XDG_RUNTIME_DIR=/run/user/${uid}`, "systemctl", "--user"];
}

function ownerOf(path) {
  try {
    return statSync(path).uid;
  } catch {
    return null;
  }
}

/**
 * The unit text, pinned to this install.
 *
 * `ProtectHome` is deliberately absent rather than set to a weaker value: the
 * whole program lives under $HOME, so there is no setting of it that both
 * protects anything and lets the service start. The hardening that survives is
 * the hardening that does not contradict where the code is.
 */
export function serviceUnit({
  system = false,
  execPath = process.execPath,
  entry,
  port,
  registryBase = null,
  upstreams = [],
  proxy = null,
  user = process.env.USER || process.env.LOGNAME,
} = {}) {
  if (!entry) throw new Error("serviceUnit needs the entry script to run");

  const args = [entry, "dns", "start", "--port", String(port)];
  if (registryBase) args.push("--registry", registryBase);
  // The reason this unit exists at all is that the bridge now starts at boot —
  // and at boot the resolved drop-in is already in place, so the only
  // nameserver discovery can find is this bridge. It refuses loopback, comes up
  // with nowhere to forward, and NXDOMAINs every clearnet name including the
  // registry. Recorded here, while a working resolver is still around to be
  // asked, rather than rediscovered at boot when it cannot be.
  if (upstreams.length) args.push("--upstream", upstreams.join(","));
  // Without this the supervised bridge answers every name with its origin, and
  // the origin serves a certificate no CA signed — so `https://` fails on a
  // machine where the pinned-TLS proxy is installed, trusted and running.
  // `dns enable` has always probed for the proxy and passed it through;
  // `dns service` did not, which made a service-managed bridge the one way to
  // run Moshpit where HTTPS could never work.
  if (proxy) args.push("--proxy", proxy);
  const exec = [execPath, ...args].map((part) => (/\s/.test(part) ? JSON.stringify(part) : part)).join(" ");

  const lines = [
    "# Generated by `moshcode dns service`. Regenerate it rather than editing:",
    "# the paths below are this install's, and a moshcode or node that moves",
    "# leaves a unit that fails at 203/EXEC with nothing else to say.",
    "[Unit]",
    "Description=Moshpit DNS bridge",
    "Documentation=https://github.com/moshcoder/moshcode",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${exec}`,
    "Restart=always",
    "RestartSec=2",
    // 5354 is unprivileged, so nothing here needs root or a capability.
    "NoNewPrivileges=yes",
    "PrivateTmp=yes",
  ];

  if (system) {
    // A system unit has no user of its own, so it has to be told which install
    // to run — and it is the only scope where that question has a wrong answer.
    lines.push(`User=${user}`);
  }

  lines.push(
    "",
    "[Install]",
    system ? "WantedBy=multi-user.target" : "WantedBy=default.target",
    "",
  );
  return lines.join("\n");
}

const defaultRead = async (path) => readFile(path, "utf8").catch(() => "");

function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (error) => resolve({ ok: false, error: error.message }));
    child.on("exit", (code) => resolve({ ok: code === 0, stdout: out, error: err.trim() }));
  });
}

/** Write the unit and start it. Returns the steps taken, in order, for printing. */
export async function installService(unit, { system = false, home = operatorHome(), exec = run, env = process.env } = {}) {
  const { path, systemctl, scope } = servicePaths({ system, home, env });
  const steps = [];
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, unit);
    steps.push({ step: `wrote ${path}`, ok: true });
  } catch (error) {
    return { ok: false, path, scope, steps: [{ step: `could not write ${path}: ${error.message}`, ok: false }] };
  }

  const [cmd, ...flags] = systemctl;
  // Enable *and* restart. `enable --now` starts a stopped unit and does nothing
  // to a running one, so rewriting the unit to add `--proxy` would leave the old
  // bridge running without it — the change on disk, no change in behaviour.
  for (const args of [
    [...flags, "daemon-reload"],
    [...flags, "enable", UNIT_NAME],
    [...flags, "restart", UNIT_NAME],
  ]) {
    const result = await exec(cmd, args);
    steps.push({ step: `${cmd} ${args.join(" ")}`, ok: result.ok, error: result.error });
    if (!result.ok) return { ok: false, path, scope, steps };
  }
  return { ok: true, path, scope, steps };
}

/**
 * The `--upstream` servers an installed unit already forwards to.
 *
 * Read back rather than recomputed. A supervised bridge needs upstreams to hand
 * the clearnet to, and the machine may already be routing every lookup at that
 * bridge — so asking the system resolver what its upstreams are can answer
 * "this bridge", and a bridge whose upstream is itself resolves nothing at all.
 * Whatever the unit was working with is the safe answer to keep.
 */
export function unitUpstreams(text) {
  const line = String(text ?? "").split("\n").find((l) => l.startsWith("ExecStart="));
  if (!line) return [];
  const parts = line.trim().split(/\s+/);
  const found = [];
  for (let i = 0; i < parts.length; i += 1) {
    if (parts[i] !== "--upstream") continue;
    const value = parts[i + 1];
    if (!value || value.startsWith("--")) continue;
    if (!found.includes(value)) found.push(value);
  }
  return found;
}

/**
 * Re-describe the bridge unit to match the run happening now, and restart it so
 * the description becomes the truth.
 *
 * This is the step that made proxy mode arrive one reboot late. A supervised
 * bridge is not started by `enable`: it is already up under `Restart=always`,
 * so `startDaemon` finds a live pidfile and reports "already running" — true,
 * and useless, because what a resolver answers with is fixed when it spawns. A
 * bridge that came up before the proxy existed goes on answering origins
 * forever, and stopping it by hand does not help, since systemd brings the same
 * ExecStart straight back.
 *
 * The only thing that changes a supervised bridge's mind is rewriting its unit
 * and restarting it. That is all this is.
 *
 * With no unit installed it does nothing and says so. An unsupervised machine
 * is `startDaemon`'s business, and writing a unit here would be `enable`
 * quietly making the bridge outlive a reboot on a machine that never asked for
 * that — a different decision, and one `dns service --write` exists to make.
 */
export async function refreshService({
  entry,
  port,
  registryBase = null,
  proxy = null,
  system = false,
  home = operatorHome(),
  env = process.env,
  exec = run,
  exists = existsSync,
  read = defaultRead,
} = {}) {
  const { path, scope } = servicePaths({ system, home, env });
  if (!exists(path)) return { refreshed: false, reason: "no unit installed", path, scope, upstreams: [], steps: [] };

  const current = await read(path);
  const upstreams = unitUpstreams(current);
  const unit = serviceUnit({ system, entry, port, registryBase, upstreams, proxy });

  // Deliberately not short-circuited on `current === unit`. Matching text says
  // the unit describes the right bridge, not that the bridge is running it: a
  // unit can be installed and stopped, installed and never enabled, or running
  // what it was spawned with before the file last changed. Since the whole
  // point here is to make what is running match what is written, the enable and
  // restart happen either way, and cost a moment of no resolver during a
  // command that is already rewriting the machine's routing.

  const result = await installService(unit, { system, home, env, exec });
  return {
    refreshed: result.ok,
    reason: result.ok ? null : "systemctl refused the unit",
    path,
    scope,
    upstreams,
    steps: result.steps,
  };
}

/**
 * Stop the supervised bridge and leave the unit where it is.
 *
 * `stopDaemon` cannot do this. It reads the pidfile and signals that process,
 * which is right for a bridge started by hand and useless for one systemd owns:
 * the unit is `Restart=always`, so the pid dies and the same ExecStart is back
 * within the second. `disable` printed "bridge stopped" and left a bridge
 * running — on a machine whose routing had just been put back, so the bridge
 * was still up, still answering, and no longer on anybody's path.
 *
 * The unit file stays. Removing it is a different decision than turning
 * resolution off for an afternoon, and `enable` re-enables what it finds — so
 * leaving it costs nothing and deleting it would quietly take away a unit the
 * operator may have written themselves.
 */
export async function stopService({ system = false, home = operatorHome(), env = process.env, exec = run, exists = existsSync } = {}) {
  const { path, systemctl, scope } = servicePaths({ system, home, env });
  if (!exists(path)) return { stopped: false, reason: "no unit installed", path, scope, steps: [] };
  const [cmd, ...flags] = systemctl;
  const result = await exec(cmd, [...flags, "disable", "--now", UNIT_NAME]);
  return {
    stopped: result.ok,
    reason: result.ok ? null : (result.error || "systemctl refused"),
    path,
    scope,
    steps: [{ step: `${cmd} ${flags.join(" ")} disable --now ${UNIT_NAME}`, ok: result.ok, error: result.error }],
  };
}

/** Stop it and take the unit away. Missing is not a failure — removal is idempotent. */
export async function removeService({ system = false, home = operatorHome(), exec = run, env = process.env } = {}) {
  const { path, systemctl, scope } = servicePaths({ system, home, env });
  const [cmd, ...flags] = systemctl;
  const steps = [];
  for (const args of [[...flags, "disable", "--now", UNIT_NAME]]) {
    const result = await exec(cmd, args);
    steps.push({ step: `${cmd} ${args.join(" ")}`, ok: result.ok, error: result.error });
  }
  await rm(path, { force: true });
  steps.push({ step: `removed ${path}`, ok: true });
  const reload = await exec(cmd, [...flags, "daemon-reload"]);
  steps.push({ step: `${cmd} ${[...flags, "daemon-reload"].join(" ")}`, ok: reload.ok, error: reload.error });
  return { ok: true, path, scope, steps };
}

/* --------------------------------------------------- the pinned-TLS proxy */

/**
 * The other half of a machine that can actually reach Moshpit names.
 *
 * The bridge makes names resolve. It cannot make them verifiable: no CA will
 * ever sign for `.eggs`, so without a proxy every name answers its origin's own
 * self-signed leaf and a stock client refuses it. moshpit-proxy terminates TLS
 * with a local root instead — one root for every ending, rather than trusting
 * certificates one name at a time.
 *
 * moshpit-proxy ships no unit of its own, so nothing ever started it. It was
 * installed, trusted, and idle, which reads exactly like "not installed" from
 * every direction: nothing on 443, no certificate, and `dns enable` correctly
 * reporting no proxy on a machine that had one.
 */
export const PROXY_UNIT_NAME = "moshpit-proxy.service";

/**
 * A system unit, unlike the bridge's.
 *
 * 443 is privileged and the proxy must have it: DNS carries an address and has
 * nowhere to put a port, so a browser sent to a Moshpit name goes to 443 or
 * nowhere. A user unit cannot bind it. So this is a system unit that drops to
 * the operator's account and is granted the one capability it needs — rather
 * than running as root, which it has no other use for.
 */
export function proxyServicePaths() {
  return { path: join("/etc/systemd/system", PROXY_UNIT_NAME), systemctl: ["systemctl"], scope: "system" };
}

/**
 * The unit text, pinned to this install.
 *
 * `ExecStart` runs moshpit-proxy's own wrapper rather than reaching past it to
 * an entry script, so a change to that project's layout does not silently break
 * this. The wrapper execs `node`, which systemd's PATH does not have on a mise,
 * nvm or asdf box — so PATH is set from the interpreter running this code,
 * which is by definition one that works. That mistake has now been made three
 * times in this codebase; it is made here on purpose and only once.
 */
export function proxyServiceUnit({
  wrapper,
  nodeDir,
  home = operatorHome(),
  user = process.env.SUDO_USER || process.env.USER || process.env.LOGNAME,
  port = 443,
  tlds = [],
} = {}) {
  if (!wrapper) throw new Error("proxyServiceUnit needs the moshpit-proxy wrapper path");
  if (!user) throw new Error("proxyServiceUnit needs the account the proxy runs as");

  const path = [nodeDir, "/usr/local/bin", "/usr/bin", "/bin"].filter(Boolean).join(":");
  // `.moshpit` under the operator's home is where the local root already lives,
  // put there by moshpit-proxy's own installer. Naming it explicitly keeps the
  // service off /root/.moshpit, which is where a system unit would otherwise
  // look and where there is nothing.
  const dir = join(home, ".moshpit");

  const lines = [
    "# Generated by `moshcode dns enable`. Regenerate rather than editing:",
    "# the paths below are this install's, and a node or proxy that moves leaves",
    "# a unit that fails at 203/EXEC with nothing else to say.",
    "[Unit]",
    "Description=Moshpit pinned-TLS proxy",
    "Documentation=https://github.com/profullstack/moshpit-proxy",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `User=${user}`,
    `Environment=PATH=${path}`,
    `Environment=MOSHPIT_PROXY_PORT=${port}`,
    `Environment=MOSHPIT_PROXY_DIR=${dir}`,
  ];
  // Deliberately not written any more.
  //
  // It used to be set from the endings the registry had sold — 18224 of them, a
  // ~150 KB environment variable in a unit file, for a list stale the next time
  // one is sold. moshpit-proxy now reads an unset value as "every Moshpit
  // ending", defining the namespace by excluding the real internet rather than
  // by enumerating what Moshpit owns, so there is nothing left to pass. Setting
  // it there still narrows, which is a deployment's choice and not this unit's.

  lines.push(
    `ExecStart=${wrapper}`,
    "Restart=always",
    "RestartSec=2",
    // The whole reason this is a system unit. Granted rather than inherited:
    // the proxy runs as the operator and needs exactly one privilege.
    "AmbientCapabilities=CAP_NET_BIND_SERVICE",
    "CapabilityBoundingSet=CAP_NET_BIND_SERVICE",
    "NoNewPrivileges=yes",
    "PrivateTmp=yes",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  );
  return lines.join("\n");
}

/**
 * Is the local root the old shape, minted for a list of endings?
 *
 * moshpit-proxy used to constrain its root by naming what it could certify.
 * That root works only for the endings it happened to name, which is why a
 * machine could reach `.2600` over HTTPS and not `.hacker` — and why the list
 * could never be right, since the registry keeps selling more.
 *
 * The root it mints now excludes the real internet instead and covers the whole
 * namespace. But a machine that ran the old proxy still has the old root on
 * disk, and moshpit-proxy will not replace a root that already exists — so
 * without this, upgrading leaves the narrow root in place and `.hacker` keeps
 * failing with nothing to explain why.
 *
 * A permitted DNS subtree is the tell. The new root has none by design.
 */
export async function rootIsNarrow({
  home = operatorHome(),
  exec = run,
  exists = existsSync,
} = {}) {
  const file = join(home, ".moshpit", "ca", "ca.crt");
  if (!exists(file)) return { narrow: false, reason: "no root yet", file };
  const described = await exec("openssl", ["x509", "-noout", "-text", "-in", file]);
  // Unreadable is not narrow. Deleting a root because openssl was missing would
  // throw away a working setup to fix a problem nobody had.
  if (!described.ok) return { narrow: false, reason: "could not read it", file };
  return described.stdout && /Permitted:/i.test(described.stdout)
    ? { narrow: true, reason: "constrained to a list of endings", file }
    : { narrow: false, reason: "already covers the namespace", file };
}

/** Where moshpit-proxy's installer puts its wrapper, if it ran. */
export function proxyWrapperPath({ home = operatorHome(), exists = existsSync } = {}) {
  const candidate = join(home, ".local/bin/moshpit-proxy");
  return exists(candidate) ? candidate : null;
}

/**
 * Put the proxy under supervision, and wait for it to actually hold 443.
 *
 * Returns a plain report rather than throwing, and every caller treats a
 * failure as "no proxy" rather than as a failed run. A machine without a
 * working proxy resolves Moshpit names and cannot verify them, which is worse
 * than it sounds but is still enormously better than a machine whose DNS was
 * refused because an optional component would not start.
 *
 * `listening` is asked rather than assumed: `Type=simple` reports active the
 * moment it forks, so "started" and "serving" are different questions and this
 * has to answer the second one. The proxy fetches a registry pin before it can
 * answer, so the wait is generous.
 */
export async function ensureProxyService({
  home = operatorHome(),
  user = process.env.SUDO_USER || process.env.USER || process.env.LOGNAME,
  nodeDir = dirname(process.execPath),
  tlds = [],
  port = 443,
  exec = run,
  narrowRoot = rootIsNarrow,
  paths = proxyServicePaths,
  read = async (f) => (await import("node:fs/promises")).readFile(f, "utf8"),
  listening = defaultPortHeld,
  waitMs = 30000,
} = {}) {
  const wrapper = proxyWrapperPath({ home });
  if (!wrapper) return { ok: false, reason: "not-installed", steps: [] };

  const { path, systemctl } = paths();
  const unit = proxyServiceUnit({ wrapper, nodeDir, home, user, port, tlds });
  // Read before writing so the manifest can put back whatever was here — which
  // is usually nothing, and "nothing" has to be recorded as precisely as
  // content would be, or disable leaves a unit nobody asked for.
  const before = await read(path).catch(() => null);

  const steps = [];

  // A root minted by the old proxy names the endings it may certify, and
  // moshpit-proxy will not replace a root that already exists. Left alone, an
  // upgraded machine keeps the narrow root and `.hacker` keeps failing — so it
  // goes, and the proxy mints the current shape on its next start.
  //
  // Safe to remove: it is a local root, regenerated in seconds, and `dns enable`
  // installs the replacement into the trust stores in the same run. Removing it
  // without that would be the destructive half on its own, which is why this
  // lives here and not in the installer.
  const narrow = await narrowRoot({ home, exec });
  if (narrow.narrow) {
    await rm(join(home, ".moshpit", "ca"), { recursive: true, force: true }).catch(() => {});
    steps.push({ step: `reminted the local root — the old one was ${narrow.reason}`, ok: true });
  }

  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, unit);
    steps.push({ step: `wrote ${path}`, ok: true });
  } catch (error) {
    return { ok: false, reason: "write-failed", error: error.message, before, steps };
  }

  const [cmd, ...flags] = systemctl;
  // `enable --now` starts a stopped unit and does nothing to a running one, so
  // an upgrade would leave the previous process — and the previous root, and
  // the previous namespace — in place. Restart is what makes an upgrade take.
  for (const args of [
    [...flags, "daemon-reload"],
    [...flags, "enable", PROXY_UNIT_NAME],
    [...flags, "restart", PROXY_UNIT_NAME],
  ]) {
    const result = await exec(cmd, args);
    steps.push({ step: `${cmd} ${args.join(" ")}`, ok: result.ok, error: result.error });
    if (!result.ok) return { ok: false, reason: "systemctl-failed", before, steps, path, unit };
  }

  const held = await listening(port, waitMs);
  steps.push({ step: `proxy holds 127.0.0.1:${port}`, ok: held });
  return { ok: held, reason: held ? null : "not-listening", before, steps, path, unit };
}

/** Poll rather than sleep once: a proxy that comes up in 2s should not cost 30. */
async function defaultPortHeld(port, waitMs) {
  const { connect } = await import("node:net");
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const open = await new Promise((resolve) => {
      const socket = connect({ host: "127.0.0.1", port });
      const done = (v) => { try { socket.destroy(); } catch { /* gone */ } resolve(v); };
      socket.once("connect", () => done(true));
      socket.once("error", () => done(false));
      setTimeout(() => done(false), 1000);
    });
    if (open) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

/** Take the proxy service away. Missing is not a failure. */
export async function removeProxyService({ exec = run } = {}) {
  const { path, systemctl } = proxyServicePaths();
  const [cmd, ...flags] = systemctl;
  const steps = [];
  const off = await exec(cmd, [...flags, "disable", "--now", PROXY_UNIT_NAME]);
  steps.push({ step: `${cmd} ${[...flags, "disable", "--now", PROXY_UNIT_NAME].join(" ")}`, ok: off.ok, error: off.error });
  await rm(path, { force: true });
  steps.push({ step: `removed ${path}`, ok: true });
  const reload = await exec(cmd, [...flags, "daemon-reload"]);
  steps.push({ step: `${cmd} ${[...flags, "daemon-reload"].join(" ")}`, ok: reload.ok, error: reload.error });
  return { ok: true, path, steps };
}
