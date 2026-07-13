// Passkey (WebAuthn) auth: register a new passkey-first user, or sign in with a
// discoverable credential. Client uses @simplewebauthn/browser (served at /vendor).
import { Router } from "express";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import { get, run } from "../db.mjs";
import { config } from "../config.mjs";
import { id } from "../lib/crypto.mjs";
import { createSession, setCeremony, getCeremony, clearCeremony } from "../lib/session.mjs";
import { createUserPasskey, userById } from "../lib/users.mjs";

export const passkeyRouter = Router();
const enc = (s) => new TextEncoder().encode(s);

// ---- registration (new passkey-first account, or add to the logged-in user) ----
passkeyRouter.post("/auth/passkey/register/options", async (req, res) => {
  const handle = req.user?.id || id();
  const name = req.user?.email || req.user?.display_name || `moshcoder-${handle.slice(0, 6)}`;
  const options = await generateRegistrationOptions({
    rpName: config.rpName,
    rpID: config.rpID,
    userName: name,
    userID: enc(handle),
    attestationType: "none",
    authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
  });
  setCeremony(res, "reg", { challenge: options.challenge, handle, name, existing: Boolean(req.user) });
  res.json(options);
});

passkeyRouter.post("/auth/passkey/register/verify", async (req, res) => {
  const ceremony = getCeremony(req, "reg");
  if (!ceremony) return res.status(400).json({ error: "registration expired — try again" });
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: req.body,
      expectedChallenge: ceremony.challenge,
      expectedOrigin: config.origin,
      expectedRPID: config.rpID,
    });
  } catch (e) {
    return res.status(400).json({ error: String(e.message || e) });
  }
  if (!verification.verified) return res.status(400).json({ error: "could not verify passkey" });

  const { credential } = verification.registrationInfo;
  const user = ceremony.existing ? await userById(ceremony.handle) : await createUserPasskey(ceremony.name);
  await run(
    `INSERT INTO webauthn_credentials (id, user_id, public_key, counter, transports, created_at) VALUES (?,?,?,?,?,?)`,
    [
      credential.id,
      user.id,
      Buffer.from(credential.publicKey).toString("base64url"),
      credential.counter || 0,
      JSON.stringify(credential.transports || req.body.response?.transports || []),
      Date.now(),
    ]
  );
  clearCeremony(res, "reg");
  await createSession(res, user.id);
  res.json({ ok: true, redirect: "/app" });
});

// ---- authentication (discoverable / usernameless sign-in) ----
passkeyRouter.post("/auth/passkey/login/options", async (req, res) => {
  const options = await generateAuthenticationOptions({
    rpID: config.rpID,
    allowCredentials: [], // discoverable credentials
    userVerification: "preferred",
  });
  setCeremony(res, "auth", { challenge: options.challenge });
  res.json(options);
});

passkeyRouter.post("/auth/passkey/login/verify", async (req, res) => {
  const ceremony = getCeremony(req, "auth");
  if (!ceremony) return res.status(400).json({ error: "sign-in expired — try again" });
  const cred = await get(`SELECT * FROM webauthn_credentials WHERE id = ?`, [req.body.id]);
  if (!cred) return res.status(400).json({ error: "unknown passkey — create an account" });

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: req.body,
      expectedChallenge: ceremony.challenge,
      expectedOrigin: config.origin,
      expectedRPID: config.rpID,
      credential: {
        id: cred.id,
        publicKey: Buffer.from(cred.public_key, "base64url"),
        counter: Number(cred.counter),
        transports: JSON.parse(cred.transports || "[]"),
      },
    });
  } catch (e) {
    return res.status(400).json({ error: String(e.message || e) });
  }
  if (!verification.verified) return res.status(400).json({ error: "passkey did not verify" });

  await run(`UPDATE webauthn_credentials SET counter = ? WHERE id = ?`,
    [verification.authenticationInfo.newCounter, cred.id]);
  clearCeremony(res, "auth");
  await createSession(res, cred.user_id);
  res.json({ ok: true, redirect: "/app" });
});
