// Taking a tool back off the machine.
//
// `moshcode install` runs whatever each tool ships as its installer, and those
// come in two shapes: `npm install -g <pkg>`, and `curl … | sh`. Only the first
// has an inverse anyone wrote down. The second drops a binary somewhere and
// leaves no record, so removing it means finding that binary and deleting it —
// which is a different kind of operation and is treated like one here.
//
// The rules that follow from that:
//
//   - an npm install is undone by npm, which knows what it put where
//   - a script install is undone by removing the binary the tool reports, and
//     only when it sits somewhere a per-user installer would plausibly have put
//     it. `/usr/bin/git` is not something this should ever offer to delete
//   - anything else says so rather than guessing
//
// Plans are data so the whole decision is testable without deleting anything,
// and so `--dry-run` can show exactly what would go.

import { dirname } from "node:path";
import { homedir } from "node:os";

/**
 * Where a per-user installer legitimately puts a binary.
 *
 * A deny-list would be the wrong shape here: the question is not "is this
 * dangerous" but "did something we ran plausibly create this", and only an
 * allow-list answers that. A binary in /usr/bin arrived from the system package
 * manager and is not ours to remove.
 */
export function safePrefixes(home = homedir()) {
  return [
    `${home}/.local/bin`,
    `${home}/.bun/bin`,
    `${home}/.cargo/bin`,
    `${home}/.deno/bin`,
    `${home}/bin`,
    `${home}/.npm-global/bin`,
    `${home}/.volta/bin`,
    "/usr/local/bin",
    "/opt/homebrew/bin",
  ];
}

/** The npm package an install spec would install, or null if it is not npm. */
export function npmPackageOf(install) {
  if (!install) return null;
  const npmish = ["npm", "pnpm", "yarn", "bun"].includes(install.cmd);
  if (!npmish) return null;
  const args = install.args || [];
  if (!args.includes("-g") && !args.includes("--global")) return null;
  // The package is the last argument that is not a flag or a subcommand.
  const skip = new Set(["install", "add", "i", "-g", "--global"]);
  const pkg = [...args].reverse().find((a) => !a.startsWith("-") && !skip.has(a));
  return pkg || null;
}

/**
 * How to remove `entry`, given where its binary currently is.
 *
 * `binPath` is what `which <bin>` reported, or null when it is not on PATH.
 */
export function uninstallPlan(entry, { binPath = null, home = homedir() } = {}) {
  const pkg = npmPackageOf(entry?.install);
  if (pkg) {
    return {
      kind: "npm",
      steps: [{ kind: "run", command: entry.install.cmd, args: ["uninstall", "-g", pkg] }],
      warnings: [],
    };
  }

  if (!binPath) {
    return {
      kind: "absent",
      steps: [],
      warnings: [`${entry?.bin || "it"} is not on your PATH — nothing to remove`],
    };
  }

  const dir = dirname(binPath);
  if (!safePrefixes(home).includes(dir)) {
    // Refused rather than confirmed-with-a-scary-prompt: a binary here came
    // from somewhere else, and the person who put it there knows how to remove
    // it. Deleting it because a prompt was clicked through is worse than not
    // offering.
    return {
      kind: "refused",
      steps: [],
      warnings: [
        `${binPath} is not in a directory moshcode installs into.`,
        "It was put there by something else — a system package manager, or by hand — so removing it is that thing's job.",
      ],
    };
  }

  return {
    kind: "binary",
    steps: [{ kind: "remove", path: binPath }],
    warnings: [
      "This removes the binary only. Anything it wrote to your home directory — config, caches, credentials — stays.",
    ],
  };
}

/** The plan as a line someone can read before agreeing to it. */
export function describeUninstall(plan) {
  return plan.steps
    .map((s) => (s.kind === "run" ? `run     ${s.command} ${s.args.join(" ")}` : `remove  ${s.path}`))
    .concat((plan.warnings || []).map((w) => `note    ${w}`))
    .join("\n");
}
