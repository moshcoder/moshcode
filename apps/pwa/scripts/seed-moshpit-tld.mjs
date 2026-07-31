// Seed the network's own TLD: `.moshpit`, owned by the operator.
//
//   node scripts/seed-moshpit-tld.mjs
//
// Idempotent -- running it twice is a no-op, so it is safe on every deploy.
// `.moshpit` is on the reserved list, which is what stops anyone else claiming
// it; assigning it to us is the one case that bypasses the list on purpose.
import { migrate } from "../src/migrate.mjs";
import { get, run } from "../src/db.mjs";
import { id } from "../src/lib/crypto.mjs";
import { getTld, registerTld } from "../src/moshpit.mjs";

const OWNER_EMAIL = process.env.MOSHPIT_OWNER_EMAIL || "anthony@profullstack.com";
const TLD = process.env.MOSHPIT_SEED_TLD || "moshpit";

await migrate();

const existing = await getTld(TLD);
if (existing) {
  console.log(`.${TLD} already registered to ${existing.owner_email ?? existing.user_id}`);
  process.exit(0);
}

// The operator may not have signed in on this deployment yet, so the account
// they will sign into is created here rather than assumed. Matching on email
// means a later email/passkey/CoinPay sign-in lands on this same row.
let user = await get(`SELECT id, email FROM users WHERE email = ?`, [OWNER_EMAIL]);
if (!user) {
  const uid = id();
  await run(`INSERT INTO users (id, email, created_at) VALUES (?,?,?)`, [uid, OWNER_EMAIL, Date.now()]);
  user = { id: uid, email: OWNER_EMAIL };
  console.log(`created account for ${OWNER_EMAIL}`);
}

const result = await registerTld({
  tld: TLD, userId: user.id, ownerEmail: OWNER_EMAIL, allowReserved: true,
});

if (!result.ok) {
  console.error(`could not register .${TLD}: ${result.error}`);
  process.exit(1);
}
console.log(`registered .${result.tld.tld} -> ${OWNER_EMAIL}`);
process.exit(0);
