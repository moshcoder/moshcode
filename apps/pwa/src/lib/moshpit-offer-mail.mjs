// The four mails an offer sends, and nothing else.
//
// An offer is a conversation between two people who have no other way to reach
// each other, so mail is not a notification here -- it is the channel. Each of
// these is one side learning it is their turn.
//
// Every send is best-effort and says so in its return value. A failed mail must
// never lose an offer that is already recorded: the row is the fact, and the
// holder can see it on /pit/offers whether or not the mail arrived.
import { config } from "../config.mjs";
import { esc } from "./html.mjs";
import { agreedTerms, describeOffer } from "./moshpit-offer.mjs";

const offerName = (offer) => (offer.label ? `${offer.label}.${offer.tld}` : `.${offer.tld}`);

/**
 * The house style, such as it is -- the same dark card the approval mails use.
 *
 * Plain enough to survive a client that strips the CSS, because the one thing
 * that has to work in every reader is the link.
 */
const wrap = (title, lines, cta) => `
<div style="font-family:ui-monospace,monospace;background:#070806;color:#edf2e4;padding:24px;border-radius:12px">
  <p style="color:#a6ff1a;letter-spacing:.2em;text-transform:uppercase;font-size:12px">the moshpit</p>
  <h2 style="color:#edf2e4;margin:0 0 14px">${esc(title)}</h2>
  ${lines.map((l) => `<p style="color:#969d85;margin:6px 0">${l}</p>`).join("")}
  ${cta ? `<a href="${esc(cta.url)}" style="display:inline-block;background:#a6ff1a;color:#0a1400;font-weight:700;padding:12px 18px;border-radius:8px;text-decoration:none;margin-top:16px">${esc(cta.label)}</a>` : ""}
  <p style="color:#5d6350;font-size:12px;margin-top:20px">no bugs, only features. 🤘</p>
</div>`;

async function send(to, subject, html) {
  if (!config.resend.apiKey) {
    console.log(`[offer-mail:stub] → ${to}: ${subject}`);
    return { ok: true, stubbed: true };
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${config.resend.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ from: config.resend.from, to, subject, html }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.error(`[offer-mail] resend ${res.status} for ${subject}`);
      return { ok: false, error: `mail provider returned ${res.status}` };
    }
    return { ok: true };
  } catch (e) {
    console.error(`[offer-mail] ${e?.message ?? e}`);
    return { ok: false, error: "could not send the mail" };
  }
}

/**
 * To the offerer: prove this address wanted to send that.
 *
 * The only mail sent before anything is verified, and the only one that goes to
 * an address nobody has checked. It says exactly what was offered, because the
 * other reason someone gets this mail is that a stranger typed their address
 * into our form -- and that person needs enough to recognise it as not theirs
 * and ignore it.
 */
export const sendOfferVerification = (offer, url) => send(
  offer.offerer_email,
  `Confirm your offer on ${offerName(offer)}`,
  wrap("One click and the holder sees it", [
    `You offered <b style="color:#edf2e4">${esc(describeOffer(offer))}</b>.`,
    "Nobody has been told yet. Confirming is what sends it to whoever holds the name.",
    "If this was not you, nothing happens — do not click, and the offer expires on its own.",
  ], { url, label: "Confirm the offer →" }),
);

/** To the holder: somebody wants your name. */
export const sendOfferToHolder = (offer, holderEmail, url) => send(
  holderEmail,
  `Offer on ${offerName(offer)} — ${describeOffer(offer)}`,
  wrap(`Somebody wants ${offerName(offer)}`, [
    `<b style="color:#edf2e4">${esc(describeOffer(offer))}</b>`,
    offer.message ? `They said: “${esc(offer.message)}”` : "They left no message.",
    "Accept it, refuse it, or name a different number. Nothing happens until you do.",
  ], { url, label: "Answer the offer →" }),
);

/** To the offerer: the holder has answered. */
export function sendOfferAnswer(offer, url) {
  const terms = agreedTerms(offer);
  const name = offerName(offer);
  if (offer.status === "accepted") {
    return send(offer.offerer_email, `Your offer on ${name} was accepted`,
      wrap(`${name} is yours to pay for`, [
        `The holder accepted <b style="color:#edf2e4">${esc(describeOffer(offer))}</b>.`,
        "Nothing has moved yet. Sign in with this address and pay, and the name is transferred on confirmation.",
      ], { url, label: "Pay and take it →" }));
  }
  if (offer.status === "countered") {
    return send(offer.offerer_email, `Counter-offer on ${name}`,
      wrap(`The holder named a different number`, [
        `They countered at <b style="color:#edf2e4">$${esc(String(terms.amountUsd))}</b>${
          terms.months ? ` for ${esc(String(terms.months))} months` : ""}.`,
        "Take it or leave it — either answer ends the wait.",
      ], { url, label: "See the counter →" }));
  }
  return send(offer.offerer_email, `Your offer on ${name} was not taken`,
    wrap(`No on ${name}`, [
      "The holder turned the offer down. Nothing was charged.",
      "You can make another one later if the name is still there.",
    ], { url, label: "Look at the name →" }));
}

/** To the tenant and the holder: a lease has started. */
export const sendLeaseStarted = (offer, expiresAt, url) => send(
  offer.offerer_email,
  `You now hold ${offerName(offer)} until ${new Date(expiresAt).toISOString().slice(0, 10)}`,
  wrap(`${offerName(offer)} is yours to use`, [
    `Point it, publish under it, put records and keys on it — until <b style="color:#edf2e4">${
      esc(new Date(expiresAt).toISOString().slice(0, 10))}</b>.`,
    "It reverts to its holder on that date, and what it was serving stops being served. Nothing renews.",
  ], { url, label: "Set it up →" }),
);
