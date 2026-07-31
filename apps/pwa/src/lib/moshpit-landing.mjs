// What to offer someone who arrived by typing a Moshpit name.
//
// Somebody puts `mosh.whatever` in the address bar. Either a resolver sent
// them here or the gateway did, and the one thing they must not get is a 404 —
// they just demonstrated demand for a name, which is the entire product.
//
// What can honestly be offered depends on who holds the ending and whether they
// put a price on it. This picks the answer without a database or a request, so
// the wording is testable and cannot drift from the rules in `registerName`
// (owners mint for free) and `quoteName` (everyone else buys, if it is listed).

import { parseMoshpitName } from "./moshpit-name.mjs";

/**
 * @param {object} state
 * @param {boolean} state.tldOwned      is `.whatever` claimed by anyone
 * @param {boolean} state.ownedByViewer …by the person looking at the page
 * @param {boolean} state.nameRegistered is `mosh.whatever` itself minted
 * @param {string|null} state.target     where the name points, when it points
 * @param {number|null} state.priceUsd   what the owner charges per name, if listed
 */
export function landingFor(input, state = {}) {
  const parsed = parseMoshpitName(input);
  if (!parsed) return { kind: "none" };
  const { label, tld } = parsed;
  const base = { label, tld, name: `${label}.${tld}` };

  // Nobody holds the ending. The visitor can have it and everything under it —
  // the best possible answer to "this name does not exist yet".
  if (!state.tldOwned) return { ...base, kind: "claim-tld" };

  // They hold it: this is the one case where the name is one form away.
  if (state.ownedByViewer) {
    return { ...base, kind: state.nameRegistered ? "yours" : "mint-name" };
  }

  // Someone else's ending. Taken is taken, whatever the price.
  if (state.nameRegistered) {
    return { ...base, kind: "taken", target: state.target ?? null };
  }

  // Free, and the operator has put a price on names under it — so this visitor
  // can have the exact name they typed, right now, for that much.
  const priceUsd = state.priceUsd;
  if (priceUsd !== null && priceUsd !== undefined) {
    return { ...base, kind: "buy", priceUsd };
  }

  // Free, but not for sale. Say so rather than inviting them into a checkout
  // that `quoteName` would refuse.
  return { ...base, kind: "not-for-sale" };
}
