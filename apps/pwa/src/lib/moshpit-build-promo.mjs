// The build-and-host offer, drawn on /pit.
//
// Somebody who has just bought a name has a name and nothing at it. The
// hosting help explains how to point it at a server of their own; this is the
// other answer, for everyone without one: describe the app, chovy.com builds it
// on the Profullstack stack and keeps it online. The storefront is
// pit.world/build; the form here posts straight to the same intake it does, so
// one click from the pit skips a page.
import { esc } from "./html.mjs";

export const BUILD_URL = "https://pit.world/build";
export const BUILD_START_URL = "https://chovy.com/start";
export const BUILD_PRICE_USD = 49;
export const HOSTING_PRICE_USD = 2;

/**
 * The name a `?ok=` banner just handed over, when it handed over exactly one.
 *
 * The buy and claim flows redirect with `ok=<name> is yours.`; that sentence is
 * the only record on the page of what was bought, so the offer reads it rather
 * than guessing at the newest row.
 */
export function boughtName(ok) {
  const m = /^([a-z0-9-]+\.[a-z0-9-]+) is yours\.?$/i.exec(String(ok ?? "").trim());
  return m ? m[1].toLowerCase() : null;
}

/**
 * The card. `name` is the name just bought, when there is one: the offer then
 * talks about that name and seeds the idea with it.
 */
export function buildPromo({ name = null } = {}) {
  const forName = name ? ` for <span class="mono acid">${esc(name)}</span>` : "";
  const seed = name ? `A site at ${name}: ` : "";
  return `<section class="pit-build" aria-labelledby="pit-build-h">
  <p class="label">no server? no problem</p>
  <h2 id="pit-build-h">We build it${forName}. We host it.</h2>
  <p class="pit-copy">Describe the app in plain words. An AI product team writes a plan you can argue
    with, builds it on the open source <a class="acid" href="https://profullstack.com/stack">Profullstack
    stack</a>, and shows you it working before anything launches.
    <b>$${BUILD_PRICE_USD}</b> to build, including the first 30 days, then <b>$${HOSTING_PRICE_USD} a month</b>
    to keep it online. Paid in crypto through CoinPay.</p>
  <form class="pit-build-form" action="${BUILD_START_URL}" method="get">
    <textarea name="idea" rows="3" maxlength="2000" required
      aria-label="describe the app you want built"
      placeholder="A booking page for my barbershop: customers pick a barber and a time, pay a deposit, and get a text reminder.">${esc(seed)}</textarea>
    <input type="hidden" name="plan" value="starter">
    <input type="hidden" name="ref" value="moshpit">
    <div class="pit-row">
      <button class="btn acid" type="submit">Build it for $${BUILD_PRICE_USD} →</button>
      <a class="mono faint" style="font-size:.78rem" href="${BUILD_URL}">how build + hosting works</a>
    </div>
  </form>
</section>`;
}

export const BUILD_PROMO_CSS = `
.pit-build{border:1px solid var(--acid);border-radius:var(--r);background:color-mix(in srgb,var(--acid) 6%,var(--surface));
  padding:18px 20px;margin:18px 0;max-width:72ch}
.pit-build h2{font-size:clamp(1.2rem,3.4vw,1.6rem);margin:4px 0 8px}
.pit-build b{color:var(--acid);font-weight:600}
.pit-build-form textarea{width:100%;box-sizing:border-box;background:var(--bg);color:var(--text);
  border:1px solid var(--line-2);border-radius:8px;padding:10px 12px;font:inherit;font-size:.9rem;margin-top:10px;resize:vertical}
.pit-build-form textarea:focus{border-color:var(--acid);outline:0}
`;
