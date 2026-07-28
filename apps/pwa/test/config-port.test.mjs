import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

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

test("config trims PORT before building the fallback origin", () => {
  const res = loadConfig({ PORT: "3000 " });
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout), {
    port: 3000,
    origin: "http://localhost:3000",
    rpID: "localhost",
  });
});

test("config rejects a non-integer PORT before building the fallback origin", () => {
  const res = loadConfig({ PORT: "abc" });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /PORT must be a decimal integer/);
});

test("config rejects a PORT outside the TCP range", () => {
  const res = loadConfig({ PORT: "65536" });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /PORT must be between 0 and 65535/);
});
