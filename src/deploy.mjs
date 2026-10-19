// `moshcode deploy <name> [dir]` — put a folder online under a Moshpit name.
//
// The server is a Moshpit server (dev3.profullstack.com unless told otherwise):
// $5 a month, any number of sites, one Unix account per customer. Each name
// lives in `~/apps/<name>/` on that account, nginx serves `public/` (or proxies
// to the port the app declared), and the pit.world relay carries it to anyone
// who is not on Moshpit DNS. Setting a name up on the box the first time —
// certificate, nginx block, the registry's "points at" — is `moshpit-host`,
// which Profullstack runs; this command is everything after that.
//
// So it is two steps and both are the boring tools: rsync the folder up, then
// run the site's own `deploy.sh` there if it has one, inside the box's deploy
// gate (@profullstack/deploy) when the box has it, so a dozen sites deploying
// at once queue instead of building together.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { acid, ash, bone, err, info, ok } from "./ui.mjs";

export const DEFAULT_HOST = "dev3.profullstack.com";

/** What never leaves the laptop: history, dependencies, secrets, Finder litter. */
export const EXCLUDES = [".git", "node_modules", ".env", ".env.*", ".DS_Store"];

/**
 * A Moshpit name: two or more lowercase labels (`blue.eggs`, `shop.blue.eggs`).
 *
 * Stricter than a hostname on purpose. The name becomes a remote path and part
 * of a shell command, so anything that is not [a-z0-9-] between dots is
 * refused rather than escaped, and so is an empty label: `apps/blue..eggs` is
 * a different directory from the one the owner meant.
 *
 * @param {unknown} input
 * @returns {string | null}
 */
export function deployName(input) {
  const clean = String(input ?? "").trim().toLowerCase().replace(/\.$/, "");
  if (!clean || clean.length > 253) return null;
  const parts = clean.split(".");
  if (parts.length < 2) return null;
  if (!parts.every((p) => /^[a-z0-9-]{1,63}$/.test(p) && !p.startsWith("-") && !p.endsWith("-"))) return null;
  return clean;
}

/** POSIX single-quoting: the one quoting that needs no further thought. */
export const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * @param {string[]} argv
 * @param {object} [env]
 */
export function parseArgs(argv = [], env = process.env) {
  const args = (Array.isArray(argv) ? argv : []).map(String);
  const opts = {
    name: null,
    dir: null,
    host: env.MOSHCODE_DEPLOY_HOST || DEFAULT_HOST,
    user: env.MOSHCODE_DEPLOY_USER || "",
    dryRun: false,
    json: false,
    help: false,
    error: null,
  };
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--dry-run" || arg === "-n") { opts.dryRun = true; continue; }
    if (arg === "--json") { opts.json = true; continue; }
    if (arg === "--help" || arg === "-h") { opts.help = true; continue; }
    if (arg === "--host" || arg === "--user") {
      const value = args[i + 1];
      if (!value || value.startsWith("-")) { opts.error = `${arg} needs a value`; break; }
      opts[arg.slice(2)] = value;
      i += 1;
      continue;
    }
    if (arg.startsWith("--host=")) { opts.host = arg.slice(7); continue; }
    if (arg.startsWith("--user=")) { opts.user = arg.slice(7); continue; }
    if (arg.startsWith("-") && arg !== "-") { opts.error = `unknown flag: ${arg}`; break; }
    positional.push(arg);
  }
  if (!opts.error && !opts.help) {
    if (!positional.length) opts.help = true;
    else if (positional.length > 2) opts.error = `too many arguments: ${positional.slice(2).join(" ")}`;
    else {
      opts.name = deployName(positional[0]);
      if (!opts.name) opts.error = `not a Moshpit name: ${positional[0]} (like shop.blue or blue.eggs)`;
      opts.dir = positional[1] || ".";
    }
  }
  // A host or user is spliced into an ssh destination; refuse what could be read as an option.
  if (!opts.error && !/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(opts.host)) opts.error = `not a host: ${opts.host}`;
  if (!opts.error && opts.user && !/^[a-z_][a-z0-9_-]{0,31}$/.test(opts.user)) opts.error = `not a user: ${opts.user}`;
  return opts;
}

/**
 * The commands a deploy runs, in order, as argv arrays. Nothing runs here,
 * which is what --dry-run prints and what the tests check.
 *
 * `hasPublic` decides the layout: a folder with its own `public/` is an app
 * (its deploy.sh and server code go up beside it), a folder without one is the
 * site itself and lands in `public/`.
 *
 * @param {{name: string, dir: string, host: string, user?: string}} opts
 * @param {{hasPublic: boolean}} layout
 */
export function plan({ name, dir, host, user = "" }, { hasPublic }) {
  const dest = user ? `${user}@${host}` : host;
  const remoteDir = `apps/${name}`;
  const source = dir.endsWith("/") ? dir : `${dir}/`;
  const target = hasPublic ? `${remoteDir}/` : `${remoteDir}/public/`;
  const prepare = `if [ -d ${shq(remoteDir)} ]; then echo existing; else echo new; fi; mkdir -p ${shq(target)}`;
  const run =
    `cd ${shq(remoteDir)} && if [ -x deploy.sh ]; then g=$(command -v deploy-gate || true); ` +
    `if [ -n "$g" ]; then exec "$g" --name ${shq(name)} -- ./deploy.sh; else exec ./deploy.sh; fi; fi`;
  return {
    dest,
    remoteDir,
    steps: [
      { label: "prepare", argv: ["ssh", dest, prepare] },
      {
        label: "upload",
        // nginx reads the files as another user, so a 0700 folder or 0600 file from the laptop would 403:
        // directories go up 755 and files gain go+r, keeping deploy.sh's execute bit.
        argv: ["rsync", "-az", "--delete", "--chmod=D755,Fgo+r,Fu+rw", ...EXCLUDES.flatMap((x) => ["--exclude", x]), "-e", "ssh", source, `${dest}:${target}`],
      },
      { label: "deploy.sh", argv: ["ssh", dest, run] },
    ],
    urls: [`https://${name}/`, `https://${name}.pit.world/`],
  };
}

/** Is `bin` on PATH? */
function onPath(bin, env = process.env) {
  return String(env.PATH || "")
    .split(path.delimiter)
    .some((d) => d && fs.existsSync(path.join(d, bin)));
}

const showArgv = (argv) => argv.map((a) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : shq(a))).join(" ");

function usage(out, prefix) {
  out(info("usage:"));
  out(`  ${acid(`${prefix} <name> [dir]`)}${ash("  upload dir (default .) to apps/<name> on your Moshpit server")}`);
  out(`  ${ash("  --host <host>   the server (default $MOSHCODE_DEPLOY_HOST or " + DEFAULT_HOST + ")")}`);
  out(`  ${ash("  --user <user>   ssh user (default $MOSHCODE_DEPLOY_USER, else ssh's own)")}`);
  out(`  ${ash("  --dry-run       print the commands instead of running them")}`);
  out(`  ${ash("  --json          machine-readable result")}`);
}

/**
 * `moshcode deploy`.
 *
 * @param {string[]} argv
 * @param {{out?: Function, err?: Function, env?: object, prefix?: string,
 *          spawn?: typeof spawnSync, exists?: (p: string) => boolean,
 *          has?: (bin: string) => boolean}} [io]
 * @returns {Promise<number>} exit code
 */
export async function deployCommand(argv = [], io = {}) {
  const out = io.out || ((s) => console.log(s));
  const say = io.err || ((s) => console.error(s));
  const env = io.env || process.env;
  const prefix = io.prefix || "moshcode deploy";
  const spawn = io.spawn || spawnSync;
  const exists = io.exists || ((p) => fs.existsSync(p));
  const has = io.has || ((bin) => onPath(bin, env));

  const opts = parseArgs(argv, env);
  if (opts.help) { usage(out, prefix); return opts.error ? 1 : 0; }
  if (opts.error) { say(err(opts.error)); return 1; }
  if (!exists(opts.dir)) { say(err(`no such folder: ${opts.dir}`)); return 1; }

  const p = plan(opts, { hasPublic: exists(path.join(opts.dir, "public")) });

  if (opts.dryRun) {
    if (opts.json) { out(JSON.stringify({ name: opts.name, dest: p.dest, dryRun: true, steps: p.steps, urls: p.urls }, null, 2)); return 0; }
    for (const step of p.steps) out(showArgv(step.argv));
    return 0;
  }

  for (const bin of ["ssh", "rsync"]) {
    if (!has(bin)) { say(err(`${bin} is not installed — moshcode deploy needs ssh and rsync`)); return 127; }
  }

  let fresh = false;
  for (const step of p.steps) {
    if (!opts.json) out(info(`${step.label} → ${p.dest}`));
    const captured = step.label === "prepare";
    const r = spawn(step.argv[0], step.argv.slice(1), { stdio: captured ? ["ignore", "pipe", "inherit"] : "inherit", encoding: "utf8" });
    if (r.error) { say(err(`${step.label}: ${r.error.message}`)); return 1; }
    if (r.status !== 0) {
      say(err(`${step.label} failed (exit ${r.status ?? r.signal})`));
      return r.status || 1;
    }
    if (captured) fresh = String(r.stdout || "").trim().endsWith("new");
  }

  if (opts.json) {
    out(JSON.stringify({ name: opts.name, dest: p.dest, deployed: true, firstDeploy: fresh, urls: p.urls }, null, 2));
    return 0;
  }
  out(ok(`${opts.name} deployed to ${p.dest}:${p.remoteDir}`));
  for (const url of p.urls) out(`  ${bone(url)}`);
  if (fresh) {
    out(ash(`  first deploy of ${opts.name} here: it opens once the name is set up on the server`));
    out(ash(`  (moshpit-host, done by Profullstack — https://pit.world/start)`));
  }
  return 0;
}
