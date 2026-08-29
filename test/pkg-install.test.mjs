// ffmpeg and ImageMagick are the two tools moshcode installs through the box's
// own package manager rather than a vendor script or a release binary, and the
// per-manager argv differ in ways that are easy to get almost right: a manager
// that stops to ask "continue? [Y/n]" parks a whole `moshcode upgrade` sweep,
// and escalating Homebrew makes it refuse outright. These pin both.
import assert from "node:assert/strict";
import test from "node:test";

import {
  MANAGERS, MANAGER_ORDER, PACKAGES, findManager, installSteps, installPackage, resolvePackage,
} from "../src/pkg-install.mjs";

test("every manager installs without asking a question", () => {
  // Nothing here runs with a human watching: `moshcode upgrade tools` walks a
  // plan, and a confirmation prompt parks it behind a keystroke nobody types.
  const assumeYes = {
    brew: null, // brew install is non-interactive already
    "apt-get": "-y",
    dnf: "-y",
    zypper: "--non-interactive",
    pacman: "--noconfirm",
    apk: "--no-cache",
  };
  for (const [name, flag] of Object.entries(assumeYes)) {
    if (!flag) continue;
    const flat = MANAGERS[name].steps("pkg").flatMap(([, args]) => args);
    assert.ok(flat.includes(flag), `${name} is missing ${flag}`);
  }
});

test("apt refreshes its index before installing from it", () => {
  // A box that has not run `apt-get update` in months 404s on the archive, and
  // the error names a URL rather than the actual problem.
  const [first] = MANAGERS["apt-get"].steps("ffmpeg");
  assert.deepEqual(first, ["apt-get", ["update", "-qq"]]);
});

test("installSteps escalates the managers that need root, and only those", () => {
  assert.deepEqual(installSteps("apt-get", "ffmpeg", { escalator: "sudo" }), [
    { cmd: "sudo", args: ["apt-get", "update", "-qq"] },
    { cmd: "sudo", args: ["apt-get", "install", "-y", "--no-install-recommends", "ffmpeg"] },
  ]);
  // Homebrew refuses to run as root and says so at length, so escalating it
  // turns a working install into a lecture.
  assert.deepEqual(installSteps("brew", "ffmpeg", { escalator: "sudo" }), [
    { cmd: "brew", args: ["install", "ffmpeg"] },
  ]);
});

test("installSteps does not escalate when it is already root", () => {
  assert.deepEqual(installSteps("dnf", "ffmpeg", { escalator: "sudo", isRoot: true }), [
    { cmd: "dnf", args: ["install", "-y", "ffmpeg"] },
  ]);
});

test("installSteps runs bare when there is no escalator, so the manager explains itself", () => {
  // A container with no sudo is a normal place to end up. The manager's own
  // permission message is better advice than anything we would write.
  assert.deepEqual(installSteps("apk", "ffmpeg", { escalator: null }), [
    { cmd: "apk", args: ["add", "--no-cache", "ffmpeg"] },
  ]);
});

test("brew is probed before the linux managers", () => {
  // A mac with Linuxbrew-adjacent tooling should still land on brew.
  assert.equal(MANAGER_ORDER[0], "brew");
  assert.equal(findManager({ probe: (m) => m === "brew" || m === "apt-get" }), "brew");
  assert.equal(findManager({ probe: () => false }), null);
});

test("every tool has a package name for every manager", () => {
  for (const [tool, table] of Object.entries(PACKAGES)) {
    for (const manager of MANAGER_ORDER) {
      assert.ok(table[manager]?.length, `${tool} has no ${manager} package`);
    }
  }
});

test("ffmpeg carries Fedora's second name", () => {
  // Fedora ships `ffmpeg-free` in its own repositories and the full `ffmpeg`
  // only from RPM Fusion, so a box without that repo has exactly one of them
  // and `dnf install ffmpeg` fails outright on it.
  assert.deepEqual(PACKAGES.ffmpeg.dnf, ["ffmpeg", "ffmpeg-free"]);
});

test("resolvePackage reads own properties only", () => {
  assert.throws(() => resolvePackage("constructor"), /unknown package/);
  assert.throws(() => resolvePackage("__proto__"), /unknown package/);
  assert.equal(resolvePackage("FFmpeg")[0], "ffmpeg");
});

test("installPackage tries the next package name when one is not in the archive", () => {
  const seen = [];
  const run = (cmd, args) => {
    seen.push([cmd, ...args].join(" "));
    // Refuse the first candidate the way dnf refuses a name it cannot resolve.
    return { status: args.includes("ffmpeg") && !args.includes("ffmpeg-free") ? 1 : 0 };
  };
  const result = installPackage("ffmpeg", { run, probe: (m) => m === "dnf", log: () => {} });
  assert.deepEqual(result, { manager: "dnf", pkg: "ffmpeg-free" });
  assert.ok(seen.some((c) => c.includes("ffmpeg-free")));
});

test("installPackage reports every failure rather than the last one", () => {
  assert.throws(
    () => installPackage("ffmpeg", { run: () => ({ status: 1 }), probe: (m) => m === "dnf", log: () => {} }),
    (e) => /could not install ffmpeg with dnf/.test(e.message) && /ffmpeg-free/.test(e.message),
  );
});

test("installPackage says what to do when the box has no package manager", () => {
  assert.throws(
    () => installPackage("ffmpeg", { run: () => ({ status: 0 }), probe: () => false, log: () => {} }),
    /no supported package manager found/,
  );
});
