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

/** Where moshpit-proxy generates its root on first run. */
export function caPath({ home = os.homedir(), dir = null } = {}) {
  return path.join(dir || path.join(home, ".moshpit"), "ca", "ca.crt");
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
    return { ok: false, why: "could not read the certificate — openssl printed nothing usable" };
  }
  if (!/X509v3 Name Constraints/i.test(body)) {
    return {
      ok: false,
      why: "the root carries no name constraints — it could vouch for any name, not just Moshpit",
    };
  }
  // Non-critical constraints are advisory: a verifier is free to ignore an
  // extension it does not recognise, which turns the guarantee into a comment.
  if (!/X509v3 Name Constraints:\s*critical/i.test(body)) {
    return { ok: false, why: "the name constraints are not marked critical, so a verifier may ignore them" };
  }
  const missing = tlds.filter((tld) => !new RegExp(`DNS:\\.?${tld}\\b`, "i").test(body));
  if (missing.length) {
    return { ok: false, why: `the root does not permit ${missing.join(", ")}` };
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
    return { ok: false, refused: true, steps: [], why: constrained.why };
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
    home = os.homedir(),
    platform = process.platform,
    uid = typeof process.getuid === "function" ? process.getuid() : 0,
  } = deps;

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
    if (plan.refused) out("       moshcode will not put an unconstrained root in your trust store.");
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
    out(done.ok
      ? `  ok   installed into ${step.label}`
      : `  FAIL ${step.label} — ${done.stderr.split("\n")[0] || `${step.command} failed`}`);
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
