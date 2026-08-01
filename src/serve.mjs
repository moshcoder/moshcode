// Serve a Moshpit name from this machine.
//
// The work is four lines of web-server config, and every one of them is a line
// people get wrong in the same way:
//
//   - no redirect to HTTPS. A box's default vhost usually sends everything to
//     https, and for a Moshpit ending that is a redirect to a page that can
//     never load, because no CA will issue for an ending outside the DNS root.
//     Through the gateway it is worse: pit.moshcode.sh forwards the status and
//     not the Location, so a visitor gets a 301 pointing nowhere at all.
//   - an exact server_name, which is what beats the default vhost.
//   - both address families. A visitor running the resolver arrives over IPv6,
//     because that is what the name points at; a visitor without one arrives
//     via the gateway, which fetches server-side. Drop either listen line and
//     one of those audiences loses the site.
//   - port 80 only. A DNS record carries an address and has nowhere to put a
//     port, so the resolver path cannot reach anything else.
//
// Config is written, never executed, and nothing is applied without --write.

import { promises as fs } from "node:fs";
import path from "node:path";

/** Where each server keeps drop-in site config. */
const SERVERS = {
  nginx: { dir: "/etc/nginx/conf.d", ext: ".conf", reload: ["systemctl", "reload", "nginx"], check: ["nginx", "-t"] },
  caddy: { dir: "/etc/caddy/conf.d", ext: ".caddy", reload: ["systemctl", "reload", "caddy"], check: null },
};

/**
 * Who is actually listening on port 80.
 *
 * Asked of the running system rather than of the filesystem, because the
 * filesystem lies: a box can carry /etc/nginx from a package installed years
 * ago while Caddy is the thing answering, and writing nginx config there
 * succeeds at every step and serves nothing. That is the worst outcome
 * available — everything reports success and the site is missing.
 *
 * Falls back to config directories when the port cannot be inspected, which is
 * what happens without privileges: `ss` will show the socket but not who owns
 * it. A guess is still better than refusing to act, as long as it is the
 * second answer rather than the first.
 */
export async function detectServer({ listeners = defaultListeners, exists = defaultExists } = {}) {
  const holder = await listeners().catch(() => null);
  if (holder) {
    for (const server of Object.keys(SERVERS)) {
      if (holder.includes(server)) return server;
    }
    // Only claim an unknown holder when a process name was actually visible.
    // Without privileges `ss` prints the socket and no owner, and treating
    // that as "something unrecognised" would refuse to act on the common case
    // — a plain user asking what would be installed.
    const named = holder.match(/users:\(\("([^"]+)"/);
    if (named) return { unknown: named[1] };
  }
  if (await exists("/etc/nginx")) return "nginx";
  if (await exists("/etc/caddy")) return "caddy";
  return null;
}

const defaultExists = async (p) => {
  const { promises } = await import("node:fs");
  return !!(await promises.stat(p).catch(() => null));
};

/** The process names bound to port 80, as one lowercase string. */
const defaultListeners = async () => {
  const { execFile } = await import("node:child_process");
  const out = await new Promise((resolve) => {
    execFile("ss", ["-tlnp"], { timeout: 5000 }, (err, stdout) => resolve(err ? "" : String(stdout)));
  });
  return out
    .split("\n")
    .filter((line) => /:80\s/.test(line))
    .join(" ")
    .toLowerCase();
};

/** An nginx server block for one Moshpit name. */
export function nginxSite({ name, root, proxy }) {
  const body = proxy
    ? [`\tlocation / {`, `\t\tproxy_pass http://127.0.0.1:${proxy};`, `\t\tproxy_set_header Host $host;`, `\t\tproxy_set_header X-Moshpit-Name $host;`, `\t}`]
    : [`\troot ${root};`, `\tindex index.html;`, ``, `\tlocation / {`, `\t\ttry_files $uri $uri/ =404;`, `\t}`];

  return [
    `# ${name} — written by \`moshcode serve\`.`,
    "#",
    "# No redirect to HTTPS, deliberately: no CA will issue for an ending outside",
    "# the DNS root, so a redirect here points at a page that can never load. The",
    "# gateway forwards the status without the Location header, which makes it a",
    "# 301 to nowhere.",
    "#",
    "# Both listen lines matter. Resolver users arrive over IPv6 because that is",
    "# what the name points at; everyone else arrives via pit.moshcode.sh, which",
    "# fetches this server-side.",
    "server {",
    "\tlisten 80;",
    "\tlisten [::]:80;",
    "",
    `\tserver_name ${name};`,
    "",
    ...body,
    "",
    "\tlocation ~ /\\. {",
    "\t\tdeny all;",
    "\t}",
    "}",
    "",
  ].join("\n");
}

/** The Caddy equivalent. */
export function caddySite({ name, root, proxy }) {
  return [
    `# ${name} — written by \`moshcode serve\`.`,
    "#",
    "# The http:// is required and is not a style choice. Leave it off and Caddy",
    "# tries to provision a certificate for an ending no CA will issue for, fails,",
    "# and the site never comes up.",
    `http://${name} {`,
    proxy ? `\treverse_proxy 127.0.0.1:${proxy}` : `\troot * ${root}`,
    proxy ? "" : "\tfile_server",
    "}",
    "",
  ].filter((line) => line !== "").join("\n") + "\n";
}

/**
 * What serving this name would change.
 *
 * Returned rather than done, so `--write` is the only thing that touches the
 * machine and everything before it can be read first.
 */
export function servePlan({ name, server, root, proxy, reload = false }) {
  const target = SERVERS[server];
  if (!target) return { ok: false, error: `no supported web server found — install nginx or caddy` };

  const file = path.join(target.dir, `${name}${target.ext}`);
  const content = server === "nginx" ? nginxSite({ name, root, proxy }) : caddySite({ name, root, proxy });

  const steps = [{ kind: "write", path: file, content, why: `answer to ${name} without redirecting it` }];
  if (!proxy) steps.push({ kind: "mkdir", path: root, why: "somewhere for the files to live" });
  // Validation runs whether or not we reload: a config that does not parse is
  // worth knowing about now rather than the next time anything touches nginx,
  // which may be a reboot and may be someone else.
  if (target.check) steps.push({ kind: "run", command: target.check[0], args: target.check.slice(1), why: "a config that does not parse is a problem now, not later" });
  // Reloading is what makes the site live, so it is opt-in. Installing config
  // and activating it are different decisions: the first is reversible by
  // deleting a file, the second changes what a running server does to traffic.
  if (reload) steps.push({ kind: "run", command: target.reload[0], args: target.reload.slice(1), why: "make it live now" });

  return { ok: true, server, file, root: proxy ? null : root, proxy: proxy ?? null, steps };
}

const USAGE = `moshcode site — install web-server config for a Moshpit name

  moshcode site <name>                     show what would be installed
  moshcode site <name> --install           write the config (needs root)
  moshcode site <name> --install --reload  ...and make it live now
  moshcode site <name> --proxy 3000        reverse-proxy a local port instead
  moshcode site <name> --root <dir>        where the files live

moshcode does not serve anything itself. This writes a config file for the web
server already on this machine; nginx or Caddy does the serving.

The name still has to point at this machine — set that in the Pit, and check
it with \`moshcode dns resolve <name>\`. This only makes the box answer to it.`;

export async function serveCommand(args = [], out = console.log, deps = {}) {
  const { detect = detectServer, write = fs.writeFile, mkdir = fs.mkdir, runner = null } = deps;
  const [name, ...rest] = args;

  if (!name || name === "help" || name === "--help" || name === "-h") {
    out(USAGE);
    return name ? 0 : 1;
  }
  if (!/^[a-z0-9]{1,63}\.[a-z0-9]{1,63}$/i.test(name)) {
    out(`moshcode site: ${JSON.stringify(name)} is not a Moshpit name (one label, one ending)`);
    return 1;
  }

  const flag = (f) => { const at = rest.indexOf(f); return at >= 0 ? rest[at + 1] : undefined; };
  const proxy = flag("--proxy");
  if (proxy !== undefined && !/^\d+$/.test(proxy)) {
    out("moshcode site: --proxy takes a port");
    return 1;
  }
  const root = flag("--root") || `/srv/${name}`;

  const server = await detect();
  if (server && typeof server === "object" && server.unknown) {
    out(`moshcode site: port 80 is held by something this cannot configure`);
    out(`  ${server.unknown}`);
    out("  install nginx or caddy, or add the equivalent block by hand.");
    return 1;
  }
  const plan = servePlan({ name, server, root, proxy: proxy ? Number(proxy) : null, reload: rest.includes("--reload") });
  if (!plan.ok) {
    out(`moshcode site: ${plan.error}`);
    return 1;
  }

  out(`${name} → ${plan.proxy ? `127.0.0.1:${plan.proxy}` : plan.root}  (${plan.server}, port 80, plain HTTP)`);
  out("");
  for (const step of plan.steps) {
    const what = step.kind === "run" ? `${step.command} ${step.args.join(" ")}` : step.path;
    out(`  ${step.kind.padEnd(6)} ${what}`);
    out(`         ${step.why}`);
  }
  out("");

  if (!rest.includes("--install")) {
    out(plan.server === "nginx" ? "--- the config ---" : "--- the Caddyfile ---");
    out(plan.steps[0].content);
    out("nothing written. re-run with --install (as root) to write it.");
    return 0;
  }

  for (const step of plan.steps) {
    try {
      if (step.kind === "write") await write(step.path, step.content);
      else if (step.kind === "mkdir") await mkdir(step.path, { recursive: true });
      else if (step.kind === "run" && runner) {
        const result = await runner(step.command, step.args);
        if (!result?.ok) {
          out(`! ${step.command} failed — stopping before anything else changes`);
          return 1;
        }
      }
    } catch (err) {
      out(`! ${step.kind} ${step.path || step.command} failed: ${err.message}`);
      out(err.code === "EACCES" ? "  (needs root — rerun with sudo)" : "");
      return 1;
    }
  }

  out(rest.includes("--reload")
    ? `${name} is live on this machine.`
    : `config installed for ${name} — not live until the server reloads:\n  ${SERVERS[plan.server].reload.join(" ")}`);
  out(`  check it here:      curl -I -H "Host: ${name}" http://127.0.0.1/`);
  out(`  and from anywhere:  curl -I https://pit.moshcode.sh/n/${name}`);
  return 0;
}
