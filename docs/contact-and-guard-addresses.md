# Contact on a name, and the guard address behind it

A Moshpit name can now say how to reach whoever holds it, without saying who
that is. The holder gives an address they read; the registry publishes
`k7m2xqbn3f@names.moshcode.sh`, which forwards to it. The real address is never in a
page, an API response, or the allocation log.

This is opt-in and off by default. A name with no contact publishes nothing,
which is what every name registered before this shipped does, with no backfill.

## What it replaced

`GET /api/moshpit/tlds` used to return the `moshpit_tlds` row as it sits in the
table, which meant `owner_email` in cleartext for every ending in the registry —
thousands of real addresses, other people's included, to anyone who could count
to 200 in an `?offset=`. Nobody consented to it and nothing read it: not
`moshpit-registry`, not the DNS bridge, not a page in this app.

That field is now redacted from the list, and the endpoint follows the policy
`/api/moshpit/log` already wrote down — ownership is public, the account behind
it is not. Endings still carry an `owner` digest, the same value the log
publishes, so two endings held by one person are still visibly one person and
"who holds how much of the namespace" is still answerable. What is gone is the
address, and a contact is the consented way to get one back.

## The three states

A holder picks one per name or ending, on `/pit/contact`:

| visibility | what a visitor sees |
|---|---|
| `guard` | `<token>@names.moshcode.sh`, forwarding to them. The default. |
| `public` | the address they typed, as typed. For a role address they are happy to expose. |
| `none` | nothing — but the token is kept, so switching back on restores the *same* address. |

`none` is not the same as having no contact at all. A published address ends up
in other people's address books and on pages we do not control, so taking one
down for a week must not mint a different one on the way back.

## The token

Ten characters from digits and consonants — no vowels, no `0`/`o`, no `1`/`l`.
Excluding vowels does real work: a token can never spell a word, so a minted
address can never collide with a mailbox a person holds at the same domain.
`support@`, `abuse@` and `notify@` are unreachable from the alphabet itself
rather than by a reserved list somebody has to maintain.

A token dies with the row. Releasing a name drops its contact and destroys the
alias alongside the pins, records and twin — otherwise the next holder inherits
a forwarding address pointing at the last one, and mail meant for them (an offer
for the name, an abuse report about it) goes to a stranger.

## Standing the mail host up

Nothing is published until an alias exists at the mail host. Guard addresses
live at **`names.moshcode.sh`** — its own subdomain, for two separate reasons:

- `pit.moshcode.sh` is a **CNAME** to Railway, and a CNAME cannot coexist with
  an MX at the same name. Mail there is impossible, not merely unconfigured.
- The apex would work (Porkbun's ALIAS is a flattened A, not a CNAME) but it
  would put the reputation of forwarded stranger mail on the same name as any
  staff mail `moshcode.sh` ever carries. Forwarding is the hardest
  deliverability case there is, so it gets a name of its own to damage.

**1. DNS — done (2026-08-29).** Added via the Porkbun API and verified
authoritative. `pit.` and `app.` are untouched.

```
names.moshcode.sh.         MX   10  mx1.forwardemail.net.
names.moshcode.sh.         MX   10  mx2.forwardemail.net.
names.moshcode.sh.         TXT  "v=spf1 include:spf.forwardemail.net -all"
_dmarc.names.moshcode.sh.  TXT  "v=DMARC1; p=none;"
```

DMARC is `p=none` on purpose: report only, because an aggressive policy bites a
forwarder first and nothing should be quarantined while the setup is unproven.

The Porkbun credentials are `PORKBUN_API_KEY` / `PORKBUN_SECRET_API_KEY` in the
logicsrc vault `profullstack-sharable-keys--prod`.

> **Checking these from the dev box:** always `dig ... @1.1.1.1`. The box's
> resolver is the Moshpit DNS bridge, which answers for every `*.moshcode.sh`
> name with a synthesised record — so a bare `dig` will happily tell you a
> host exists when public DNS has never heard of it.

**2. The domain on the Forward Email account — outstanding.** Add
`names.moshcode.sh` there, add the `forward-email-site-verification=…` TXT it
issues, and confirm the plan covers **API alias management**. Every mint fails
without API access; which tier that needs is worth checking at signup rather
than assumed.

**3. The key — outstanding.** `FORWARDEMAIL_API_KEY` on the `moshcode` Railway
service, from the logicsrc vault rather than a committed `.env`.
`MOSHPIT_GUARD_DOMAIN` already defaults to `names.moshcode.sh`, so it only needs
setting to move the addresses somewhere else.

Until 2 and 3 are done the feature is inert rather than broken: a contact is
recorded, `alias_status` stays `pending`, `/pit/contact` says plainly that no
mail host is configured, and nothing is published on any name.

## Consent, twice

Aliases are created with `has_recipient_verification` on. Forward Email sends
one confirmation link to the address given and forwards nothing until it is
clicked. That is what stops someone typing a stranger's address into the contact
form and pointing our domain at them — publishing a guard address needs consent
from the address itself, not just from whoever filled in the form.

The cost is a short window where a holder has saved a contact and the address
does not yet forward. `/pit/contact` says so rather than letting them find out
from a bounce.

Disabled aliases are set to reject with 550 rather than the default 250. An
address published as a way to reach somebody should tell a sender when the mail
did not arrive, instead of quietly accepting and discarding it.

## Where it shows

- `/n/<name>` and `/n/.<ending>` — on the directory page, under **Contact**.
  Not on a name that serves a site, a feed or an origin: that page belongs to
  its holder and the registry has no business printing an address into it.
- `GET /api/moshpit/contact?name=blue.eggs` — public. 200 with an address, or a
  definite 404, on the same reasoning as the pins route: clients cache on the
  status, and "nobody to write to" is an answer worth caching.
- `/pit/contact` — where a holder adds, edits, hides or removes one.

## Routes

| route | who |
|---|---|
| `GET /api/moshpit/contact?name=` | anyone — the published address, or 404 |
| `GET /api/moshpit/tlds/:tld/contact[?label=]` | the holder — status and guard address, never the real one |
| `PUT /api/moshpit/tlds/:tld/contact` | the holder — `{ label?, email, visibility? }` |
| `DELETE /api/moshpit/tlds/:tld/contact` | the holder — `{ label? }` |
| `POST /api/moshpit/tlds/:tld/contact/retry` | the holder — after the mail host was down |

Absent `label` means the ending itself. The real address is withheld even from
the holder's own management route: it is not needed to manage the contact, and
a route that returns it is one stray log line away from being the leak this
whole change closes. Changing where mail goes is a write, not a read.
