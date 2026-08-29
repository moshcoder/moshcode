# Offers on a parked name, and leasing

Every parked page used to end the conversation. A name somebody held said
"claimed but does not point anywhere yet". A name under an ending with no price
said ".eggs is not for sale". Both are true, both arrive at the exact moment a
visitor wants the name most, and both left the holder never hearing that anyone
asked.

An offer is the missing half. A visitor says what a name is worth to them; the
holder accepts, refuses, or names a different number.

## Who can offer

Anyone, with no account. Requiring one first means asking a stranger to sign up
before they may say what they would pay, on the one page whose job is converting
that stranger.

The address is confirmed by mail instead, and that step is load-bearing: an
offer is recorded `unverified` and the holder is told nothing until the offerer
clicks the link. Without it the form is a way to write to every holder in the
registry, one name at a time, from our own domain. Two rate limits sit behind
it — twenty offers per address per day across the whole registry, and one
standing offer per address per name.

An account is needed exactly once, at the end: a name has to belong to somebody,
so paying means signing in with the address that made the offer.

## Private, not an auction

Only the holder sees what was offered. A public bid board tells every later
bidder what the last one offered and tells the holder's next buyer precisely
where their floor is. There is a test asserting a visitor's page never contains
an amount, because that is the kind of property a later change breaks quietly.

## What can be offered on

| subject | buy | lease |
|---|---|---|
| a name somebody holds | yes | yes |
| a name nobody has minted | yes | yes |
| an ending | yes | **no** |

An unminted name under an ending somebody holds is a legitimate subject: the
operator can mint it and sell it, so they are who gets asked. That is the case
the old page turned away — "not for sale at a fixed price" is not the same as
"not for sale".

Leases are names only, and that is a deliberate limit rather than an oversight.
Leasing an ending would have to mean the lessee can mint names under it, and a
name minted during a lease outlives the lease — so a six-month tenancy would
permanently carve up a namespace its holder never sold. Until there is an answer
to that, an ending is bought and not rented.

## The conversation

```
offer ──▶ unverified ──(offerer clicks the link)──▶ open ──▶ accepted ──▶ paid
                                                     │  ▲        ▲
                                            countered┘  └────────┘
                                                        offerer answers
```

A counter is held **beside** the original rather than replacing it. What was
first offered is what the offerer will be comparing against, and a negotiation
that rewrites its own history is one neither side can check. `agreedTerms()` is
the single place that decides which number is operative — read `amount_usd`
directly and you will charge the wrong one the first time a holder counters.

Offers expire thirty days after they are made. An accepted one does not: from
there the only thing outstanding is a payment, and a bill does not stop being
owed because a month went by.

## Accepting does not move anything

Acceptance opens a CoinPay checkout, and the name moves when the payment
confirms — the same webhook, `openOfferPurchase` and `settleOfferPurchase`
sitting beside the existing name and ending purchases. Settlement is claimed
with a conditional `accepted → settling` update, because CoinPay retries a
webhook it never got an ack for and two deliveries can be in flight at once.

Everything is re-checked at settlement. If the name changed hands between
acceptance and confirmation, the buyer paid its previous holder for something
that is no longer theirs, so the offer becomes `refund_due` and is logged rather
than swallowed. Once a sale settles, every other live offer on that name is
closed: an offer that can never be accepted is worse than no offer.

**A sale leaves nothing of the seller's behind.** The contact and its forwarding
alias, the pins, the records, the twin and the target all go, for the reason
`releaseName` gives — a target names the seller's server, and an inherited guard
address forwards the buyer's mail to the seller.

## Leases

The holder keeps the name. The lessee gets to point it, publish under it and
present keys for it until the term runs out, and then it reverts with no action
needed from either side.

Paid **once, upfront, for the whole term**. Not because a monthly rate would be
wrong — it is how leasing actually works — but because renewing one needs
subscription billing, a grace period, and a story for what happens to a live
site when a payment fails. A term paid in full before it starts cannot lapse
halfway through, which makes this the version that can be built correctly today.

What a tenant may do is everything that makes the name usable: target, feed,
records, keys, content. What they may not do is anything that outlives the
lease — give the name up, sell it, bind a clearnet twin, or change who is
contacted about buying it. Those stay with the holder. `ownedName` is the holder
check; `controlledName` is the one that also accepts a current tenant.

Mid-term the name is frozen against everything that would break the tenancy: the
holder cannot release it, and it cannot be sold or re-let.

### Ending on time

A lease ends when its term ends, not when a sweep runs. `leaseIsActive()` and
the `leased_until` check are read-time, so a former tenant loses control the
moment the clock passes — and `resolveMoshpitName` stops serving their target,
so their site is not still answering under a name they no longer rent.

`endExpiredLeases()` is the tidy-up, hourly and at boot. It does the part a
reader cannot: taking the tenant's target, records and keys off the name. Their
published content is deliberately left alone — it is the one thing here that was
written rather than pointed at, and deleting somebody's posts because their
lease lapsed destroys work rather than unlinking it. It stops being served the
moment the target does.

`leased_to` and `leased_until` are denormalised onto `moshpit_names`;
`moshpit_leases` is the record. Every name lookup in the pit goes through
`resolveMoshpitName`, and putting a second SELECT on the hottest query in the
registry to answer a question that is null for almost every name is not worth
it.

## Where it shows

- `/n/<name>` and `/n/.<ending>` — the offer form, on the parked page.
- `/pit/offers` — the holder's side: what was offered, and accept / refuse /
  counter. Also lists names they are renting.
- `/offers/<id>?t=<token>` — the offerer's side, reached from the mail. The
  token stands in for the account they may not have.

## Mail

Four, all best-effort — a failed send must never lose an offer that is already
recorded, and `/pit/offers` shows it either way.

| when | to | why |
|---|---|---|
| offer made | offerer | confirm the address, or nothing is sent on |
| offer confirmed | holder | somebody wants your name |
| holder answers | offerer | accepted, countered or refused |
| lease settles | tenant | what you now hold, and until when |

Holder mail goes to their **account** address, not the guard address a contact
publishes. The two point opposite ways: a guard address is how a stranger
reaches them without learning who they are; this is the registry telling its own
user something about their account, and it has to arrive for the holders who
have no contact set — which is most of them.
