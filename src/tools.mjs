// Adjacent workflow CLIs moshcode can install and transparently invoke.
// These are deliberately separate from coding engines: UGig owns marketplace
// workflows, CoinPay owns payment workflows, and moshcode only conducts their
// native command lines.
import { isInstalled, openPassthrough } from "./engines.mjs";

export const TOOLS = {
  ugig: {
    desc: "UGig — freelance marketplace CLI for humans and agents",
    bin: "ugig",
    install: { cmd: "npm", args: ["install", "-g", "ugig"] },
  },
  coinpay: {
    desc: "CoinPay — wallets, payments, swaps, escrow, and settlement",
    bin: "coinpay",
    install: { cmd: "npm", args: ["install", "-g", "@profullstack/coinpay"] },
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
