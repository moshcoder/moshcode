// `moshcode update` walks a plan: moshcode itself, then every installed engine,
// then every tool. It is long and nobody watches it. A tool whose installer
// escalates on its own — tailscale goes through the distro package manager —
// would otherwise stop for a password somewhere in the middle of that stream.
//
// So the ordering is the contract: the prompt comes before the first hand-off,
// or it is not worth having. These assert on one interleaved event log rather
// than on two separate call counts, because "was it asked for" is not the
// question — "was it asked for first" is.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { planUpgrade, runUpgrade } from "../src/upgrade.mjs";
import { TOOLS } from "../src/tools.mjs";

/**
 * Make exactly `names` look installed and nothing else.
 *
 * PATH is replaced rather than prepended: which targets are installed is what
 * decides the plan, so a real gh or tailscale on the developer's machine would
 * otherwise leak in and change what is under test. binDirs is stubbed off for
 * the same reason — it searches outside PATH by design.
 */
async function withOnly(names, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "moshcode-prime-"));
  for (const name of names) {
    const file = path.join(dir, name);
    writeFileSync(file, "#!/bin/sh\nexit 0\n");
    chmodSync(file, 0o755);
  }
  const beforePath = process.env.PATH;
  const beforeBinDirs = Object.values(TOOLS).map((tool) => [tool, tool.binDirs]);
  process.env.PATH = dir;
  for (const [tool] of beforeBinDirs) delete tool.binDirs;
  try { return await fn(); }
  finally {
    process.env.PATH = beforePath;
    for (const [tool, binDirs] of beforeBinDirs) if (binDirs) tool.binDirs = binDirs;
  }
}

/**
 * Force an entry to need root regardless of platform, and put it back.
 *
 * tailscale's real declaration spares macOS, where its script delegates to the
 * App Store. That is correct behaviour and it would also make the ordering tests
 * below silently vacuous on a mac — no privileged item in the plan, so nothing
 * to prime, so the assertion that priming happens first never runs. Pinning the
 * flag keeps these about ordering, and the platform rule is asserted on its own
 * in escalate-prime.test.mjs.
 */
async function withNeedsRoot(entry, fn) {
  const before = entry.needsRoot;
  entry.needsRoot = true;
  // Awaited, not just returned: a sync finally would restore the flag the moment
  // fn() handed back its promise, which happens before the plan is even built.
  // It passes either way today only because planUpgrade runs before runUpgrade's
  // first await — an accident, not something to rest a test on.
  try { return await fn(); }
  finally { entry.needsRoot = before; }
}

test("the plan records which items need root", async () => {
  await withOnly(["tailscale", "gh"], () => {
    const { items } = planUpgrade(["tools"]);
    const byKey = Object.fromEntries(items.map((it) => [it.key, it]));
    // Platform-dependent by design: macOS gets its packages from the App Store,
    // which does its own authorisation.
    assert.equal(byKey.tailscale.needsRoot, process.platform !== "darwin");
    // Everything else lands in ~/.local/bin and must never trigger a prompt.
    assert.equal(byKey.gh.needsRoot, false);
  });
});

test("asks for the password before the first hand-off, not partway through", async () => {
  const events = [];
  await withNeedsRoot(TOOLS.tailscale, () => withOnly(["tailscale"], () => runUpgrade(["tailscale"], {
    log: () => {},
    rule: () => {},
    primeEscalation: ({ what }) => { events.push(`prime:${what}`); return { primed: true }; },
    runCmd: (cmd, args) => { events.push(`run:${cmd} ${args.join(" ")}`); return { ok: true, code: 0 }; },
  })));

  assert.equal(events[0], "prime:tailscale", `expected priming first, got ${JSON.stringify(events)}`);
  // And it is `tailscale update` that follows — the native updater needs root
  // for the same reason the installer does.
  assert.match(events[1], /^run:tailscale update/);
});

test("a plan with nothing privileged in it never asks", async () => {
  const events = [];
  await withOnly(["gh"], () => runUpgrade(["gh"], {
    log: () => {},
    rule: () => {},
    primeEscalation: () => assert.fail("must not ask for a password to upgrade gh"),
    runCmd: (cmd, args) => { events.push(`run:${cmd} ${args.join(" ")}`); return { ok: true, code: 0 }; },
  }));

  assert.equal(events.length, 1);
});

test("one prompt covers a plan with several privileged items", async () => {
  const primes = [];
  await withNeedsRoot(TOOLS.tailscale, () => withOnly(["tailscale"], () => runUpgrade(["tailscale", "gh"], {
    log: () => {},
    rule: () => {},
    primeEscalation: ({ what }) => { primes.push(what); return { primed: true }; },
    runCmd: () => ({ ok: true, code: 0 }),
  })));

  // sudo caches against the terminal, so asking once is enough no matter how
  // many privileged steps follow.
  assert.equal(primes.length, 1);
  assert.equal(primes[0], "tailscale");
});

test("a declined prompt does not cancel the run", async () => {
  const events = [];
  const results = await withNeedsRoot(TOOLS.tailscale, () => withOnly(["tailscale"], () => runUpgrade(["tailscale"], {
    log: () => {},
    rule: () => {},
    primeEscalation: () => ({ primed: false, reason: "declined" }),
    runCmd: (cmd, args) => { events.push(`run:${cmd} ${args.join(" ")}`); return { ok: true, code: 0 }; },
  })));

  // The installer may not need root on this machine at all, and it prompts for
  // itself if it does. Refusing early must not decide that for it.
  assert.equal(events.length, 1);
  assert.equal(results.filter((r) => r.ok).length, 1);
});
