/* Web-push toggle for approvals. Reflects whether THIS device is subscribed:
   "Enable push on this device" ⇄ "Disable notifications on this device". */
(function () {
  var btn = document.getElementById("push-btn");
  if (!btn) return;
  var VAPID = btn.getAttribute("data-vapid");

  function csrf() {
    var m = document.cookie.match(/(?:^|; )mc_csrf=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : "";
  }
  function post(url, body) {
    return fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": csrf() },
      body: JSON.stringify(body || {}),
    });
  }
  function urlB64ToUint8(base64) {
    var pad = "=".repeat((4 - (base64.length % 4)) % 4);
    var b64 = (base64 + pad).replace(/-/g, "+").replace(/_/g, "/");
    var raw = atob(b64), out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }
  function setState(on) {
    btn.dataset.on = on ? "1" : "0";
    btn.textContent = on ? "🔕 Disable notifications on this device" : "🔔 Enable push on this device";
    btn.classList.toggle("danger", on);
  }

  async function enable() {
    var perm = await Notification.requestPermission();
    if (perm !== "granted") { btn.textContent = "permission denied"; return; }
    var reg = await navigator.serviceWorker.ready;
    var sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8(VAPID) });
    var j = sub.toJSON();
    var r = await post("/push/subscribe", { endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth });
    if (r.ok) setState(true); else btn.textContent = "failed — retry";
  }
  async function disable() {
    var reg = await navigator.serviceWorker.ready;
    var sub = await reg.pushManager.getSubscription();
    if (sub) { await post("/push/unsubscribe", { endpoint: sub.endpoint }); await sub.unsubscribe(); }
    setState(false);
  }

  btn.addEventListener("click", async function () {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) { btn.disabled = true; btn.textContent = "push unsupported"; return; }
    if (!VAPID) { btn.textContent = "push not configured"; return; }
    btn.disabled = true;
    try { if (btn.dataset.on === "1") await disable(); else await enable(); }
    catch (e) { btn.textContent = "failed — retry"; }
    finally { btn.disabled = false; }
  });

  // reflect current state on load
  (async function () {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) { btn.disabled = true; btn.textContent = "push unsupported here"; return; }
    try { var reg = await navigator.serviceWorker.ready; setState(!!(await reg.pushManager.getSubscription())); }
    catch (e) { /* leave default label */ }
  })();
})();
