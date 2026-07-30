import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { planUpgrade, selfSpec } from "../src/upgrade.mjs";

function withFakeTools(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "moshcode-upgrade-"));
  for (const name of ["ugig", "coinpay", "c0mpute"]) {
    const file = path.join(dir, name);
    writeFileSync(file, "#!/bin/sh\nexit 0\n");
    chmodSync(file, 0o755);
  }
  const before = process.env.PATH;
  // REPLACE the PATH rather than prepending to it: "which tools are installed"
  // is the thing under test, so any real CLI on the developer's machine (gh,
  // doctl, tailscale…) would otherwise leak into the plan and make the
  // assertions depend on the host.
  process.env.PATH = dir;
  try { return fn(); }
  finally { process.env.PATH = before; }
}

test("upgrade tools selects installed workflow tools without self or engines", () => {
  withFakeTools(() => {
    const plan = planUpgrade(["tools"]);
    assert.equal(plan.self, false);
    assert.deepEqual(plan.unknown, []);
    assert.deepEqual(plan.items.map(({ key, kind }) => ({ key, kind })), [
      { key: "ugig", kind: "tool" },
      { key: "coinpay", kind: "tool" },
      { key: "c0mpute", kind: "tool" },
    ]);
  });
});

test("explicit tool upgrades use official installers even when not installed", () => {
  const plan = planUpgrade(["ugig", "coinpay"]);

  assert.equal(plan.self, false);
  assert.deepEqual(plan.items.map(({ key, kind, spec }) => ({ key, kind, spec })), [
    {
      key: "ugig",
      kind: "tool",
      spec: { cmd: "bash", args: ["-c", "curl -fsSL https://ugig.net/install.sh | bash"] },
    },
    {
      key: "coinpay",
      kind: "tool",
      spec: { cmd: "sh", args: ["-c", "curl -fsSL https://coinpayportal.com/install.sh | sh"] },
    },
  ]);
});

test("default upgrade includes self and every installed tool", () => {
  withFakeTools(() => {
    const plan = planUpgrade([]);
    assert.equal(plan.self, true);
    assert.ok(plan.items.some(({ key, kind }) => key === "ugig" && kind === "tool"));
    assert.ok(plan.items.some(({ key, kind }) => key === "coinpay" && kind === "tool"));
  });
});

test("unknown upgrade targets remain visible to the caller", () => {
  const plan = planUpgrade(["not-a-tool"]);
  assert.deepEqual(plan.unknown, ["not-a-tool"]);
  assert.equal(plan.items.length, 0);
});

// The self-upgrade spec embeds MOSHCODE_HOME + the installer URL in a `sh -c`
// command line. Values must be POSIX single-quote escaped: an apostrophe in the
// install path used to break the command with a shell syntax error (and a
// hostile path could inject extra shell). Run the generated command for real,
// with a stub `curl` on PATH that records the env it sees and emits a no-op
// "installer".
function runSelfSpec(home) {
  const root = mkdtempSync(path.join(tmpdir(), "moshcode-selfspec-"));
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  const capture = path.join(root, "home.txt");
  writeFileSync(path.join(bin, "curl"), `#!/bin/sh\nprintf '%s' "$MOSHCODE_HOME" > ${JSON.stringify(capture)}\necho ':'\n`);
  chmodSync(path.join(bin, "curl"), 0o755);
  return { root, bin, capture };
}

test("selfSpec survives an apostrophe in MOSHCODE_HOME", async () => {
  const home = "/Users/o'brien/moshcode home";
  const { bin, capture } = runSelfSpec(home);
  const spec = selfSpec(home, "https://example.com/install.sh");
  const before = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${before || ""}`;
  try {
    const { runCmd, ranOk } = await import("../src/engines.mjs");
    const result = await runCmd(spec.cmd, spec.args);
    assert.ok(ranOk(result), `self-upgrade command should exit 0, got ${JSON.stringify(result)}`);
  } finally {
    process.env.PATH = before;
  }
  assert.equal(readFileSync(capture, "utf8"), home);
});

test("selfSpec cannot be broken out of by a hostile install path", async () => {
  const { bin, capture, root } = runSelfSpec("unused");
  const marker = path.join(root, "INJECTED");
  const home = `/tmp/x'; touch '${marker}'; '`;
  const spec = selfSpec(home, "https://example.com/install.sh");
  const before = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${before || ""}`;
  try {
    const { runCmd } = await import("../src/engines.mjs");
    await runCmd(spec.cmd, spec.args);
  } finally {
    process.env.PATH = before;
  }
  assert.equal(existsSync(marker), false, "path must not inject shell into the update command");
  assert.equal(readFileSync(capture, "utf8"), home);
});
