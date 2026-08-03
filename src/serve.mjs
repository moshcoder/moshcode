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
import { fileURLToPath } from "node:url";

import { classifySource, listTemplates } from "./templates.mjs";
import { tldOf, keyPaths, certificateCommand, pinFromCertificate, publishPin } from "./pins.mjs";
import { loadCreds } from "./auth.mjs";

/** The registry credential: explicit env first, then `moshcode login`. */
const token = () => process.env.MOSHCODE_API_KEY || loadCreds()?.token || "";

/**
 * What a freshly installed site contains before anyone has written anything.
 *
 * A new root with nothing in it serves 404, which is indistinguishable from a
 * broken install at exactly the moment someone is trying to tell those apart.
 * So the default is a page that says the name resolved and the server answered
 * — the two facts a first visit is a test of — and says what to replace.
 *
 * caddy-static is the starter because it is the one with no runtime: seeding a
 * Bun service would leave a root whose index.html is a lie about what is
 * running. Pick another with --template, or --empty to seed nothing.
 */
export const DEFAULT_TEMPLATE = "caddy-static";

/**
 * Which starter to seed, and whether that answer is usable at all.
 *
 * `--template` is checked rather than trusted, because every way of getting it
 * wrong lands in the same place: the directory does not exist, the seed step is
 * quietly dropped, and the root is left empty — which serves the 404 the
 * seeding exists to prevent, after reporting that everything worked. A typo has
 * to be louder than that.
 *
 * The shape check is templates.mjs's existing rule rather than a new one: a
 * bundled name is one label, so anything carrying a slash or a dot is not a
 * name and must not be joined into a path underneath examples/templates.
 */
export async function chooseTemplate(rest = [], { list = listTemplates } = {}) {
  if (rest.includes("--empty")) return { ok: true, template: null };

  const at = rest.indexOf("--template");
  if (at < 0) return { ok: true, template: DEFAULT_TEMPLATE };

  const asked = rest[at + 1];
  // `--template --install` reads the next flag as the starter, and the flag it
  // ate still takes effect, so the site installs with nothing in its root.
  if (asked === undefined || asked.startsWith("-")) {
    return { ok: false, error: "--template takes the name of a starter" };
  }
  if (classifySource(asked).kind !== "bundled") {
    return { ok: false, error: `${JSON.stringify(asked)} is not a starter name` };
  }

  const available = (await list()).map((t) => t.name);
  if (!available.includes(asked)) {
    return { ok: false, error: `there is no starter called ${JSON.stringify(asked)}`, available };
  }
  return { ok: true, template: asked };
}

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
export function nginxSite({ name, root, proxy, tls = null }) {
  const body = proxy
    ? [`\tlocation / {`, `\t\tproxy_pass http://127.0.0.1:${proxy};`, `\t\tproxy_set_header Host $host;`, `\t\tproxy_set_header X-Moshpit-Name $host;`, `\t}`]
    : [`\troot ${root};`, `\tindex index.html;`, ``, `\tlocation / {`, `\t\ttry_files $uri $uri/ =404;`, `\t}`];

  const plain = [
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
  ];

  // The TLS half, when this ending has a key. Both halves serve the site;
  // neither redirects to the other. That is the whole point — a client takes
  // whichever it can verify, and there is no arrangement where one of them
  // sends a client somewhere it cannot follow.
  const secure = tls
    ? [
        "",
        "# The same site over TLS, for clients that can verify it.",
        "#",
        "# Verified against the registry's published pin rather than a CA chain,",
        "# because no CA will issue for an ending outside the DNS root. The pin is",
        "# a stronger statement than a CA's: it names the exact key, where a CA",
        "# only attests that somebody proved control to some issuer.",
        "#",
        `# pin: ${tls.pin}`,
        "server {",
        "\tlisten 443 ssl;",
        "\tlisten [::]:443 ssl;",
        "\thttp2 on;",
        "",
        `\tserver_name ${name};`,
        "",
        `\tssl_certificate     ${tls.cert};`,
        `\tssl_certificate_key ${tls.key};`,
        "\tssl_protocols TLSv1.3;",
        "\tssl_prefer_server_ciphers off;",
        // Hybrid post-quantum, matching what is already deployed. A DNS-adjacent
        // request names every site someone is about to visit, which is worth as
        // much to an attacker recording now to decrypt later as the pages are.
        "\tssl_conf_command Groups X25519MLKEM768:X25519:P-256;",
        "\tssl_session_tickets off;",
        "",
        ...body,
        "",
        "\tlocation ~ /\\. {",
        "\t\tdeny all;",
        "\t}",
        "}",
      ]
    : [];

  return [
    `# ${name} — written by \`moshcode site\`.`,
    "#",
    "# Port 80 never redirects to 443, deliberately. No CA will issue for an",
    "# ending outside the DNS root, so a stock browser or curl cannot verify the",
    "# certificate here however good it is — and a redirect would send them to a",
    "# page they can never load. The gateway forwards the status without the",
    "# Location header, which turns it into a 301 to nowhere.",
    "#",
    tls
      ? "# So both ports serve the site: plain HTTP for anything, pin-verified TLS"
      : "# TLS is absent because this ending has no key yet — `--tls` creates one",
    tls
      ? "# for clients that check the registry's pin. The client picks."
      : "# and publishes its pin, after which this file gains a 443 block.",
    "#",
    "# Both listen lines matter. Resolver users arrive over IPv6 because that is",
    "# what the name points at; everyone else arrives via pit.moshcode.sh, which",
    "# fetches this server-side.",
    ...plain,
    ...secure,
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
 * The TLS story for a name: reuse the ending's key, or mint one.
 *
 * One key per *ending*, not per name, because that is what the registry pins —
 * you claim `.eggs`, not `scrambled.eggs`. A key per name would mean a pin
 * published per site and every name under the ending accepting all of them:
 * strictly more keys able to impersonate each other, for no isolation gained.
 *
 * When the key already exists its pin is read back off disk rather than
 * assumed, so a second name under the same ending publishes the pin that is
 * actually being served rather than one we believe should be.
 */
export async function tlsFor(name, { dir = "/etc/ssl/moshpit", readFile = fs.readFile } = {}) {
  const tld = tldOf(name);
  if (!tld) return null;
  const paths = keyPaths(tld, dir);
  if (!paths) return null;

  try {
    const existing = await readFile(paths.cert, "utf8");
    return { tld, dir, key: paths.key, cert: paths.cert, pin: pinFromCertificate(existing), create: null };
  } catch {
    // No key yet. The command is returned rather than run, so `--install`
    // stays the only thing that touches the machine.
    //
    // The pin is null here and read back from the certificate after openssl
    // has run: openssl mints the key itself, so predicting the pin would mean
    // publishing a value we hoped for rather than the one being served.
    return { tld, dir, key: paths.key, cert: paths.cert, pin: null, create: certificateCommand({ name, tld, paths }) };
  }
}

/**
 * What serving this name would change.
 *
 * Returned rather than done, so `--write` is the only thing that touches the
 * machine and everything before it can be read first.
 */
export function servePlan({ name, server, root, proxy, reload = false, seed = null, tls = null }) {
  const target = SERVERS[server];
  if (!target) return { ok: false, error: `no supported web server found — install nginx or caddy` };

  const file = path.join(target.dir, `${name}${target.ext}`);
  // Caddy has no pinned-TLS story here: it wants to provision a certificate
  // from a CA, which is exactly what cannot happen for these endings.
  const useTls = server === "nginx" ? tls : null;
  const content = server === "nginx" ? nginxSite({ name, root, proxy, tls: useTls }) : caddySite({ name, root, proxy });

  const steps = [];
  if (useTls?.create) {
    // Before the config that references them, so a failed key never leaves
    // nginx pointing at a certificate that does not exist — which it refuses
    // to start with, taking every other site on the box down with it.
    steps.push({ kind: "mkdir", path: useTls.dir, why: "somewhere for the ending's key to live" });
    steps.push({
      kind: "run",
      command: useTls.create.cmd,
      args: useTls.create.args,
      why: `a key for .${useTls.tld} — one per ending, which is what the registry pins`,
    });
  }
  steps.push({ kind: "write", path: file, content, why: `answer to ${name} without redirecting it` });
  if (!proxy) {
    steps.push({ kind: "mkdir", path: root, why: "somewhere for the files to live" });
    // Only when the root is new. Seeding over someone's site would be the
    // worst kind of helpful.
    if (seed) steps.push({ kind: "seed", path: root, from: seed, why: "a page that says it worked, rather than a 404" });
  }
  // Validation runs whether or not we reload: a config that does not parse is
  // worth knowing about now rather than the next time anything touches nginx,
  // which may be a reboot and may be someone else.
  if (target.check) steps.push({ kind: "run", command: target.check[0], args: target.check.slice(1), why: "a config that does not parse is a problem now, not later" });
  // Reloading is what makes the site live, so it is opt-in. Installing config
  // and activating it are different decisions: the first is reversible by
  // deleting a file, the second changes what a running server does to traffic.
  if (reload) steps.push({ kind: "run", command: target.reload[0], args: target.reload.slice(1), why: "make it live now" });

  // Last, and only once the key exists on disk. Publishing a pin for a key
  // that failed to generate would tell every client to expect a certificate
  // this machine cannot present — worse than no pin, because a pin that does
  // not match is a hard failure rather than a missing one.
  if (useTls) {
    steps.push({
      kind: "publish-pin",
      tld: useTls.tld,
      pin: useTls.pin,
      why: `so clients can verify .${useTls.tld} without a CA`,
    });
  }

  return { ok: true, server, file, root: proxy ? null : root, proxy: proxy ?? null, tls: useTls, steps };
}

const USAGE = `moshcode site — install web-server config for a Moshpit name

  moshcode site <name>                     show what would be installed
  moshcode site <name> --install           write the config (needs root)
  moshcode site <name> --install --reload  ...and make it live now
  moshcode site <name> --proxy 3000        reverse-proxy a local port instead
  moshcode site <name> --root <dir>        where the files live
  moshcode site <name> --template <name>   which starter page to seed (see
                                           \`moshcode template list\`)
  moshcode site <name> --empty             seed nothing; serve a 404 until you
                                           put something there
  moshcode site <name> --tls               also serve TLS, and publish the key
                                           pin so clients can verify it

moshcode does not serve anything itself. This writes a config file for the web
server already on this machine; nginx or Caddy does the serving.

The name still has to point at this machine — set that in the Pit, and check
it with \`moshcode dns resolve <name>\`. This only makes the box answer to it.`;

/**
 * Run one of the plan's commands.
 *
 * A real default, because the alternative was worse than it looked: with no
 * runner the execution loop skipped every `run` step in silence and then
 * printed "is live on this machine". `nginx -t` never validated, `systemctl
 * reload` never reloaded, and the config that had just been written was not
 * the config being served — a lie that is invisible until someone reloads
 * nginx for an unrelated reason, hours or reboots later.
 */
async function defaultRunner(command, args) {
  const { execFile } = await import("node:child_process");
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 60_000 }, (error, _stdout, stderr) => {
      resolve({ ok: !error, code: error?.code ?? 0, stderr: String(stderr || "").trim() });
    });
  });
}

export async function serveCommand(args = [], out = console.log, deps = {}) {
  const { detect = detectServer, write = fs.writeFile, mkdir = fs.mkdir, copy = fs.cp, runner = defaultRunner } = deps;
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
  const choice = await chooseTemplate(rest);
  if (!choice.ok) {
    out(`moshcode site: ${choice.error}`);
    if (choice.available) out(`  bundled: ${choice.available.join(", ")}`);
    out("  `moshcode template list` shows them all, or use --empty to seed nothing.");
    return 1;
  }
  const template = choice.template;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const seedFrom = template ? path.join(here, "..", "examples", "templates", template, "site") : null;
  // An empty root serves 404, which reads as a broken install. Seed only when
  // there is nothing there to overwrite.
  const rootEmpty = !(await fs.readdir(root).catch(() => []))?.length;
  const seed = seedFrom && rootEmpty && (await fs.stat(seedFrom).catch(() => null)) ? seedFrom : null;

  const server = await detect();
  if (server && typeof server === "object" && server.unknown) {
    out(`moshcode site: port 80 is held by something this cannot configure`);
    out(`  ${server.unknown}`);
    out("  install nginx or caddy, or add the equivalent block by hand.");
    return 1;
  }
  // Opt-in, because it writes a private key and publishes to the registry —
  // two things that should not happen because someone ran the default.
  const tls = rest.includes("--tls") ? await tlsFor(name) : null;
  const plan = servePlan({ name, server, root, proxy: proxy ? Number(proxy) : null, reload: rest.includes("--reload"), seed, tls });
  if (!plan.ok) {
    out(`moshcode site: ${plan.error}`);
    return 1;
  }

  const ports = plan.tls ? "ports 80 + 443, pin-verified TLS" : "port 80, plain HTTP";
  out(`${name} → ${plan.proxy ? `127.0.0.1:${plan.proxy}` : plan.root}  (${plan.server}, ${ports})`);
  out("");
  for (const step of plan.steps) {
    const what = step.kind === "run"
      ? `${step.command} ${step.args.join(" ")}`
      : step.kind === "publish-pin"
        ? `.${step.tld}`
        : step.path;
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
      else if (step.kind === "seed") await copy(step.from, step.path, { recursive: true, force: false });
      else if (step.kind === "run") {
        if (!runner) {
          // Silence here is how a config gets written referencing a key that
          // was never generated, after reporting success.
          out(`! cannot run ${step.command} — nothing would validate or take effect`);
          return 1;
        }
        const result = await runner(step.command, step.args);
        if (!result?.ok) {
          out(`! ${step.command} failed — stopping before anything else changes`);
          if (result?.stderr) out(`  ${result.stderr.split("\n")[0]}`);
          return 1;
        }
      } else if (step.kind === "publish-pin") {
        // Read back off the certificate rather than using the value planned:
        // openssl minted the key, so this is the only way to publish what is
        // actually being served instead of what we expected to be.
        const served = await fs.readFile(plan.tls.cert, "utf8").then(pinFromCertificate).catch(() => step.pin);
        const result = await publishPin({ tld: step.tld, pin: served, token: token(), note: `moshcode site ${name}` });
        if (result.ok) {
          out(result.already ? `  pin already published for .${step.tld}` : `  pin published for .${step.tld}`);
        } else {
          // Not fatal. The site works; only its TLS is unverifiable, and
          // failing the whole install here would leave a machine configured
          // and a user told nothing worked.
          out(`  ! pin not published: ${result.error}`);
          out(result.needsAuth
            ? `    the site is up, but TLS cannot be verified until it is. run \`moshcode login\`, then:`
            : `    the site is up, but TLS cannot be verified until it is. retry with:`);
          out(`    moshcode site ${name} --tls --install`);
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
