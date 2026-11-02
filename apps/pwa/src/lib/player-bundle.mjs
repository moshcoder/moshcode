/**
 * @profullstack/player for the browser, served from app.moshcode.sh's own origin.
 *
 * The PWA has no client build step: public/ is plain JS. The player's dist imports hls.js and
 * mpegts.js by bare name, so it cannot be served from node_modules as it stands; it is bundled
 * here instead, once, the first time it is asked for, into one ES module (/pf-player.js) plus its
 * stylesheet (/pf-player.css). public/pf-player-init.js imports it only on a page with a
 * [data-pf-player] host. Same pattern as pit.world's src/player-bundle.ts. Needs Bun (the
 * production runtime); under Node the route answers 503 and the native <video> stays.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

let js = null;
let css = null;

export function playerJs() {
  js ??= (async () => {
    if (typeof Bun === "undefined") throw new Error("player bundle needs the Bun runtime");
    const out = await Bun.build({
      entrypoints: [new URL("../client/player-entry.mjs", import.meta.url).pathname],
      target: "browser",
      format: "esm",
      splitting: false,
      minify: true,
    });
    if (!out.success) throw new Error(`player bundle failed: ${out.logs.map((l) => l.message).join("; ")}`);
    return await out.outputs[0].text();
  })().catch((error) => {
    js = null;
    throw error;
  });
  return js;
}

export function playerCss() {
  css ??= readFileSync(createRequire(import.meta.url).resolve("@profullstack/player/player.css"), "utf8");
  return css;
}
