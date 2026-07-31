// The asset-naming rules for gh/supabase/doctl are three different vendor
// conventions, and getting one character wrong means `moshcode install <tool>`
// 404s on a machine we never tested. These assertions pin each URL and each
// in-archive binary path against layouts verified from the real releases:
//   gh_2.96.0_linux_amd64.tar.gz        → gh_2.96.0_linux_amd64/bin/gh
//   gh_2.96.0_macOS_arm64.zip           → gh_2.96.0_macOS_arm64/bin/gh
//   supabase_linux_amd64.tar.gz         → supabase
//   doctl-1.164.0-linux-amd64.tar.gz    → doctl
import assert from "node:assert/strict";
import test from "node:test";

import {
  RELEASES, assetUrl, installDir, latestVersion, resolveRelease, targetTriple,
} from "../src/release-install.mjs";

test("targetTriple maps node's platform/arch onto release-asset names", () => {
  assert.deepEqual(targetTriple("linux", "x64"), { platform: "linux", arch: "amd64" });
  assert.deepEqual(targetTriple("linux", "arm64"), { platform: "linux", arch: "arm64" });
  assert.deepEqual(targetTriple("darwin", "arm64"), { platform: "darwin", arch: "arm64" });
});

test("targetTriple refuses platforms this installer cannot serve", () => {
  // Windows users are pointed at scoop/winget rather than handed a broken install.
  assert.throws(() => targetTriple("win32", "x64"), /win32 isn't supported/);
  assert.throws(() => targetTriple("linux", "ppc64"), /unsupported architecture ppc64/);
});

test("gh assets follow its versioned, macOS-capitalised naming", () => {
  const gh = RELEASES.gh;
  assert.equal(
    assetUrl(gh, { version: "2.96.0", platform: "linux", arch: "amd64" }),
    "https://github.com/cli/cli/releases/download/v2.96.0/gh_2.96.0_linux_amd64.tar.gz",
  );
  // darwin is spelled "macOS" and ships as a .zip, not a .tar.gz.
  assert.equal(
    assetUrl(gh, { version: "2.96.0", platform: "darwin", arch: "arm64" }),
    "https://github.com/cli/cli/releases/download/v2.96.0/gh_2.96.0_macOS_arm64.zip",
  );
  assert.equal(
    gh.binPath({ version: "2.96.0", platform: "darwin", arch: "arm64" }),
    "gh_2.96.0_macOS_arm64/bin/gh",
  );
});

test("supabase resolves through the version-less latest/download alias", () => {
  // supabase publishes unversioned aliases, so no release-lookup call is needed.
  assert.equal(
    assetUrl(RELEASES.supabase, { version: "", platform: "linux", arch: "amd64" }),
    "https://github.com/supabase/cli/releases/latest/download/supabase_linux_amd64.tar.gz",
  );
  assert.equal(RELEASES.supabase.binPath({}), "supabase");
  assert.equal(RELEASES.supabase.unversioned, true);
});

test("doctl separates its asset fields with dashes", () => {
  assert.equal(
    assetUrl(RELEASES.doctl, { version: "1.164.0", platform: "darwin", arch: "amd64" }),
    "https://github.com/digitalocean/doctl/releases/download/v1.164.0/doctl-1.164.0-darwin-amd64.tar.gz",
  );
  assert.equal(RELEASES.doctl.binPath({}), "doctl");
});

test("resolveRelease is case-insensitive and ignores Object.prototype members", () => {
  assert.deepEqual(resolveRelease("GH"), ["gh", RELEASES.gh]);
  // RELEASES is a plain object literal, so `constructor` is truthy but is not a
  // tool — resolving it would hand a spec-less entry to the downloader.
  assert.throws(() => resolveRelease("constructor"), /unknown release tool/);
  assert.throws(() => resolveRelease("__proto__"), /unknown release tool/);
  assert.throws(() => resolveRelease(undefined), /unknown release tool/);
});

test("latestVersion strips the leading v from the release tag", async () => {
  const fakeFetch = async () => ({ ok: true, json: async () => ({ tag_name: "v2.96.0" }) });
  assert.equal(await latestVersion("cli/cli", fakeFetch), "2.96.0");
});

test("latestVersion surfaces an unreachable or malformed release", async () => {
  const rateLimited = async () => ({ ok: false, status: 403 });
  await assert.rejects(latestVersion("cli/cli", rateLimited), /HTTP 403/);

  const noTag = async () => ({ ok: true, json: async () => ({}) });
  await assert.rejects(latestVersion("cli/cli", noTag), /no tag_name/);
});

test("installDir honours MOSHCODE_BIN, matching install.sh", () => {
  const previous = process.env.MOSHCODE_BIN;
  try {
    process.env.MOSHCODE_BIN = "/tmp/moshcode-bin";
    assert.equal(installDir(), "/tmp/moshcode-bin");
    delete process.env.MOSHCODE_BIN;
    assert.match(installDir(), /\.local[/\\]bin$/);
  } finally {
    if (previous === undefined) delete process.env.MOSHCODE_BIN;
    else process.env.MOSHCODE_BIN = previous;
  }
});
