import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import test from "node:test";

// src/config.mjs imports @profullstack/notifications, a PWA dependency that a
// root `pnpm install` does not install. Probe for it so these tests skip on a
// bare clone instead of failing on ERR_MODULE_NOT_FOUND in the child process.
// The package only exports ESM entry points, so require() its package.json.
const require = createRequire(import.meta.url);
let hasDeps = true;
try {
  require("@profullstack/notifications/package.json");
} catch {
  hasDeps = false; // pwa dependencies not installed — tests below skip
}
const skip = hasDeps ? false : "pwa dependencies not installed";

const CONFIG = new URL("../src/config.mjs", import.meta.url);

function loadConfig(env) {
  return spawnSync(process.execPath, [
    "--input-type=module",
    "-e",
    `import(${JSON.stringify(CONFIG.href)})
      .then(({ config }) => {
        console.log(JSON.stringify({ port: config.port, origin: config.origin, rpID: config.rpID }));
      })
      .catch((err) => {
        console.error(err.message);
        process.exit(1);
      });`,
  ], {
    env: {
      ...process.env,
      PUBLIC_ORIGIN: "",
      PORT: "",
      ...env,
    },
    encoding: "utf8",
  });
}

test("config trims PORT before building the fallback origin", { skip }, () => {
  const res = loadConfig({ PORT: "3000 " });
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout), {
    port: 3000,
    origin: "http://localhost:3000",
    rpID: "localhost",
  });
});

test("config rejects a non-integer PORT before building the fallback origin", { skip }, () => {
  const res = loadConfig({ PORT: "abc" });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /PORT must be a decimal integer/);
});

test("config rejects a PORT outside the TCP range", { skip }, () => {
  const res = loadConfig({ PORT: "65536" });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /PORT must be between 0 and 65535/);
});
