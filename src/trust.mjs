// Making a Moshpit name work in a stock client, on this machine.
//
// No certificate authority will ever vouch for `seo.rank`. The CA/Browser Forum
// Baseline Requirements banned issuance for non-IANA names — it stopped in
// November 2015 and the survivors were revoked by October 2016 — and a CA in a
// root store that issued for one would be distrusted for doing it. The rule is
// the penalty, so this is not a matter of persuasion or of trying harder.
//
// moshpit-proxy already solves it: it checks the origin's key against the pin
// the registry published for that name, then re-signs with a root it generated
// on this machine, because re-stating the result is the only language a stock
// client accepts. What was missing is that nobody wired it up — `dns enable`
// pointed names at the resolver and stopped, so they resolved and then failed
// at TLS, which is the shape a person reads as "still broken".
//
// This is the wiring. The one thing it must never do is install a root that
// could vouch for the clearnet, so that is checked here rather than assumed:
// see requireNameConstraints below.

import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

/** Where moshpit-proxy generates its root on first run. */
export function caPath({ home = os.homedir(), dir = null } = {}) {
  return path.join(dir || path.join(home, ".moshpit"), "ca", "ca.crt");
}

/** Ask the shell where a user's home is, rather than assuming a layout. */
function expandHome(user) {
  try {
    // `~user` expansion reads passwd, so this is right on macOS (/Users) and on
    // a machine where someone's home is not under /home at all.
    const home = execFileSync("sh", ["-c", `printf %s ~${user}`], {
      encoding: "utf8", timeout: 5000,
    }).trim();
    return home && home !== `~${user}` ? home : null;
  } catch {
    return null;
  }
}

/**
 * The home of the person who ran the command, not of the account running it.
 *
 * Everything here is keyed off a home directory: the root moshpit-proxy wrote
 * to `~/.moshpit`, and the NSS database Chrome and Firefox actually read at
 * `~/.pki/nssdb`. But `dns enable` needs root, and since #274 it escalates
 * itself — so by the time this runs `os.homedir()` is `/root`.
 *
 * Using it would look for the root in a directory moshpit-proxy never wrote to
 * and report "no local root", or install into root's NSS store and report
 * success for a browser profile nobody uses. That is the same $HOME-under-sudo
 * trap #272 and #274 closed, and it is worth closing once here rather than
 * discovering it a third time.
 */
export function operatorHome({ env = process.env, homedir = () => os.homedir(), expand = expandHome } = {}) {
  const who = env.SUDO_USER || env.DOAS_USER;
  if (!who || who === "root") return env.HOME || homedir();
  return expand(who) || env.HOME || homedir();
}

/**
 * The `X509v3 Name Constraints` extension, split into what it permits and what
 * it excludes.
 *
 * Parsed rather than string-matched because the two lists mean opposite things
 * and a substring search cannot tell them apart: `DNS:.hacker` reads the same
 * under `Permitted:` as under `Excluded:`, and treating the second as the first
 * accepts a root that constrains nothing.
 */
export function parseNameConstraints(text) {
  const lines = String(text || "").split("\n");
  const start = lines.findIndex((l) => /X509v3 Name Constraints:/i.test(l));
  if (start === -1) return null;

  const indent = lines[start].search(/\S/);
  const permitted = [];
  const excluded = [];
  let bucket = null;

  for (const line of lines.slice(start + 1)) {
    if (!line.trim()) continue;
    // The block ends at the next thing printed at or left of its own indent:
    // the following extension, or the signature.
    if (line.search(/\S/) <= indent) break;
    if (/^\s*Permitted:/i.test(line)) { bucket = permitted; continue; }
    if (/^\s*Excluded:/i.test(line)) { bucket = excluded; continue; }
    const dns = /^\s*DNS:(\S+)/i.exec(line);
    if (dns && bucket) bucket.push(dns[1].toLowerCase());
  }

  return {
    critical: /X509v3 Name Constraints:\s*critical/i.test(lines[start]),
    permitted,
    excluded,
  };
}

/**
 * Is this a root we are willing to put in a trust store?
 *
 * The whole argument for installing a local CA rests on one extension. A root
 * with `nameConstraints` permitting only Moshpit endings can, at absolute
 * worst, forge a name its holder already controls. A root without them can
 * forge your bank, and installing one would be a genuine hole dressed up as a
 * convenience.
 *
 * So this is a gate, not a report. moshpit-proxy sets the constraint today and
 * tests it; that is exactly why this must not trust it to keep doing so — a
 * silent regression upstream would otherwise become a silent regression in
 * every machine that ran `dns enable`.
 */
export function requireNameConstraints(text, { tlds = [] } = {}) {
  // `text` is what `openssl x509 -noout -text` prints, not the PEM. The PEM
  // body is base64: an extension cannot be seen in it, and a check that read
  // the file directly would find no constraints in a constrained root and no
  // constraints in an unconstrained one — passing or failing everything.
  const body = String(text || "");
  if (!/Certificate:|Signature Algorithm:/i.test(body)) {
    return { ok: false, kind: "unreadable", why: "could not read the certificate — openssl printed nothing usable" };
  }
  const constraints = parseNameConstraints(body);
  if (!constraints) {
    return {
      ok: false,
      kind: "unconstrained",
      why: "the root carries no name constraints — it could vouch for any name, not just Moshpit",
    };
  }
  // Non-critical constraints are advisory: a verifier is free to ignore an
  // extension it does not recognise, which turns the guarantee into a comment.
  if (!constraints.critical) {
    return { ok: false, kind: "unconstrained", why: "the name constraints are not marked critical, so a verifier may ignore them" };
  }
  // RFC 5280 §4.2.1.10: constraints bind only the name *types* they mention. A
  // root whose DNS entries are all exclusions — or whose permitted subtree
  // names some other type entirely — leaves every DNS name permitted, so
  // `excluded;DNS:.hacker` alone is an unconstrained root wearing the word
  // "constraints". Requiring a permitted DNS subtree is what makes the rest of
  // this check mean anything.
  if (!constraints.permitted.length) {
    return {
      ok: false,
      kind: "unconstrained",
      why: "the root permits no DNS subtree, so every name it does not exclude is allowed — it could vouch for any name",
    };
  }

  const bare = (entry) => entry.replace(/^\./, "");
  const permits = (tld) => constraints.permitted.some((entry) => bare(entry) === String(tld).toLowerCase());

  const missing = tlds.filter((tld) => !permits(tld));
  if (missing.length) {
    return { ok: false, kind: "out-of-step", why: `the root does not permit ${missing.join(", ")}` };
  }
  // And nothing beyond them. One `DNS:.com` in the permitted subtree is the
  // whole hole this gate exists to close, and it would otherwise sail through
  // on the strength of the endings sitting next to it.
  const claimed = new Set(tlds.map((t) => String(t).toLowerCase()));
  const foreign = constraints.permitted.filter((entry) => !claimed.has(bare(entry)));
  if (foreign.length) {
    return {
      ok: false,
      kind: "out-of-step",
      why: `the root also permits ${foreign.join(", ")}, which is not an ending we resolve — it reaches past Moshpit`,
    };
  }
  return { ok: true, why: "constrained to Moshpit endings" };
}

/**
 * The trust stores on this machine, and what each one costs to write to.
 *
 * Deliberately separate entries rather than one "install everywhere" step,
 * because they do not fail together and conflating them produces the worst
 * report: NSS succeeds without root, the system store needs it, and a summary
 * that says "installed" when curl still cannot verify is how someone concludes
 * the whole thing is broken again.
 */
export function trustStores({ platform = process.platform, home = os.homedir(), caFile } = {}) {
  const file = caFile || caPath({ home });
  const stores = [];

  if (platform === "darwin") {
    stores.push({
      id: "macos-keychain",
      label: "the system keychain (curl, Safari, Chrome)",
      needsRoot: true,
      command: "security",
      args: ["add-trusted-cert", "-d", "-r", "trustRoot", "-k", "/Library/Keychains/System.keychain", file],
    });
    return stores;
  }

  if (platform === "linux") {
    // User-level and needs no privileges at all, which makes it the half that
    // can always be done — Chrome and Firefox read it, curl does not.
    stores.push({
      id: "nss",
      label: "the NSS store (Chrome, Firefox)",
      needsRoot: false,
      // The operator's database, even when root is doing the writing — which is
      // why it is also handed back afterwards. Files left owned by root here
      // are worse than not writing them: the browser silently stops being able
      // to update its own store.
      ownedDir: path.join(home, ".pki", "nssdb"),
      command: "certutil",
      args: ["-d", `sql:${path.join(home, ".pki", "nssdb")}`, "-A", "-t", "C,,", "-n", "Moshpit Local CA", "-i", file],
    });
    stores.push({
      id: "system",
      label: "the system store (curl, wget, anything using OpenSSL)",
      needsRoot: true,
      // Two steps rather than one: the copy is the install, and the refresh is
      // what makes it take effect. Reporting them together would hide which
      // one failed.
      copyTo: "/usr/local/share/ca-certificates/moshpit-local-ca.crt",
      command: "update-ca-certificates",
      args: [],
    });
    return stores;
  }

  return stores;
}

/**
 * What `dns enable` should do about trust, given what it found.
 *
 * Pure, so the decision is testable without a certificate, a trust store or a
 * machine whose TLS is a real thing to break.
 */
/** How to ask openssl what is actually in the root. */
export function describeCertificateCommand(file) {
  return { command: "openssl", args: ["x509", "-noout", "-text", "-in", file] };
}

export function trustPlan({
  caText = null,
  tlds = [],
  platform = process.platform,
  home = os.homedir(),
  caFile = null,
  isRoot = false,
  haveCertutil = true,
} = {}) {
  const file = caFile || caPath({ home });

  if (!caText) {
    return {
      ok: false,
      steps: [],
      why: `no local root at ${file} — moshpit-proxy generates one on its first run`,
    };
  }

  const constrained = requireNameConstraints(caText, { tlds });
  if (!constrained.ok) {
    // Refused rather than warned. A warning here would be read past.
    return { ok: false, refused: true, kind: constrained.kind, steps: [], why: constrained.why };
  }

  const steps = [];
  const skipped = [];
  for (const store of trustStores({ platform, home, caFile: file })) {
    if (store.id === "nss" && !haveCertutil) {
      skipped.push({ ...store, why: "certutil is not installed (Debian/Ubuntu: libnss3-tools)" });
      continue;
    }
    if (store.needsRoot && !isRoot) {
      skipped.push({ ...store, why: "needs root" });
      continue;
    }
    steps.push(store);
  }

  return { ok: true, steps, skipped, file, why: constrained.why };
}

/**
 * What to do about a refusal, which depends entirely on which one it is.
 *
 * `out-of-step` is the common one and is not a security event: the root was
 * generated when a different set of endings was claimed, so it is stale rather
 * than dangerous. Regenerating costs one command, and without saying so the
 * strict check reads as a dead end — which is how a safety gate ends up being
 * disabled with --no-trust instead of satisfied.
 *
 * `unconstrained` is the dangerous one, and deliberately has no workaround
 * offered: the answer is a fixed root, never a way around the check.
 */
export function refusalRemedy(kind, file) {
  if (kind === "out-of-step") {
    return [
      "the root is older than the endings claimed now — regenerating it is enough:",
      `  rm -rf ${path.dirname(file)} && moshpit-proxy   # writes a fresh root`,
      "then re-run `moshcode dns enable`.",
    ];
  }
  if (kind === "unreadable") {
    return [`could not read ${file} — check it is a certificate and openssl is installed.`];
  }
  return [
    "moshcode will not put a root that can vouch for names outside Moshpit",
    "into your trust store. Names will resolve but not pass TLS until the",
    "root is regenerated with name constraints. This is not overridable.",
  ];
}

/** Run a command, never throwing — the caller reports, it does not crash. */
async function run(command, args) {
  const { execFile } = await import("node:child_process");
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 30000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

/**
 * The trust half of `dns enable`, reported step by step.
 *
 * Every outcome here is non-fatal on purpose. DNS has already been switched and
 * verified by the time this runs, so failing the whole command over a trust
 * store would roll back working resolution to fix a certificate — trading the
 * larger thing for the smaller one. What it must not do is claim success it did
 * not have, since that is what sends someone back to `curl` to be told the
 * certificate is self-signed.
 */
export async function applyTrust(tlds, out, deps = {}) {
  const {
    readFile = async (f) => (await import("node:fs/promises")).readFile(f, "utf8"),
    runner = run,
    env = process.env,
    // The operator's home, not root's — see operatorHome. Every path below
    // depends on getting this right, and `dns enable` always runs escalated.
    home = operatorHome({ env }),
    platform = process.platform,
    uid = typeof process.getuid === "function" ? process.getuid() : 0,
  } = deps;
  const owner = env.SUDO_USER || env.DOAS_USER || null;

  const file = caPath({ home });
  out("");
  out("trust  (so a stock client accepts a name no CA will ever sign for)");

  const exists = await readFile(file).then(() => true, () => false);
  if (!exists) {
    out(`  --   no local root at ${file}`);
    out("       moshpit-proxy generates one on its first run: https://github.com/profullstack/moshpit-proxy");
    return { ok: false, why: "no root yet" };
  }

  const describe = describeCertificateCommand(file);
  const described = await runner(describe.command, describe.args);
  // `certutil -H` prints help and exits non-zero, so its exit code says nothing
  // about whether it is installed. Presence is the actual question.
  const haveCertutil = (await runner("which", ["certutil"])).ok;
  const plan = trustPlan({
    caText: described.ok ? described.stdout : null,
    tlds, platform, home, caFile: file, isRoot: uid === 0, haveCertutil,
  });

  if (!plan.ok) {
    // A refusal is the feature working, so it says which it is.
    out(plan.refused ? `  STOP ${plan.why}` : `  --   ${plan.why}`);
    // ...and then how to get past it. A gate that only says "no" is a gate
    // people work around, and the two refusals are nothing alike: one is a
    // root that must never be installed, the other a root that is simply
    // older than the endings claimed today. Telling them apart is the
    // difference between "this is dangerous" and "regenerate it".
    for (const line of refusalRemedy(plan.kind, file)) out(`       ${line}`);
    return { ok: false, why: plan.why };
  }

  out(`  ok   ${file} — ${plan.why}`);
  for (const step of plan.steps) {
    if (step.copyTo) {
      const copied = await runner("cp", [file, step.copyTo]);
      if (!copied.ok) {
        out(`  FAIL ${step.label} — ${copied.stderr.split("\n")[0] || "could not copy the root"}`);
        continue;
      }
    }
    const done = await runner(step.command, step.args);
    if (!done.ok) {
      out(`  FAIL ${step.label} — ${done.stderr.split("\n")[0] || `${step.command} failed`}`);
      continue;
    }
    // Written as root into the operator's directory, so hand it back. Left
    // root-owned, the browser cannot update its own store afterwards — a
    // failure that shows up long after this command, looking unrelated.
    if (step.ownedDir && owner && uid === 0) {
      const owned = await runner("chown", ["-R", `${owner}:`, step.ownedDir]);
      if (!owned.ok) out(`  --   ${step.ownedDir} is left owned by root — chown -R ${owner}: ${step.ownedDir}`);
    }
    out(`  ok   installed into ${step.label}`);
  }
  for (const step of plan.skipped || []) {
    out(`  --   ${step.label} — ${step.why}`);
    if (step.needsRoot) out(`       re-run with root to cover it: sudo moshcode dns enable`);
  }
  return { ok: true, installed: plan.steps.length, skipped: (plan.skipped || []).length };
}

/**
 * A one-line proof that the whole chain works, or the reason it does not.
 *
 * The check is deliberately a plain HTTPS fetch with nothing relaxed: no `-k`,
 * no pin passed on the command line. Anything less would pass in exactly the
 * situation this feature exists to fix.
 */
export async function verifyStockTls(name, { fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`https://${name}/`, { signal: controller.signal, redirect: "manual" });
    return { ok: true, status: res.status };
  } catch (err) {
    const why = err?.cause?.code || err?.code || err?.message || String(err);
    return { ok: false, why: String(why) };
  } finally {
    clearTimeout(timer);
  }
}
