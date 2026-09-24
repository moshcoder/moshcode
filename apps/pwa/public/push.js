/* Web-push toggle for approvals. Reflects whether THIS device is subscribed:
   "Enable push on this device" ⇄ "Disable notifications on this device".
   Runs on @profullstack/notifications/client: the VAPID key is fetched from
   /api/push/vapid-public-key when subscribing, and when push cannot work here
   pushSupport() says why (not HTTPS, iPhone without Home Screen, blocked…). */
import { pushSupport, subscribe, unsubscribe, getSubscription } from "/vendor/notifications-client.js";

const btn = document.getElementById("push-btn");
const why = document.getElementById("push-why");

function csrf() {
  const m = document.cookie.match(/(?:^|; )mc_csrf=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : "";
}
function explain(message) {
  if (!why) return;
  why.textContent = message || "";
  why.hidden = !message;
}
function setState(on) {
  btn.dataset.on = on ? "1" : "0";
  btn.textContent = on ? "🔕 Disable notifications on this device" : "🔔 Enable push on this device";
  btn.classList.toggle("danger", on);
}

async function enable() {
  await subscribe({ saveUrl: "/push/subscribe", headers: { "x-csrf-token": csrf() } });
  explain("");
  setState(true);
}
async function disable() {
  await unsubscribe({ removeUrl: "/push/unsubscribe", headers: { "x-csrf-token": csrf() } });
  setState(false);
}

if (btn) {
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    try {
      if (btn.dataset.on === "1") await disable(); else await enable();
    } catch (e) {
      btn.textContent = e && e.reason === "denied" ? "permission denied" : "failed — retry";
      explain(e && e.message);
    } finally {
      btn.disabled = false;
    }
  });

  // reflect current state on load, and say why when push cannot work here
  (async () => {
    const support = pushSupport();
    if (!support.supported) {
      explain(support.message);
      if (support.reason !== "denied") { btn.disabled = true; btn.textContent = "push unsupported here"; return; }
    }
    try { setState(!!(await getSubscription())); }
    catch (e) { /* leave default label */ }
  })();
}
