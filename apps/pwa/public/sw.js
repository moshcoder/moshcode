/* moshcode PWA service worker — offline app shell (network-first for docs). */
const CACHE = "moshcode-v1";
const SHELL = ["/", "/icon.svg", "/manifest.webmanifest", "/passkey.js"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

// approval push notifications
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) {}
  e.waitUntil(self.registration.showNotification(d.title || "moshcode 🤘", {
    body: d.body || "You have an approval waiting.",
    icon: "/icon.svg",
    badge: "/icon.svg",
    data: { url: d.url || "/app" },
    tag: "moshcode-approval",
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "/app";
  e.waitUntil(clients.matchAll({ type: "window" }).then((cs) => {
    for (const c of cs) if ("focus" in c) { c.navigate(url); return c.focus(); }
    return clients.openWindow(url);
  }));
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
