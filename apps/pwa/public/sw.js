/* moshcode PWA service worker — offline app shell (network-first for docs). */
const CACHE = "moshcode-v4";
const SHELL = ["/", "/icon.svg", "/manifest.webmanifest", "/passkey.js"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

// Push: approvals, and the herd (PRD 0020). A herd push for a permission
// prompt carries Allow / Deny actions and a one-time token; tapping one answers
// the agent from the notification without opening the app. Platforms that show
// no action buttons (Safari) open the pane, where the same buttons are.
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) {}
  const options = {
    body: d.body || "You have an approval waiting.",
    icon: "/icon.svg",
    badge: "/icon.svg",
    data: { url: d.url || "/", act: d.act || null },
    tag: d.tag || "moshcode-approval",
    renotify: Boolean(d.tag),
    requireInteraction: Boolean(d.requireInteraction),
  };
  if (Array.isArray(d.actions) && d.actions.length) options.actions = d.actions.slice(0, 2);
  e.waitUntil(self.registration.showNotification(d.title || "moshcode 🤘", options));
});

async function act(data, intent) {
  try {
    const res = await fetch("/api/herd/act", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: data.act.token, intent }),
    });
    const body = await res.json().catch(() => ({}));
    const said = res.ok ? (intent === "allow" ? "allowed" : "denied")
      : body.stale ? "already answered" : (body.error || "could not answer");
    await self.registration.showNotification(`moshcode: ${said}`, { body: "", icon: "/icon.svg", tag: "moshcode-herd-ack", data: { url: data.url } });
  } catch (_) {
    return openUrl(data.url);
  }
}

function openUrl(url) {
  return clients.matchAll({ type: "window" }).then((cs) => {
    for (const c of cs) if ("focus" in c) { c.navigate(url); return c.focus(); }
    return clients.openWindow(url);
  });
}

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const data = e.notification.data || {};
  if ((e.action === "allow" || e.action === "deny") && data.act && data.act.token) {
    e.waitUntil(act(data, e.action));
    return;
  }
  e.waitUntil(openUrl(data.url || "/"));
});

self.addEventListener("fetch", (e) => {
  const { request } = e;
  if (request.method !== "GET") return; // never cache POSTs / API writes
  const url = new URL(request.url);
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/") || url.pathname.startsWith("/webhooks/")) return;

  // network-first, fall back to cache (so approvals stay fresh, offline still loads a shell)
  e.respondWith(
    fetch(request)
      .then((res) => {
        if (res.ok && url.origin === location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(request, copy));
        }
        return res;
      })
      .catch(() => caches.match(request).then((r) => r || caches.match("/")))
  );
});
