// Adjacent workflow CLIs moshcode can install and transparently invoke.
// These are deliberately separate from coding engines: UGig owns marketplace
// workflows, CoinPay owns payment workflows, and moshcode only conducts their
// native command lines.
import { isInstalled, openPassthrough } from "./engines.mjs";

export const TOOLS = {
  ugig: {
    desc: "UGig — freelance marketplace CLI for humans and agents",
    bin: "ugig",
    // UGig isn't published to npm — it ships via its own install script.
    install: { cmd: "bash", args: ["-c", "curl -fsSL https://ugig.net/install.sh | bash"] },
  },
  coinpay: {
    desc: "CoinPay — wallets, payments, swaps, escrow, and settlement",
    bin: "coinpay",
    // CoinPay ships via its own install script (fetched from GitHub), not npm.
    install: { cmd: "sh", args: ["-c", "curl -fsSL https://coinpayportal.com/install.sh | sh"] },
  },
};

/** Resolve a name to `[key, tool]`, or null. */
export function resolveTool(token) {
  if (!token) return null;
  const key = String(token).trim().toLowerCase();
  return TOOLS[key] ? [key, TOOLS[key]] : null;
}

/** Tool entries annotated with native executable install status. */
export function toolStatus() {
  return Object.entries(TOOLS).map(([key, tool]) => ({
    key,
    ...tool,
    installed: isInstalled(tool.bin),
  }));
}

export function toolList() {
  return Object.entries(TOOLS)
    .map(([key, tool]) => `  ${key.padEnd(10)} ${tool.desc}`)
    .join("\n");
}

/** Prefer a native updater when one is added; npm installs are idempotent. */
export function toolUpgradeSpec(tool) {
  return tool.upgrade || tool.install;
}

/** Invoke a tool without parsing or modifying its arguments or streams. */
export function openTool(tool, args = []) {
  return openPassthrough(tool, args);
}
