import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { completionScript } from "../src/completion.mjs";

function powershellExecutable() {
  for (const executable of ["powershell.exe", "powershell", "pwsh"]) {
    const result = spawnSync(executable, ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.Major"], {
      encoding: "utf8",
    });
    if (!result.error && result.status === 0) return executable;
  }
  return null;
}

const POWERSHELL = powershellExecutable();

function runPowerShell(executable, source) {
  return spawnSync(executable, [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "& ([scriptblock]::Create([Console]::In.ReadToEnd()))",
  ], {
    input: source,
    encoding: "utf8",
  });
}

function expand(executable, line) {
  const source = `${completionScript("powershell")}
$line = ${JSON.stringify(line)}
(TabExpansion2 $line $line.Length).CompletionMatches |
  ForEach-Object { $_.CompletionText }
`;
  const result = runPowerShell(executable, source);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
}

test("PowerShell accepts the generated completion script", (t) => {
  const executable = POWERSHELL;
  if (!executable) {
    t.skip("PowerShell is not installed");
    return;
  }
  const result = runPowerShell(executable, completionScript("powershell"));
  assert.equal(result.status, 0, result.stderr);
});

test("PowerShell completes commands, install targets, and nested options", (t) => {
  const executable = POWERSHELL;
  if (!executable) {
    t.skip("PowerShell is not installed");
    return;
  }
  const commands = expand(executable, "moshcode eng");
  const installs = expand(executable, "moshcode install cl");
  const options = expand(executable, "moshcode mcp list --j");
  const templateCommands = expand(executable, "moshcode template ins");
  const templateOptions = expand(executable, "moshcode template install --d");
  const templateAliasOptions = expand(executable, "moshcode templates install --i");
  assert.ok(commands.includes("engines"), JSON.stringify(commands));
  assert.ok(installs.includes("claude"), JSON.stringify(installs));
  assert.ok(options.includes("--json"), JSON.stringify(options));
  assert.ok(templateCommands.includes("install"), JSON.stringify(templateCommands));
  assert.ok(templateOptions.includes("--dry-run"), JSON.stringify(templateOptions));
  assert.ok(templateAliasOptions.includes("--into"), JSON.stringify(templateAliasOptions));
});
