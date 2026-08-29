// Installer for the workflow CLIs that ship ONLY as GitHub release binaries.
//
// gh, supabase, and doctl have no official cross-platform `curl … | sh`
// installer: each publishes per-platform static binaries on every release, and
// Supabase explicitly does not support a global npm install ("there is no global
// `supabase` command with this method"). Rather than guess which of
// brew/apt/dnf/snap/scoop exists on the box — and rather than ask for sudo — we
// do what moshcode's own install.sh does: resolve the latest release, download
// the asset for this OS/arch, and drop the binary in the user's bin dir.
//
// `moshcode install gh` runs this file directly; see the install specs in
// tools.mjs. The descriptors and URL builders are pure so the asset-naming
// rules (which differ per vendor, in annoying ways) are unit-tested offline.
import { spawnSync } from "node:child_process";
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync,
  rmSync, writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * How each vendor names its release assets, and where the binary sits inside
 * the archive. Verified against real releases — every field here is a fact
 * about someone else's naming scheme, not a preference:
 *   - gh spells darwin "macOS", ships darwin as .zip and linux as .tar.gz, and
 *     nests the binary under a versioned dir + bin/.
 *   - supabase also publishes version-less asset aliases, so `latest/download`
 *     resolves without asking the API for a tag first.
 *   - doctl separates its asset fields with "-" instead of "_".
 *   - yt-dlp publishes the executable itself rather than an archive, so there
 *     is nothing to unpack; `bare` is what says so.
 */
export const RELEASES = {
  gh: {
    repo: "cli/cli",
    binary: "gh",
    asset: ({ version, platform, arch }) =>
      platform === "darwin"
        ? `gh_${version}_macOS_${arch}.zip`
        : `gh_${version}_linux_${arch}.tar.gz`,
    binPath: ({ version, platform, arch }) =>
      `gh_${version}_${platform === "darwin" ? "macOS" : "linux"}_${arch}/bin/gh`,
  },
  supabase: {
    repo: "supabase/cli",
    binary: "supabase",
    unversioned: true,
    asset: ({ platform, arch }) => `supabase_${platform}_${arch}.tar.gz`,
    binPath: () => "supabase",
  },
  doctl: {
    repo: "digitalocean/doctl",
    binary: "doctl",
    asset: ({ version, platform, arch }) => `doctl-${version}-${platform}-${arch}.tar.gz`,
    binPath: () => "doctl",
  },
  "yt-dlp": {
    repo: "yt-dlp/yt-dlp",
    binary: "yt-dlp",
    // The asset IS the executable — a PyInstaller bundle, so it needs no
    // python on the box, and there is no archive around it to unpack.
    bare: true,
    // `unversioned` is not a convenience here, it is required: yt-dlp tags
    // releases by date with no leading "v" (2025.08.11), so the versioned URL
    // this builds otherwise — /download/v2025.08.11/ — is a 404. The
    // /releases/latest/download/ alias sidesteps the tag spelling entirely.
    unversioned: true,
    // macOS gets one universal2 build for both architectures; Linux names arm64
    // "aarch64" while every other vendor here calls it arm64.
    asset: ({ platform, arch }) =>
      platform === "darwin"
        ? "yt-dlp_macos"
        : arch === "arm64"
          ? "yt-dlp_linux_aarch64"
          : "yt-dlp_linux",
    binPath: () => "yt-dlp",
  },
};

// Node's process.arch names differ from the ones release assets use.
const ARCHES = { x64: "amd64", arm64: "arm64" };

/**
 * This machine's release-asset platform/arch, or a thrown error naming the
 * escape hatch. Windows is deliberately out of scope: moshcode installs itself
 * with a POSIX shell script, and every one of these vendors ships a Windows
 * package manager (scoop/winget) that does the job better than we would.
 */
export function targetTriple(platform = process.platform, arch = process.arch) {
  if (platform !== "linux" && platform !== "darwin") {
    throw new Error(
      `${platform} isn't supported by this installer — install the CLI with your system package manager (brew/scoop/winget)`,
    );
  }
  const mapped = ARCHES[arch];
  if (!mapped) {
    throw new Error(`unsupported architecture ${arch} — expected one of ${Object.keys(ARCHES).join(", ")}`);
  }
  return { platform, arch: mapped };
}

/** Resolve a tool name to its release descriptor, or throw. Own properties only. */
export function resolveRelease(tool) {
  const key = String(tool ?? "").trim().toLowerCase();
  if (!Object.hasOwn(RELEASES, key)) {
    throw new Error(
      `unknown release tool ${JSON.stringify(tool)} — expected one of ${Object.keys(RELEASES).join(", ")}`,
    );
  }
  return [key, RELEASES[key]];
}

/** The newest release tag for `repo`, with any leading "v" stripped. */
export async function latestVersion(repo, fetchImpl = fetch) {
  const res = await fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "moshcode" },
  });
  if (!res.ok) throw new Error(`could not read the latest ${repo} release (HTTP ${res.status})`);
  const tag = (await res.json())?.tag_name;
  if (!tag) throw new Error(`the latest ${repo} release has no tag_name`);
  return String(tag).replace(/^v/, "");
}

/**
 * The download URL for a release asset. Version-less vendors go through
 * GitHub's `/releases/latest/download/` redirect; the rest need the real tag.
 */
export function assetUrl(spec, target) {
  const asset = spec.asset(target);
  return spec.unversioned
    ? `https://github.com/${spec.repo}/releases/latest/download/${asset}`
    : `https://github.com/${spec.repo}/releases/download/v${target.version}/${asset}`;
}

/** Where binaries land — the same default install.sh uses for the moshcode wrapper. */
export function installDir() {
  return process.env.MOSHCODE_BIN || path.join(homedir(), ".local", "bin");
}

/** Unpack a .tar.gz or .zip into `dir` using the system tar/unzip. */
function extract(archive, dir) {
  const [cmd, args] = archive.endsWith(".zip")
    ? ["unzip", ["-q", archive, "-d", dir]]
    : ["tar", ["-xzf", archive, "-C", dir]];
  const r = spawnSync(cmd, args, { stdio: "inherit" });
  if (r.error || r.status !== 0) {
    const why = r.error ? ` (${r.error.message})` : ` (exit ${r.status})`;
    throw new Error(`${cmd} could not unpack ${path.basename(archive)}${why}`);
  }
}

/** A PATH warning is the difference between "installed" and "command not found". */
function warnIfNotOnPath(dir) {
  const parts = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  if (parts.includes(dir)) return;
  console.log(`! ${dir} is not on your PATH — add it:\n    export PATH="${dir}:$PATH"`);
}

/** Download, unpack, and install one release binary. Returns its final path. */
export async function installRelease(tool, { fetchImpl = fetch } = {}) {
  const [key, spec] = resolveRelease(tool);
  const { platform, arch } = targetTriple();
  const version = spec.unversioned ? "" : await latestVersion(spec.repo, fetchImpl);
  const target = { version, platform, arch };
  const url = assetUrl(spec, target);

  console.log(`↓ ${url}`);
  const res = await fetchImpl(url, { headers: { "user-agent": "moshcode" } });
  if (!res.ok) throw new Error(`download failed (HTTP ${res.status}) — ${url}`);

  const work = mkdtempSync(path.join(tmpdir(), `moshcode-${key}-`));
  try {
    const archive = path.join(work, path.posix.basename(new URL(url).pathname));
    writeFileSync(archive, Buffer.from(await res.arrayBuffer()));

    let from = archive;
    if (!spec.bare) {
      const unpacked = path.join(work, "unpacked");
      mkdirSync(unpacked);
      extract(archive, unpacked);

      const relative = spec.binPath(target);
      from = path.join(unpacked, relative);
      if (!existsSync(from)) {
        throw new Error(`${spec.binary} was not at ${relative} inside ${path.basename(archive)} — the vendor's archive layout changed`);
      }
    }

    const dir = installDir();
    mkdirSync(dir, { recursive: true });
    const to = path.join(dir, spec.binary);
    copyFileSync(from, to);
    chmodSync(to, 0o755);
    console.log(`✓ ${spec.binary}${version ? ` ${version}` : ""} → ${to}`);
    warnIfNotOnPath(dir);
    return to;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** True when this file was executed directly rather than imported. */
function invokedDirectly() {
  try {
    return realpathSync(process.argv[1] || "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  installRelease(process.argv[2]).catch((e) => {
    console.error(`install failed: ${e.message}`);
    process.exit(1);
  });
}
