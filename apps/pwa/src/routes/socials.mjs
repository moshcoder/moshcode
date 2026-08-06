// Browser-side social composers. The CLI only hands a draft to these pages;
// account authorization and the final publish stay in the user's browser.
import { Router } from "express";
import { page, footer } from "../lib/html.mjs";

export const socialsRouter = Router();

export const NOSTR_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.primal.net",
];

export function nostrComposerPage() {
  const relays = JSON.stringify(NOSTR_RELAYS);
  const body = `
  <header class="bar"><div class="wrap bar-inner">
    <a class="brand" href="/"><span class="mark">M</span>MOSHCODE<span class="app">socials</span></a>
    <a class="btn" href="/">Back to the pit</a>
  </div></header>
  <main class="wrap" style="max-width:760px;padding:44px 0 64px">
    <div class="label acid" style="margin-bottom:10px">NOSTR · KIND 1</div>
    <h1 style="font-size:2rem;margin:0 0 10px">Post from the pit.</h1>
    <p class="dim mono" style="margin:0 0 24px;line-height:1.65">Your draft stayed in the URL fragment—it was never sent to MoshCode. Connect a browser signer, review the text, then publish it to the relays below.</p>

    <div class="card">
      <div class="card-head"><span class="h">Draft</span><span class="pill" id="count">0 chars</span></div>
      <div class="card-body">
        <textarea id="message" rows="8" autofocus placeholder="what's moshing?" style="width:100%;resize:vertical"></textarea>
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:14px">
          <button class="btn acid" id="publish" type="button">Connect signer + publish</button>
          <span class="mono dim" id="status" role="status" aria-live="polite">nothing is posted until you click</span>
        </div>
      </div>
    </div>

    <div class="card" style="margin-top:18px">
      <div class="card-head"><span class="h">Relays</span><span class="pill">publish to any that accept</span></div>
      <div class="card-body mono dim" style="font-size:.78rem;line-height:1.8">
        ${NOSTR_RELAYS.map((relay) => `<div><span class="beat"></span> ${relay}</div>`).join("")}
      </div>
    </div>
  </main>${footer}

  <script>
    window.wnjParams = { position: "bottom", accent: "green", compactMode: true };
  </script>
  <script src="https://cdn.jsdelivr.net/npm/window.nostr.js@0.5.0/dist/window.nostr.min.js"></script>
  <script>
    (function () {
      var RELAYS = ${relays};
      var message = document.getElementById("message");
      var publish = document.getElementById("publish");
      var status = document.getElementById("status");
      var count = document.getElementById("count");
      message.value = new URLSearchParams(location.hash.slice(1)).get("text") || "";

      function recount() { count.textContent = Array.from(message.value).length + " chars" }
      recount();
      message.addEventListener("input", recount);

      function sendToRelay(relay, event) {
        return new Promise(function (resolve) {
          var settled = false;
          var ws;
          function done(ok, detail) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { ws.close() } catch (_) {}
            resolve({ relay: relay, ok: ok, detail: detail || "" });
          }
          var timer = setTimeout(function () { done(false, "timeout") }, 8000);
          try { ws = new WebSocket(relay) } catch (error) { done(false, error.message); return }
          ws.addEventListener("open", function () { ws.send(JSON.stringify(["EVENT", event])) });
          ws.addEventListener("message", function (incoming) {
            try {
              var reply = JSON.parse(incoming.data);
              if (reply[0] === "OK" && reply[1] === event.id) done(Boolean(reply[2]), String(reply[3] || ""));
            } catch (_) {}
          });
          ws.addEventListener("error", function () { done(false, "connection failed") });
          ws.addEventListener("close", function () { done(false, "closed without an acknowledgement") });
        });
      }

      publish.addEventListener("click", async function () {
        var content = message.value.trim();
        if (!content) { status.textContent = "write something first"; message.focus(); return }
        publish.disabled = true;
        status.textContent = "waiting for your signer…";
        try {
          if (!window.nostr) throw new Error("no Nostr signer is available in this browser");
          var pubkey = await window.nostr.getPublicKey();
          var event = await window.nostr.signEvent({
            kind: 1,
            created_at: Math.floor(Date.now() / 1000),
            tags: [],
            content: content,
            pubkey: pubkey
          });
          status.textContent = "signed—publishing to relays…";
          var results = await Promise.all(RELAYS.map(function (relay) { return sendToRelay(relay, event) }));
          var accepted = results.filter(function (result) { return result.ok });
          if (!accepted.length) {
            var reasons = results.map(function (result) { return result.relay + ": " + result.detail }).join(" · ");
            throw new Error("no relay accepted the event (" + reasons + ")");
          }
          status.textContent = "published to " + accepted.length + "/" + RELAYS.length + " relays 🤘";
          publish.textContent = "Published";
        } catch (error) {
          status.textContent = error && error.message ? error.message : String(error);
          publish.disabled = false;
        }
      });
    })();
  </script>`;

  return page({ title: "moshcode ▸ post to Nostr", body });
}

socialsRouter.get("/socials/nostr", (_req, res) => {
  res.type("html").send(nostrComposerPage());
});
