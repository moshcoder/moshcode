// /privacy and /terms answer 200 with their headings, outside the session and
// database, and the brand footer links them.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
let express = null;
try { express = require("express"); } catch { express = null; }

test("legal pages render, link each other, and carry no dashes", { skip: !express && "pwa deps not installed" }, async () => {
  const { legalRouter } = await import("../src/routes/legal.mjs");
  const { footer } = await import("../src/lib/html.mjs");
  assert.match(footer, /href="\/privacy"/);
  assert.match(footer, /href="\/terms"/);
  const app = express();
  app.use(legalRouter);
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const [path, heading] of [["/privacy", "Privacy Policy"], ["/terms", "Terms of Service"]]) {
      const res = await fetch(base + path);
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.ok(html.includes(`<h1>${heading}</h1>`));
      assert.ok(html.includes(`<title>${heading}`));
      assert.ok(html.includes("Effective date: November 11, 2026"));
      assert.ok(html.includes('href="/privacy"') && html.includes('href="/terms"'));
      assert.doesNotMatch(html, /[–—]/);
    }
    assert.match(await (await fetch(base + "/privacy")).text(), /app\.moshcode\.sh\/mcp/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
