// The service behind Caddy.
//
// Bound to loopback on purpose. Caddy is the only client, and binding this to
// the public address would publish it on a port nothing virtual-hosts — which
// hands anyone scanning the box the app with the name stripped off the front.

import { migrate, recordVisit } from "./db";

const PORT = Number(process.env.PORT || 3000);
const HOSTNAME = process.env.HOST || "127.0.0.1";

await migrate();

const server = Bun.serve({
  port: PORT,
  hostname: HOSTNAME,

  async fetch(req) {
    const url = new URL(req.url);

    // The Moshpit name arrives in a header and nowhere else. Nothing on this
    // box resolved it — the visitor's resolver did, then connected straight
    // here. `x-moshpit-name` is set when the request came through the
    // pit.moshcode.sh gateway; `host` is what a direct visit carries.
    const name = req.headers.get("x-moshpit-name") || req.headers.get("host") || "(no host header)";

    if (url.pathname === "/health") {
      return Response.json({ ok: true, name });
    }

    const visits = await recordVisit(name, url.pathname);
    return new Response(
      `${name} is served from this box.\n\npath:   ${url.pathname}\nvisits: ${visits}\n`,
      { headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  },

  error(err) {
    console.error(err);
    return new Response("internal error\n", { status: 500 });
  },
});

console.log(`listening on ${server.hostname}:${server.port}`);
