// The mail host behind a guard address.
//
// A guard address only works if something actually receives mail at
// `<token>@moshcode.sh` and forwards it on. That is Forward Email, which is
// already where profullstack.com's mail lives, and which exposes alias
// management over a plain REST API -- so an alias can be minted the moment a
// holder opts in rather than by hand.
//
// This module knows nothing about names, endings or the database. It creates,
// disables and destroys aliases at a domain, and reports what the host said.
// src/moshpit.mjs decides when to call it and records the outcome.
//
// Every function is safe to call when the API key is missing: it returns a
// `skipped` result rather than throwing, and the caller leaves the contact in
// `pending`, which publishes nothing. That is what development looks like, and
// it is also what production looks like for the window between this shipping
// and the key being set -- in both cases a contact is recorded and simply not
// advertised yet.
import { config } from "../config.mjs";

/** Forward Email authenticates with the API key as the basic-auth username and no password. */
const authHeader = (apiKey) => `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`;

/**
 * Ten seconds, then give up.
 *
 * An opt-in happens inside a form post the holder is waiting on, so this cannot
 * hang the request. Losing the race is not losing the work: the contact row is
 * already written as `pending` before the host is called, and the reconcile
 * path picks it up.
 */
const TIMEOUT_MS = 10_000;

const enabled = () => Boolean(config.forwardEmail.apiKey && config.forwardEmail.domain);

/**
 * One call to the host, with the failure modes flattened into a result.
 *
 * Network errors, timeouts and HTTP errors all come back the same shape,
 * because the caller does the same thing with all three -- record why, publish
 * nothing, allow a retry. An exception here would abort a form post that has
 * already successfully saved the holder's address.
 */
async function call(method, path, body) {
  if (!enabled()) return { ok: false, skipped: true, error: "mail host not configured" };
  const url = `${config.forwardEmail.apiBase}${path}`;
  try {
    const res = await fetch(url, {
      method,
      headers: {
        authorization: authHeader(config.forwardEmail.apiKey),
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (!res.ok) {
      // Their errors carry a `message`; fall back to the status so a holder is
      // never shown an empty reason for something that plainly did not work.
      const message = json?.message || json?.error || `mail host returned ${res.status}`;
      return { ok: false, status: res.status, error: String(message).slice(0, 300) };
    }
    return { ok: true, data: json };
  } catch (e) {
    const reason = e?.name === "TimeoutError" ? "mail host timed out" : e?.message || "mail host unreachable";
    return { ok: false, error: String(reason).slice(0, 300) };
  }
}

/**
 * Mint `<token>@domain` forwarding to `recipient`.
 *
 * `has_recipient_verification` is the load-bearing flag and it is deliberately
 * always on. Without it, anyone could type a stranger's address into the
 * contact field and have the registry forward mail to a person who never asked
 * for any -- a spam relay wearing our domain. With it, the recipient gets one
 * confirmation link and nothing flows until they click it, so publishing a
 * guard address requires consent from the address itself and not just from
 * whoever filled in the form.
 *
 * `error_code_if_disabled` is 550 rather than the default 250: when an alias is
 * disabled, a sender should be told the mail did not arrive. Quietly accepting
 * and discarding it is the wrong answer for an address published as a way to
 * reach somebody.
 */
export async function createGuardAlias({ token, recipient, description = "", isEnabled = true }) {
  const res = await call("POST", `/v1/domains/${encodeURIComponent(config.forwardEmail.domain)}/aliases`, {
    name: token,
    recipients: [recipient],
    description,
    // Passed rather than hardcoded true. A holder whose first save is `public`
    // or `none` still gets the alias minted — the address is their identity and
    // has to exist before the day they switch it on — but it must not be
    // forwarding mail they have not asked it to forward.
    is_enabled: Boolean(isEnabled),
    has_recipient_verification: true,
    error_code_if_disabled: 550,
    labels: ["moshpit-guard"],
  });
  if (!res.ok) return res;
  const id = res.data?.id || res.data?._id || null;
  // An alias we cannot address later is only half created: without the id there
  // is no way to repoint or revoke it, and revocation is the part that matters.
  if (!id) return { ok: false, error: "mail host created the alias without returning an id" };
  return { ok: true, id };
}

/** Repoint an existing alias, or switch it on and off, without changing its address. */
export async function updateGuardAlias({ id, recipient, isEnabled }) {
  const body = {};
  if (recipient !== undefined) body.recipients = [recipient];
  if (isEnabled !== undefined) body.is_enabled = Boolean(isEnabled);
  const res = await call(
    "PUT",
    `/v1/domains/${encodeURIComponent(config.forwardEmail.domain)}/aliases/${encodeURIComponent(id)}`,
    body,
  );
  return res.ok ? { ok: true, id } : res;
}

/**
 * Destroy the alias.
 *
 * Used when a contact is removed and when a name changes hands. A 404 counts as
 * success: the goal is "this address forwards to nobody", and an alias the host
 * has already lost is in that state. Treating it as a failure would leave the
 * row stuck, retrying forever against something that does not exist.
 */
export async function deleteGuardAlias({ id }) {
  const res = await call(
    "DELETE",
    `/v1/domains/${encodeURIComponent(config.forwardEmail.domain)}/aliases/${encodeURIComponent(id)}`,
  );
  if (!res.ok && res.status === 404) return { ok: true, id };
  return res.ok ? { ok: true, id } : res;
}

/** Whether guard addresses can be minted at all right now. */
export const guardMailConfigured = enabled;
