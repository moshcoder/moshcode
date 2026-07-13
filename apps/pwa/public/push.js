/* Enable web-push for approvals. Subscribes this device and stores it server-side. */
(function () {
  var btn = document.getElementById("push-btn");
  if (!btn) return;
  var VAPID = btn.getAttribute("data-vapid");

  function csrf() {
    var m = document.cookie.match(/(?:^|; )mc_csrf=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : "";
  }
  function urlB64ToUint8(base64) {
    var pad = "=".repeat((4 - (base64.length % 4)) % 4);
    var b64 = (base64 + pad).replace(/-/g, "+").replace(/_/g, "/");
    var raw = atob(b64);
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  btn.addEventListener("click", async function () {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) { btn.textContent = "push unsupported"; return; }
    if (!VAPID) { btn.textContent = "push not configured"; return; }
    btn.disabled = true; btn.textContent = "enabling…";
    try {
      var perm = await Notification.requestPermission();
      if (perm !== "granted") { btn.textContent = "permission denied"; btn.disabled = false; return; }
      var reg = await navigator.serviceWorker.ready;
      var sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8(VAPID) });
      var json = sub.toJSON();
      var r = await fetch("/push/subscribe", {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": csrf() },
        body: JSON.stringify({ endpoint: json.endpoint, p256dh: json.keys.p256dh, auth: json.keys.auth }),
      });
      btn.textContent = r.ok ? "✓ push enabled" : "failed — retry";
      btn.disabled = r.ok;
    } catch (e) {
      btn.textContent = "failed — retry"; btn.disabled = false;
    }
  });
})();
