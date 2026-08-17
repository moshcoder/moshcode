# Running the PWA on your own box

Railway runs `app.moshcode.sh` and `pit.moshcode.sh`. This directory is for the
other case — a plain VPS with nginx and systemd, which is how `dev.moshcode.sh`
is meant to run and how anyone self-hosting the app would do it.

| file | what it is |
|---|---|
| `bootstrap.sh` | does every step that does not need root, then prints the four that do |
| `.env.example` | the dev instance's environment — **not** the same as `apps/pwa/.env.example` |
| `moshcode-dev.service` | systemd unit template |
| `nginx-vhost.conf` | nginx vhost template |
| `out/` | where `bootstrap.sh` writes the rendered copies. Git-ignored — it holds this box's paths |

## Before you start

**The DNS record has to exist**, because certbot validates over HTTP-01:

```
dev  A  <this box's IPv4>
```

Point it at the machine that will actually serve the app. If that machine is
IPv6-only, do **not** publish an AAAA-only record for a URL you intend to share
— it is unreachable from every IPv4-only network. Put the `A` record on a box
that has IPv4 and reverse-proxy to the v6 machine, the way `dns.moshcode.sh`
already works.

## The whole thing

```sh
./apps/pwa/deploy/bootstrap.sh
```

Then run the four `sudo` commands it prints. That is the entire process.

`bootstrap.sh` is safe to re-run. It will not overwrite an existing `.env`, and
it regenerates the rendered files every time — so after moving the checkout or
changing the port, re-run it and reinstall the unit.

Options: `APP_HOST=` `APP_PORT=` `APP_USER=` `NODE_BIN=` as environment
variables, `--render-only` to emit configs without installing or booting
anything, `--skip-smoke` to skip the boot test.

## Why it stops before root

Root steps are a hand-off on our boxes, and a provisioning script that
half-succeeds leaves you debugging the script instead of the service. So
`bootstrap.sh` takes it as far as it can go unprivileged and finishes with a
**smoke test**: it boots the app on a scratch port, exactly as systemd will,
and waits for `/healthz`.

That test is the useful part. If it passes, the app is known-good before nginx
exists, so every later failure is the proxy or the certificate — and the first
question when a deploy misbehaves is already answered.

## Order matters in one place

Install the vhost **after** certbot has issued, not before. The vhost
references `/etc/letsencrypt/live/<host>/fullchain.pem`, and nginx refuses to
start when an `ssl_certificate` path does not exist — so installing it first
takes down every other site on the box until you notice. The printed commands
are in the right order already.

## Things that will look like bugs

- **Your passkeys do not work here.** A passkey is bound to the WebAuthn
  relying-party ID, which is the hostname. `app.moshcode.sh` and
  `dev.moshcode.sh` are different rpIDs, so everyone registers a second passkey
  on the dev box. Inherent to WebAuthn, not something to fix.
- **Migrations run at boot**, inside the app. A restart is also the upgrade.
  The corollary is that pointing a dev instance's `DATABASE_URL` at prod's
  database **migrates prod** on the next restart — `.env.example` defaults to a
  local file for exactly that reason.
- **`203/EXEC` from systemd** means the unit's `ExecStart` path is wrong,
  usually because the unit was copied from another box. Re-run `bootstrap.sh`;
  it resolves the real `node` binary rather than a mise shim, which is a path
  that only works with mise's environment loaded.
- **A large publish batch 413s.** The API takes up to 50 items, but
  `express.json()` in `src/server.mjs` uses its 100kb default, which a batch of
  substantial posts exceeds. The vhost allows 2m so nginx is not a second,
  more confusing limit — the app's own ceiling is the real one.

## Verifying, one layer at a time

Every layer fails identically in a browser, so do not debug from one.

```sh
sudo systemctl status moshcode-dev        # is it running
journalctl -u moshcode-dev -n 50 --no-pager
curl -fsS http://127.0.0.1:8790/healthz   # the app, no nginx involved
curl -fsS https://dev.moshcode.sh/healthz # the whole path
```

If the first `curl` passes and the second fails, it is nginx or the
certificate. If the first fails, stop looking at nginx.
