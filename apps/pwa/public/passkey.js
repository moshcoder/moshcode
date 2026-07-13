/* Passkey button: try to sign in with a discoverable passkey; if there's none,
   register a new one. Uses the @simplewebauthn/browser UMD bundle (/vendor). */
(function () {
  var btn = document.getElementById("passkey-btn");
  var msg = document.getElementById("passkey-msg");
  if (!btn) return;

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
  function say(t) { if (msg) msg.textContent = t; }

  async function register() {
    say("creating a passkey…");
    var opts = await (await post("/auth/passkey/register/options")).json();
    var att = await SimpleWebAuthnBrowser.startRegistration({ optionsJSON: opts });
    var r = await post("/auth/passkey/register/verify", att);
    var out = await r.json();
    if (out.ok) location.href = out.redirect || "/";
    else say(out.error || "couldn't create passkey");
  }

  async function login() {
    var opts = await (await post("/auth/passkey/login/options")).json();
    var asr = await SimpleWebAuthnBrowser.startAuthentication({ optionsJSON: opts });
    var r = await post("/auth/passkey/login/verify", asr);
    var out = await r.json();
    if (out.ok) { location.href = out.redirect || "/"; return true; }
    throw new Error(out.error || "sign-in failed");
  }

  btn.addEventListener("click", async function () {
    if (!window.PublicKeyCredential) { say("this device doesn't support passkeys"); return; }
    btn.disabled = true;
    try {
      await login();
    } catch (e) {
      // no discoverable credential / user cancelled login → offer to register
      try { await register(); }
      catch (e2) { say(String(e2.message || e2)); }
    } finally {
      btn.disabled = false;
    }
  });
})();
