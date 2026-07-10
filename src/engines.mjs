// Agentic-coding engines moshcode can install + wrap. `moshcode install <name>`
// runs the engine's official installer; moshcode itself stays lean (no vendored
// fork). Add engines here.
export const ENGINES = {
  opencode: {
    desc: "opencode — the open-source coding agent (SST/anomalyco)",
    bin: "opencode",
    install: { cmd: "bash", args: ["-c", "curl -fsSL https://opencode.ai/install | bash"] },
  },
  claude: {
    desc: "Claude Code — Anthropic's agentic CLI",
    bin: "claude",
    install: { cmd: "npm", args: ["install", "-g", "@anthropic-ai/claude-code"] },
  },
  codex: {
    desc: "Codex — OpenAI's coding CLI",
    bin: "codex",
    install: { cmd: "npm", args: ["install", "-g", "@openai/codex"] },
  },
};

export function engineList() {
  return Object.entries(ENGINES).map(([k, v]) => `  ${k.padEnd(10)} ${v.desc}`).join("\n");
}
