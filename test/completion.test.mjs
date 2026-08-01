import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  COMPLETION_SHELLS,
  completionModel,
  completionScript,
} from "../src/completion.mjs";
import { MCP_VERBS, UPGRADE_TARGETS } from "../src/cli-schema.mjs";
import { ENGINE_ALIASES, ENGINES } from "../src/engines.mjs";
import { TOOLS } from "../src/tools.mjs";

const BIN = fileURLToPath(new URL("../bin/moshcode.mjs", import.meta.url));

function names(entries) {
  return entries.map(({ name }) => name);
}

function bashQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function bashCompletions(tokens) {
  const script = `${completionScript("bash")}
COMP_WORDS=(${tokens.map(bashQuote).join(" ")})
COMP_CWORD=${tokens.length - 1}
_moshcode_completion
printf '%s\\n' "\${COMPREPLY[@]}"
`;
  const result = spawnSync("bash", ["-c", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.split("\n").filter(Boolean);
}

test("completion model derives engines, aliases, and tools from their registries", () => {
  const model = completionModel();
  const top = new Set(names(model.top));
  const install = new Set(names(model.install));
  const engines = new Set(names(model.engines));

  for (const name of Object.keys(ENGINES)) {
    assert.ok(top.has(name));
    assert.ok(install.has(name));
    assert.ok(engines.has(name));
  }
  for (const name of Object.keys(ENGINE_ALIASES)) {
    assert.ok(top.has(name));
    assert.ok(!install.has(name));
    assert.ok(engines.has(name));
  }
  for (const name of Object.keys(TOOLS)) {
    assert.ok(top.has(name));
    assert.ok(install.has(name));
  }
  for (const name of ["help", "--help", "-h"]) {
    assert.ok(top.has(name));
  }

  const upgrade = new Set(names(model.upgrade));
  for (const { name } of UPGRADE_TARGETS) assert.ok(upgrade.has(name));

  assert.deepEqual(
    new Set(names(model.mcpServerSpecs)),
    new Set(MCP_VERBS.filter(({ acceptsServerSpec }) => acceptsServerSpec).map(({ name }) => name)),
  );
});

test("completion schema covers every explicitly dispatched CLI command", () => {
  const source = readFileSync(BIN, "utf8");
  const dispatched = [...source.matchAll(/cmd === "([^"]+)"/g)].map((match) => match[1]);
  const top = new Set(names(completionModel().top));

  for (const command of [...dispatched, "help"]) {
    assert.ok(top.has(command), `${command} is dispatched but missing from completion`);
  }
});

for (const shell of COMPLETION_SHELLS) {
  test(`completionScript emits context-aware ${shell} completion`, () => {
    const output = completionScript(shell);
    assert.match(output, /moshcode/);
    assert.match(output, /completion/);
    assert.match(output, /\blist\b/);
    assert.match(output, /\bcatalog\b/);
  });

  test(`moshcode completion ${shell} prints exactly the generated script`, () => {
    const result = spawnSync(process.execPath, [BIN, "completion", shell], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, completionScript(shell));
  });
}

for (const [shell, args] of [
  ["bash", ["-n", "-c"]],
  ["zsh", ["-n", "-c"]],
  ["fish", ["--no-execute", "-c"]],
]) {
  test(`${shell} accepts its generated completion script`, (t) => {
    const result = spawnSync(shell, [...args, completionScript(shell)], {
      encoding: "utf8",
    });
    if (result.error?.code === "ENOENT") {
      t.skip(`${shell} is not installed`);
      return;
    }
    assert.equal(result.status, 0, result.stderr);
  });
}

test("bash completion respects argument depth and preserves file fallbacks", () => {
  assert.ok(bashCompletions(["moshcode", "cl"]).includes("claude"));
  assert.ok(bashCompletions(["moshcode", "agents", ""]).includes("cc"));
  assert.ok(bashCompletions(["moshcode", "install", ""]).includes("claude"));
  assert.deepEqual(bashCompletions(["moshcode", "install", "claude", ""]), []);

  const mcp = bashCompletions(["moshcode", "mcp", ""]);
  assert.ok(mcp.includes("list"));
  assert.ok(mcp.includes("catalog"));
  assert.ok(bashCompletions(["moshcode", "mcp", "list", "--"]).includes("--json"));
  assert.deepEqual(bashCompletions(["moshcode", "mcp", "install", ""]), []);

  assert.ok(bashCompletions(["moshcode", "skill", "list", "--"]).includes("--json"));
  assert.ok(bashCompletions(["moshcode", "skills", "list", "--"]).includes("--json"));

  assert.deepEqual(bashCompletions(["moshcode", "run", ""]), []);
  assert.ok(bashCompletions(["moshcode", "run", "--"]).includes("--dry-run"));
  assert.ok(bashCompletions(["moshcode", "upgrade", "claude", ""]).includes("codex"));
  assert.ok(bashCompletions(["moshcode", "upgrade", ""]).includes("all"));
  assert.ok(bashCompletions(["moshcode", "upgrade", ""]).includes("moshcode"));

  const strictScript = `set -u
${completionScript("bash")}
COMP_WORDS=(moshcode "")
COMP_CWORD=1
_moshcode_completion
`;
  const strictResult = spawnSync("bash", ["-c", strictScript], { encoding: "utf8" });
  assert.equal(strictResult.status, 0, strictResult.stderr);

  assert.match(
    completionScript("bash"),
    /complete -o bashdefault -o default -F _moshcode_completion moshcode/,
  );
});

test("completion normalizes shell names and rejects unsupported values", () => {
  assert.equal(completionScript(" BASH "), completionScript("bash"));
  assert.throws(() => completionScript(), /unsupported shell/);
  assert.throws(() => completionScript("powershell"), /choose: bash, zsh, fish/);

  const result = spawnSync(process.execPath, [BIN, "completion"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /usage: moshcode completion <bash\|zsh\|fish>/);
});
