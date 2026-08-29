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
      // The one store that can only be told with the certificate in hand:
      // `remove-trusted-cert` takes a file, not a nickname. `needsFile` is what
      // lets the undo say so out loud instead of leaving an anchor behind and
      // reporting success.
      remove: {
        needsFile: true,
        command: "security",
        args: ["remove-trusted-cert", "-d", file],
      },
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
      // By nickname, so the anchor can still be withdrawn after the root file
      // itself is gone — which is the ordinary case, since a person who wants
      // rid of this deletes the certificate first and asks questions after.
      remove: {
        command: "certutil",
        args: ["-d", `sql:${path.join(home, ".pki", "nssdb")}`, "-D", "-n", "Moshpit Local CA"],
      },
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
      // Delete the copy, then rebuild. `--fresh` rather than a bare refresh:
      // the bare form adds what is new, and it is the rebuild that drops the
      // symlink for a source file that is no longer there.
      remove: {
        removeFile: "/usr/local/share/ca-certificates/moshpit-local-ca.crt",
        command: "update-ca-certificates",
        args: ["--fresh"],
      },
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
 * What `dns disable` should do about trust.
 *
 * Deliberately not `trustPlan(...).steps.reverse()`. Installing is gated on the
 * root being safe to install — name constraints, a certificate that parses —
 * and none of that has any bearing on taking it back out: a root that should
 * never have been trusted is the *most* important one to be able to withdraw.
 * So this plan asks two questions only, whether the store can be reached and
 * whether the undo needs the certificate file, and never refuses.
 *
 * Pure, like trustPlan, so `dns disable` can be tested without a trust store.
 */
export function untrustPlan({
  platform = process.platform,
  home = os.homedir(),
  caFile = null,
  isRoot = false,
  haveCertutil = true,
  haveFile = true,
} = {}) {
  const file = caFile || caPath({ home });
  const steps = [];
  const skipped = [];

  for (const store of trustStores({ platform, home, caFile: file })) {
    if (!store.remove) {
      skipped.push({ ...store, why: "this build knows how to install it but not how to remove it" });
      continue;
    }
    if (store.id === "nss" && !haveCertutil) {
      skipped.push({ ...store, why: "certutil is not installed (Debian/Ubuntu: libnss3-tools)" });
      continue;
    }
    if (store.needsRoot && !isRoot) {
      skipped.push({ ...store, why: "needs root" });
      continue;
    }
    // The macOS case. Saying "the root is gone, so the anchor cannot be named"
    // is worth a line, because the alternative is a machine that keeps trusting
    // a certificate nobody can produce any more.
    if (store.remove.needsFile && !haveFile) {
      skipped.push({ ...store, why: `the root at ${file} is gone, and this store can only be told with it` });
      continue;
    }
    steps.push(store);
  }

  return { ok: true, steps, skipped, file };
}

/**
 * The trust half of `dns disable` — take back what `applyTrust` installed.
 *
 * Non-fatal throughout, for the same reason its counterpart is: resolution has
 * already been put back by the time this runs, and failing the whole command
 * over a trust store would undo working DNS to fix a certificate. What it must
 * not do is report a removal it did not achieve, since a trust anchor believed
 * gone is worse than one known to be present.
 */
export async function applyUntrust(out, deps = {}) {
  const {
    readFile = async (f) => (await import("node:fs/promises")).readFile(f, "utf8"),
    runner = run,
    env = process.env,
    home = operatorHome({ env }),
    platform = process.platform,
    uid = typeof process.getuid === "function" ? process.getuid() : 0,
  } = deps;
  const owner = env.SUDO_USER || env.DOAS_USER || null;

  const file = caPath({ home });
  const haveFile = await readFile(file).then(() => true, () => false);
  const plan = untrustPlan({
    platform, home, caFile: file, isRoot: uid === 0,
    haveCertutil: (await runner("which", ["certutil"])).ok,
    haveFile,
  });

  if (!plan.steps.length && !plan.skipped.length) return { ok: true, removed: 0, skipped: 0 };

  out("");
  out("trust  (taking the local root back out)");

  let removed = 0;
  for (const step of plan.steps) {
    const undo = step.remove;
    if (undo.removeFile) {
      // `rm -f`: the copy not being there is the state we are trying to reach,
      // so its absence is success rather than something to report.
      const gone = await runner("rm", ["-f", undo.removeFile]);
      if (!gone.ok) {
        out(`  FAIL ${step.label} — ${gone.stderr.split("\n")[0] || `could not remove ${undo.removeFile}`}`);
        continue;
      }
    }
    const done = await runner(undo.command, undo.args);
    if (!done.ok) {
      const first = done.stderr.split("\n")[0] || "";
      // certutil says this when the nickname is not in the database, which is
      // the same end state as a successful removal and must not read as a
      // failure — most often it means `dns disable` is being run twice.
      if (/SEC_ERROR_BAD_DATA|not found|PR_FILE_NOT_FOUND/i.test(first)) {
        out(`  ok   ${step.label} — was not there`);
        continue;
      }
      out(`  FAIL ${step.label} — ${first || `${undo.command} failed`}`);
      continue;
    }
    if (step.ownedDir && owner && uid === 0) {
      const owned = await runner("chown", ["-R", `${owner}:`, step.ownedDir]);
      if (!owned.ok) out(`  --   ${step.ownedDir} is left owned by root — chown -R ${owner}: ${step.ownedDir}`);
    }
    removed++;
    out(`  ok   removed from ${step.label}`);
  }

  for (const step of plan.skipped) {
    out(`  --   ${step.label} — ${step.why}`);
    if (step.needsRoot && uid !== 0) out("       re-run with root to cover it: sudo moshcode dns disable");
  }

  return { ok: true, removed, skipped: plan.skipped.length };
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

/* ------------------------------------------------ trusting one name directly */

/**
 * SHA-256 over the SubjectPublicKeyInfo, base64 — RFC 7469's pin format.
 *
 * Over the key rather than the certificate, so re-issuing for the same key (a
 * longer expiry, an added name) does not invalidate a pin anybody holds.
 */
export async function spkiPin(publicKeyPem) {
  const crypto = await import("node:crypto");
  const der = crypto.createPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
  return crypto.createHash("sha256").update(der).digest("base64");
}

/**
 * The pin of the key inside a certificate.
 *
 * Read with node's own X509 parser rather than by shelling out to openssl a
 * second time: the pin is the value the whole decision turns on, and piping a
 * PEM back through a shell to extract it adds quoting and a second process to
 * the one step that must not go wrong quietly.
 */
export async function pinFromCertificate(pem) {
  const crypto = await import("node:crypto");
  const cert = new crypto.X509Certificate(pem);
  const der = cert.publicKey.export({ type: "spki", format: "der" });
  return crypto.createHash("sha256").update(der).digest("base64");
}

/** The pins the registry publishes for a name. */
export async function publishedPins(name, { registryBase = "https://pit.moshcode.sh", fetchImpl = fetch } = {}) {
  const url = `${registryBase.replace(/\/+$/, "")}/api/moshpit/pins?name=${encodeURIComponent(name)}`;
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`registry answered ${res.status}`);
  const json = await res.json();
  return Array.isArray(json?.pins) ? json.pins : [];
}

/**
 * Is this certificate the one the registry vouches for?
 *
 * The entire security of installing a leaf rests on this comparison, so it is
 * a gate rather than a report. Without it, `trust <name>` would install
 * whatever answered the socket — which is the definition of trusting an
 * attacker who can reach the port first.
 *
 * Any published pin matches, not just the first: the registry lists the old
 * pin alongside the new one during a key rotation precisely so a key can change
 * without a flag day.
 */
export function pinAccepted(pin, published) {
  if (!pin || !Array.isArray(published) || !published.length) {
    return { ok: false, why: "the registry publishes no pin for this name — nothing vouches for the certificate" };
  }
  return published.includes(pin)
    ? { ok: true, why: "the served key matches a pin the registry publishes" }
    : { ok: false, why: `the served key (${pin}) is not among the ${published.length} pin(s) the registry publishes` };
}

/**
 * Where a trusted leaf is written, per name.
 *
 * One file per name rather than a bundle: removing trust for a single name has
 * to be removing a single file, and a name is not something to hand-edit out of
 * a concatenation.
 */
export function leafPath(name, { platform = process.platform } = {}) {
  // The name reaches this from a registry response, so it is not trusted input.
  // Runs of dots are collapsed rather than merely stripped of slashes: `..` is
  // the traversal, and leaving `....` behind produces a filename nobody can
  // match back to a name even though it escapes nothing.
  const safe = String(name).toLowerCase().replace(/[^a-z0-9.-]/g, "").replace(/\.{2,}/g, ".").replace(/^[.-]+|[.-]+$/g, "");
  if (!safe || !safe.includes(".")) return null;
  return platform === "darwin"
    ? `/Library/Keychains/moshpit-${safe}.crt`
    : `/usr/local/share/ca-certificates/moshpit-${safe}.crt`;
}

/**
 * Is this certificate marked as a certificate authority?
 *
 * Read with node's X509 parser rather than by grepping openssl's text, because
 * the answer decides whether a key gets authority over the whole clearnet and
 * "CA:FALSE" is a substring of nothing but is adjacent to plenty.
 *
 * A certificate carrying no basicConstraints at all answers false: absent is
 * not the same as asserted, and RFC 5280 §4.2.1.9 treats such a certificate as
 * an end entity.
 */
export async function isCertificateAuthority(pem) {
  const crypto = await import("node:crypto");
  return new crypto.X509Certificate(pem).ca === true;
}

/**
 * What `trust <name>` should do, given what the socket served and what the
 * registry says about it.
 *
 * Pure, so the refusal path is testable without a network or a trust store.
 */
export function leafTrustPlan({ name, pin, published, platform = process.platform, ca = false } = {}) {
  const accepted = pinAccepted(pin, published);
  if (!accepted.ok) return { ok: false, refused: true, why: accepted.why };

  // A certificate installed here is installed as a *trust anchor*, and an
  // anchor marked CA:TRUE may issue for any name in the world. The SAN says
  // what the certificate speaks for; it says nothing about what a key trusted
  // as an authority may go on to sign — so `subjectAltName=DNS:seo.rank` on a
  // CA:TRUE certificate is not the bound it looks like, and trusting one would
  // hand its holder google.com along with their own name.
  //
  // This is the same hole `requireNameConstraints` exists to close on the root
  // path, arriving by the other door. It went unnoticed because openssl's
  // `req -x509` defaults to CA:TRUE, so every origin set up before that default
  // was overridden serves exactly the shape that must be refused — and it looks
  // identical to a correct one until someone trusts it.
  if (ca) {
    return {
      ok: false,
      refused: true,
      kind: "ca",
      why: `${name} serves a certificate marked CA:TRUE — trusted directly, its key could vouch for any name`,
    };
  }

  const file = leafPath(name, { platform });
  if (!file) return { ok: false, why: `${name} is not a name that can be written to a file` };

  return {
    ok: true,
    why: accepted.why,
    file,
    // With CA:FALSE established above, a self-signed leaf is its own trust
    // anchor and its SAN limits it to this one name — so trusting it vouches
    // for `seo.rank` and nothing else. That is a far smaller grant than a CA,
    // which is why this path needs no name-constraints argument to be
    // defensible. It is only true because of the check above.
    refresh: platform === "darwin"
      ? { command: "security", args: ["add-trusted-cert", "-d", "-r", "trustRoot", "-k", "/Library/Keychains/System.keychain", file] }
      : { command: "update-ca-certificates", args: [] },
  };
}

/** The certificate a name is actually serving, as PEM. */
export function fetchCertificateCommand(name, { port = 443 } = {}) {
  return {
    command: "sh",
    args: ["-c", `openssl s_client -connect ${name}:${port} -servername ${name} </dev/null 2>/dev/null | openssl x509`],
  };
}

/**
 * `moshcode dns trust <name>` — trust one name, on the strength of its pin.
 *
 * The path that needs no proxy and no certificate authority. A Moshpit name
 * serves a self-signed certificate whose SAN names only itself, so trusting it
 * vouches for that one name and nothing else — a far smaller grant than a root,
 * and the reason this needs no name-constraints argument to be defensible.
 *
 * The pin check is what makes it safe rather than reckless. Installing whatever
 * answered the socket is the definition of trusting whoever reached the port
 * first; installing it only when the registry already vouches for that exact
 * key is registry-backed trust, which is a stronger claim than domain
 * validation ever made.
 */
export async function trustName(name, out, deps = {}) {
  const {
    registryBase = "https://pit.moshcode.sh",
    fetchImpl = fetch,
    runner = run,
    platform = process.platform,
    uid = typeof process.getuid === "function" ? process.getuid() : 0,
    writeFile = async (f, c) => (await import("node:fs/promises")).writeFile(f, c),
  } = deps;

  if (!name) {
    out("which name? e.g. moshcode dns trust seo.rank");
    return 1;
  }

  const fetchCert = fetchCertificateCommand(name);
  const served = await runner(fetchCert.command, fetchCert.args);
  if (!served.ok || !served.stdout.includes("BEGIN CERTIFICATE")) {
    out(`could not read a certificate from ${name}:443`);
    out("  the name must resolve and be serving HTTPS before its certificate can be trusted");
    return 1;
  }

  const pin = await pinFromCertificate(served.stdout).catch(() => null);
  if (!pin) {
    out(`could not read the public key out of ${name}'s certificate`);
    return 1;
  }

  let published = [];
  try {
    published = await publishedPins(name, { registryBase, fetchImpl });
  } catch (err) {
    // An outage is not a failed pin check, and must not be reported as one —
    // the answer to "the registry is down" is to wait, not to distrust a name.
    out(`could not reach the registry to check ${name}'s pin — ${err?.message || err}`);
    out("  nothing has been trusted.");
    return 1;
  }

  // Read off the certificate rather than assumed: an origin set up before
  // `setup-origin.sh` overrode openssl's default serves CA:TRUE, and that is
  // the one shape this must not install.
  const ca = await isCertificateAuthority(served.stdout).catch(() => true);

  const plan = leafTrustPlan({ name, pin, published, platform, ca });
  if (!plan.ok) {
    out(`REFUSED — ${plan.why}`);
    if (plan.kind === "ca") {
      // A refusal with no way forward is a refusal people route around, and
      // this one has a cheap way forward that costs nothing anywhere else: the
      // pin is over the key, so re-issuing the certificate from the same key
      // leaves the published pin untouched. Nothing has to be republished and
      // no client holding the old pin breaks.
      out("  its SAN says what it speaks for, not what it may sign — an anchor");
      out("  marked CA:TRUE is not limited to the name printed on it.");
      out("  re-issue it as CA:FALSE; the key is reused, so the pin does not move:");
      out(`    sudo sh scripts/setup-origin.sh ${name}    # from moshpit-proxy`);
    } else if (plan.refused) {
      out(`  served  ${pin}`);
      out(published.length ? `  pinned  ${published.join("\n          ")}` : "  pinned  (none)");
      out("  moshcode will not trust a certificate the registry does not vouch for.");
    }
    return 1;
  }

  out(`${name} — ${plan.why}`);
  out(`  pin  ${pin}`);

  if (uid !== 0) {
    out(`  writing ${plan.file} needs root.`);
    return 1;
  }

  try {
    await writeFile(plan.file, served.stdout);
  } catch (err) {
    out(`  FAIL could not write ${plan.file} — ${err?.message || err}`);
    return 1;
  }
  const refreshed = await runner(plan.refresh.command, plan.refresh.args);
  if (!refreshed.ok) {
    out(`  FAIL ${plan.refresh.command} — ${refreshed.stderr.split("\n")[0] || "failed"}`);
    return 1;
  }
  out(`  ok   trusted — curl https://${name} now verifies without flags`);
  return 0;
}

/**
 * Trust every name as it is resolved, instead of one command per name.
 *
 * `dns trust <name>` works and does not scale: a person browsing Moshpit hits a
 * certificate error on every site they have not personally thought about, which
 * is indistinguishable from the namespace being broken.
 *
 * The registry pin is what makes doing it automatically defensible. Nothing is
 * trusted on sight — a name is trusted only when the key it serves is one the
 * registry already published for it, which is a stronger claim than domain
 * validation ever made. A name with no pin gets nothing, silently and forever.
 *
 * Three properties this has to have, and each one is a way it could go wrong:
 *
 *   - it must never block a DNS answer. Resolution is on the critical path of
 *     every page load; certificate work is not.
 *   - it must ask about a name once, not once per query. A browser sends A and
 *     AAAA together and retries, so "on resolve" is a firehose.
 *   - a failure must be quiet and final for that name until restart. Retrying a
 *     name whose pin does not match, on every lookup, is a loop that writes a
 *     log line per query and never succeeds.
 */
export function createAutoTrust({
  trust = trustName,
  out = () => {},
  registryBase,
  uid = typeof process.getuid === "function" ? process.getuid() : 0,
  ...deps
} = {}) {
  // One entry per name for the life of the process: `true` while in flight or
  // done, so neither a success nor a refusal is ever retried.
  const seen = new Set();
  const pending = [];
  // The in-flight drain, not a boolean. A flag can say "someone else is
  // draining", but it cannot be awaited — so `idle()` returned the moment it
  // saw one, reporting a queue as settled while it was still being worked.
  let running = null;

  async function drain() {
    if (running) return running;
    running = (async () => {
      try {
      while (pending.length) {
        const name = pending.shift();
        // Output is deliberately only the interesting half. A resolver that
        // narrated a success per name would bury its own query log.
        const lines = [];
        const code = await trust(name, (l) => lines.push(l), { registryBase, uid, ...deps })
          .catch(() => 1);
        if (code === 0) out(`  trusted ${name}`);
        else if (lines.some((l) => l.startsWith("REFUSED"))) out(`  ! ${name} — ${lines[0]}`);
        }
      } finally {
        running = null;
      }
    })();
    return running;
  }

  return {
    /** Consider a name for trust. Returns immediately; never throws. */
    consider(name) {
      if (!name || seen.has(name)) return false;
      seen.add(name);
      pending.push(name);
      // Detached on purpose: the caller is a UDP handler with a reply to send.
      queueMicrotask(() => { drain().catch(() => {}); });
      return true;
    },
    /**
     * Settle whatever is queued, including work added while draining.
     *
     * Looped rather than awaited once: a name considered mid-drain joins the
     * queue behind the current pass, so a single await can return with items
     * still waiting.
     */
    async idle() {
      while (running || pending.length) await drain();
    },
    get size() {
      return seen.size;
    },
  };
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
