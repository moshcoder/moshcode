import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../bin/moshcode.mjs", import.meta.url));
const SOURCE = "https://github.com/acme/cool-skill.git";

for (const extraArgs of [["--name"], ["--name", "--bogus"]]) {
  test(`skill install rejects ${extraArgs.join(" ")} without a name value`, () => {
    const result = spawnSync(process.execPath, [BIN, "skill", "install", SOURCE, ...extraArgs], {
      encoding: "utf8",
    });

    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /--name requires a value/);
    assert.doesNotMatch(result.stdout, /installing skill/);
  });
}
