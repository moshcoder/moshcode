// Blackjack. One hand at a time against a dealer with no choices to make.
//
// House rules, printed here rather than in an options screen nobody reads:
// dealer stands on all 17s, blackjack pays 3:2, double on any first two cards,
// split a pair once, split aces get one card each. The stack is 100 chips and
// the game is over when it is gone.
import { acid, amber, ash, bone, danger, dim } from "./ui.mjs";

export const SUITS = ["♠", "♥", "♦", "♣"];
export const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];

export const START_CHIPS = 100;
export const MIN_BET = 5;
export const BET_STEP = 5;
const RESHUFFLE_AT = 15;

/** A shuffled deck. Fisher–Yates, so the seeded rng in a test gives one deal. */
export function freshDeck(rng = Math.random) {
  const deck = [];
  for (const suit of SUITS) for (const rank of RANKS) deck.push({ rank, suit });
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1)) % (i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

/** Face value; an ace counts eleven here and is talked down by `handValue`. */
export const cardValue = (card) => (card.rank === "A" ? 11 : ["J", "Q", "K"].includes(card.rank) ? 10 : Number(card.rank));

/**
 * The total, and whether an ace is still counting as eleven — which is the only
 * thing that makes a 17 worth hitting.
 */
export function handValue(cards) {
  let total = cards.reduce((sum, c) => sum + cardValue(c), 0);
  let aces = cards.filter((c) => c.rank === "A").length;
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return { total, soft: aces > 0 };
}

/** Twenty-one on the first two cards, and nothing else. */
export const isBlackjack = (cards) => cards.length === 2 && handValue(cards).total === 21;

const clampBet = (bet, chips) => Math.max(Math.min(MIN_BET, chips), Math.min(bet, chips));

function draw(state) {
  if (!state.deck.length) state.deck = freshDeck(state.rng);
  return state.deck.pop();
}

const newHand = (cards, bet) => ({ cards, bet, done: false, doubled: false, result: null, payout: 0 });

/** Chips won or lost, the way a table would say it. */
const signed = (n) => (n > 0 ? acid(`+${n}`) : n < 0 ? danger(`−${Math.abs(n)}`) : ash("even"));

/**
 * Start a hand. The wager leaves the stack now and comes back on settlement,
 * so the chip count on screen is always what you could still walk away with.
 */
export function deal(state) {
  if (state.chips <= 0) { state.over = `broke after ${state.played} hands`; return state; }
  if (state.deck.length < RESHUFFLE_AT) state.deck = freshDeck(state.rng);

  state.bet = clampBet(state.bet, state.chips);
  state.chips -= state.bet;
  state.hands = [newHand([draw(state), draw(state)], state.bet)];
  state.dealer = [draw(state), draw(state)];
  state.hole = true;
  state.active = 0;
  state.phase = "player";
  state.message = "";

  // A natural on either side ends it before anybody gets a decision.
  if (isBlackjack(state.hands[0].cards) || isBlackjack(state.dealer)) settle(state);
  return state;
}

/** The dealer's whole turn: show the hole card, then hit until 17. */
function dealerPlays(state) {
  state.hole = false;
  // With every player hand busted there is nothing to beat, and the dealer does
  // not draw for an audience.
  if (!state.hands.some((h) => handValue(h.cards).total <= 21)) return;
  // A natural is already paid; the dealer does not draw for it. Split hands are
  // not naturals, so two 21s off a pair of aces still get a dealer's turn.
  if (state.hands.length === 1 && isBlackjack(state.hands[0].cards)) return;
  while (handValue(state.dealer).total < 17) state.dealer.push(draw(state));
}

/** Pay the hands out, and notice when the stack is gone. */
export function settle(state) {
  dealerPlays(state);
  const dealer = handValue(state.dealer).total;
  const dealerBJ = isBlackjack(state.dealer);
  let net = 0;

  for (const hand of state.hands) {
    const total = handValue(hand.cards).total;
    // A split hand that reaches 21 is twenty-one, not blackjack — it does not
    // pay 3:2, which is the rule everybody's home version gets wrong.
    const natural = isBlackjack(hand.cards) && state.hands.length === 1;
    if (total > 21) { hand.result = "bust"; hand.payout = 0; }
    else if (natural && !dealerBJ) { hand.result = "blackjack 🤘"; hand.payout = hand.bet + Math.floor(hand.bet * 1.5); }
    else if (dealerBJ && !natural) { hand.result = "dealer blackjack"; hand.payout = 0; }
    else if (dealer > 21) { hand.result = "dealer busts"; hand.payout = hand.bet * 2; }
    else if (total > dealer) { hand.result = "you win"; hand.payout = hand.bet * 2; }
    else if (total < dealer) { hand.result = "dealer wins"; hand.payout = 0; }
    else { hand.result = "push"; hand.payout = hand.bet; }
    state.chips += hand.payout;
    net += hand.payout - hand.bet;
  }

  state.phase = "settled";
  state.played++;
  state.message = `${state.hands.map((h) => h.result).join(" · ")}  ${signed(net)}`;
  if (state.chips <= 0) state.over = `broke after ${state.played} hands`;
  return state;
}

/** Move to the next hand with a decision left, or let the dealer answer. */
function advance(state) {
  const next = state.hands.findIndex((h, i) => i > state.active && !h.done);
  if (next >= 0) { state.active = next; return state; }
  if (state.hands.every((h) => h.done)) return settle(state);
  return state;
}

const current = (state) => state.hands[state.active];

export function hit(state) {
  const hand = current(state);
  hand.cards.push(draw(state));
  // Twenty-one stands itself — there is no card that improves it, and asking is
  // just a way to let someone bust a made hand by reflex.
  if (handValue(hand.cards).total >= 21) hand.done = true;
  return hand.done ? advance(state) : state;
}

export function double(state) {
  const hand = current(state);
  if (hand.cards.length !== 2 || state.chips < hand.bet) return state;
  state.chips -= hand.bet;
  hand.bet *= 2;
  hand.doubled = true;
  hand.cards.push(draw(state));
  hand.done = true;
  return advance(state);
}

export const canSplit = (state) => state.hands.length === 1
  && current(state).cards.length === 2
  && cardValue(current(state).cards[0]) === cardValue(current(state).cards[1])
  && state.chips >= current(state).bet;

export function split(state) {
  if (!canSplit(state)) return state;
  const [a, b] = current(state).cards;
  const bet = current(state).bet;
  state.chips -= bet;
  state.hands = [newHand([a, draw(state)], bet), newHand([b, draw(state)], bet)];
  state.active = 0;
  // Split aces get one card each and that is the hand — the same deal every
  // casino offers, and the reason splitting them is still worth it.
  if (a.rank === "A") {
    for (const hand of state.hands) hand.done = true;
    return settle(state);
  }
  return state;
}

/* ------------------------------------------------------------------ render */

const RED = ["♥", "♦"];
const face = (card) => {
  const label = `${card.rank}${card.suit}`.padStart(3);
  return (RED.includes(card.suit) ? danger : bone)(label);
};
const BACK = dim("▚▚▚");

/** Three rows of little cards, side by side. */
export function cardRows(cards, { hole = false } = {}) {
  const faces = cards.map((c, i) => (hole && i === 1 ? BACK : face(c)));
  return [
    faces.map(() => ash("┌───┐")).join(" "),
    faces.map((f) => `${ash("│")}${f}${ash("│")}`).join(" "),
    faces.map(() => ash("└───┘")).join(" "),
  ];
}

const beside = (blocks, gap = "   ") => blocks[0].map((_, i) => blocks.map((b) => b[i]).join(gap));

/**
 * The table is this wide, always. The footer is padded to it so the box does
 * not breathe in and out between hands as the hint under it changes length —
 * every other game in the arcade has a board of a fixed size, and this is how
 * one made of cards gets one.
 */
const TABLE = 52;

export const BLACKJACK = {
  key: "blackjack",
  aliases: ["21", "bj", "twentyone"],
  title: "BLACKJACK",
  blurb: "hit, stand, double, split — dealer stands on 17",
  keys: "h hit · s stand · d double · p split · enter next hand · ← → bet · q quit",
  // Letters mean letters here: `h` is hit, not the vim left it is everywhere
  // else in the arcade. Arrows still work, and this game only needs two.
  vim: false,
  // `r` is not a control in blackjack, so it only starts a new stack once this
  // one is gone.
  restartable: false,

  create({ rng = Math.random } = {}) {
    const state = {
      deck: freshDeck(rng),
      chips: START_CHIPS,
      bet: 10,
      hands: [],
      dealer: [],
      hole: true,
      active: 0,
      phase: "player",
      message: "",
      played: 0,
      over: null,
      rng,
    };
    return deal(state); // dealt and waiting on you before the frame lands
  },

  onKey(state, key) {
    if (state.phase === "settled") {
      if (key === "enter" || key === "space") return deal(state);
      // Between hands the arrows are the chips: the only setting in the arcade,
      // and it lives on the table rather than in a menu.
      if (key === "left") state.bet = clampBet(Math.max(MIN_BET, state.bet - BET_STEP), state.chips);
      if (key === "right") state.bet = clampBet(state.bet + BET_STEP, state.chips);
      return state;
    }
    if (key === "h") return hit(state);
    if (key === "s") { current(state).done = true; return advance(state); }
    if (key === "d") return double(state);
    if (key === "p") return split(state);
    return state;
  },

  status(state) {
    if (state.over) return `${state.over} · ${state.played} hands played`;
    const staked = state.hands.reduce((sum, h) => sum + h.bet, 0);
    return `chips ${state.chips} · ${state.phase === "settled" ? `next bet ${state.bet}` : `bet ${staked}`}`;
  },

  render(state) {
    const shown = state.hole ? handValue(state.dealer.slice(0, 1)).total : handValue(state.dealer).total;
    const dealerLabel = state.hole
      ? `${ash("dealer")} ${dim(`shows ${shown}`)}`
      : `${ash("dealer")} ${bone(String(shown))}${shown > 21 ? danger(" bust") : ""}`;

    const split = state.hands.length > 1;
    const label = (hand, i) => {
      const { total, soft } = handValue(hand.cards);
      const live = split && state.phase === "player" && i === state.active;
      const value = total > 21 ? danger(`${total} bust`) : acid(`${soft ? "soft " : ""}${total}`);
      const bet = hand.doubled ? amber(` ·2× ${hand.bet}`) : "";
      // The marker only exists when there is a second hand to point away from.
      return `${live ? acid("▸") : split ? " " : ""}${ash(split ? `hand ${i + 1}` : "you")} ${value}${bet}`;
    };

    const footer = state.phase === "settled" && !state.over
      ? `enter deals the next hand · ← → sets the bet (${state.bet})`
      : "blackjack pays 3:2 · dealer stands on 17";
    return [
      `  ${dealerLabel}`,
      ...cardRows(state.dealer, { hole: state.hole }).map((r) => `  ${r}`),
      "",
      `  ${state.hands.map(label).join("      ")}`,
      ...beside(state.hands.map((h) => cardRows(h.cards))).map((r) => `  ${r}`),
      "",
      `  ${state.message || dim(state.phase === "player" ? "h hit · s stand · d double" : "")}`,
      `  ${dim(footer.padEnd(TABLE))}`,
    ];
  },
};
