#!/usr/bin/env bash
#
# bootstrap.sh — stand up the moshcode PWA as a systemd service behind nginx.
#
# Everything in here is unprivileged and safe to re-run. It installs
# dependencies, writes a .env with a real secret, renders the systemd unit and
# nginx vhost with this box's actual paths, and then boots the app on a scratch
# port to prove it works. What it does NOT do is touch /etc, /var or systemd —
# those four commands are printed at the end for a human to run.
#
# That split is the point. Root steps are a hand-off on our boxes, and a script
# that half-succeeds at provisioning leaves you debugging the script instead of
# the service. Here, if the smoke test passes, the app is known-good before
# nginx is anywhere near the picture — so anything that breaks afterwards is
# the proxy or the certificate, and you have already ruled out the app.
#
#   ./apps/pwa/deploy/bootstrap.sh
#   APP_HOST=dev.moshcode.sh APP_PORT=8790 ./apps/pwa/deploy/bootstrap.sh
#
set -euo pipefail

# ---------------------------------------------------------------- settings --

APP_HOST="${APP_HOST:-dev.moshcode.sh}"
APP_PORT="${APP_PORT:-8790}"
APP_USER="${APP_USER:-$(id -un)}"

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd -- "$HERE/.." && pwd)"
OUT_DIR="$HERE/out"

SKIP_SMOKE="${SKIP_SMOKE:-0}"
RENDER_ONLY="${RENDER_ONLY:-0}"

for arg in "$@"; do
  case "$arg" in
    --render-only) RENDER_ONLY=1 ;;
    --skip-smoke)  SKIP_SMOKE=1 ;;
    -h|--help)
      sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
info() { printf '    %s\n' "$1"; }
warn() { printf '    \033[33mwarning:\033[0m %s\n' "$1" >&2; }
die()  { printf '\n\033[31merror:\033[0m %s\n' "$1" >&2; exit 1; }

# --------------------------------------------------------------- preflight --

step "Preflight"

[ -f "$APP_DIR/package.json" ] || die "no package.json in $APP_DIR — run this from a checkout"

command -v node >/dev/null 2>&1 || die "node is not on PATH. Install it (mise use -g node@lts) and re-run."

# process.execPath, not `command -v node`. On a box using mise, PATH points at
# a shim that resolves the real binary from the current directory's config —
# and systemd runs with neither that PATH nor that directory, so a unit built
# from the shim path dies at 203/EXEC.
NODE_BIN="${NODE_BIN:-$(node -e 'process.stdout.write(process.execPath)')}"
NODE_MAJOR="$(node -e 'process.stdout.write(process.versions.node.split(".")[0])')"
[ "$NODE_MAJOR" -ge 20 ] || die "node >= 20 required (package.json engines), found $(node -v)"

info "app dir   $APP_DIR"
info "node      $(node -v) at $NODE_BIN"
info "user      $APP_USER"
info "host      $APP_HOST"
info "port      $APP_PORT"

# A port already in use is the single most common reason the service starts,
# exits 1, and gets restarted forever by Restart=always.
if command -v ss >/dev/null 2>&1 && ss -ltn "sport = :$APP_PORT" 2>/dev/null | grep -q LISTEN; then
  die "port $APP_PORT is already in use. Set APP_PORT to a free one and re-run."
fi

# Advisory only. The record is a hand-off and the app does not need it to run —
# but certbot in the last step does, and finding that out four commands later
# is worse than a warning here.
if command -v getent >/dev/null 2>&1; then
  resolved="$(getent hosts "$APP_HOST" 2>/dev/null | awk '{print $1}' | sort -u | paste -sd, -)"

  if [ -z "$resolved" ]; then
    warn "$APP_HOST does not resolve. Everything below still works; certbot will not."
  else
    # A wildcard *.example.com answers for every label, including this one, so
    # "it resolves" is not the same as "it has a record". moshcode.sh has such
    # a wildcard, and it is why dev.moshcode.sh appeared to be configured while
    # actually serving the parking host. Probing a name nobody would ever
    # create is the only way to tell the two cases apart from out here.
    probe="bootstrap-wildcard-probe-$$.${APP_HOST#*.}"
    probed="$(getent hosts "$probe" 2>/dev/null | awk '{print $1}' | sort -u | paste -sd, -)"

    if [ -n "$probed" ] && [ "$probed" = "$resolved" ]; then
      warn "$APP_HOST resolves to $resolved, but so does $probe —"
      warn "  that is a wildcard record, not a record for this host. certbot will"
      warn "  issue for whatever box the wildcard points at, which is not this one."
      warn "  Add an explicit A record for $APP_HOST before step 2."
    else
      info "dns       $APP_HOST -> $resolved"

      # Certbot validates over HTTP-01 by fetching from the address the name
      # resolves to. If that is not this machine, the challenge is served by
      # some other box and fails in a way that blames certbot.
      mine="$(
        { ip -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1; } | sort -u
      )"
      if [ -n "$mine" ]; then
        hit=0
        for addr in ${resolved//,/ }; do
          printf '%s\n' "$mine" | grep -qxF "$addr" && hit=1
        done
        [ "$hit" = "1" ] || warn "$APP_HOST does not point at this machine. certbot will fail here."
      fi
    fi
  fi
fi

# ------------------------------------------------------------ dependencies --

if [ "$RENDER_ONLY" = "1" ]; then
  step "Skipping install, env and smoke test (--render-only)"
else
  step "Installing dependencies"
  # apps/pwa is not a pnpm workspace member — it carries its own
  # package-lock.json and is deployed as its own root. Installing with pnpm
  # from the repo root does not give this directory its dependencies.
  ( cd "$APP_DIR" && npm ci --omit=dev --no-audit --fund=false )

  # ------------------------------------------------------------------- env --

  step "Writing .env"
  ENV_FILE="$APP_DIR/.env"
  if [ -f "$ENV_FILE" ]; then
    info "$ENV_FILE exists — leaving it alone"
  else
    cp "$HERE/.env.example" "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    info "created $ENV_FILE from deploy/.env.example"
  fi

  # Fill an empty SESSION_SECRET in place. Done unconditionally on a blank
  # value rather than only on first copy, so a half-written .env from an
  # interrupted run does not leave the box signing sessions with nothing.
  if grep -qE '^SESSION_SECRET=\s*$' "$ENV_FILE"; then
    if command -v openssl >/dev/null 2>&1; then
      secret="$(openssl rand -hex 32)"
    else
      secret="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
    fi
    # `secret` is 64 hex characters, so there is nothing in it for sed to
    # misread as a delimiter or a backreference.
    sed -i "s|^SESSION_SECRET=.*$|SESSION_SECRET=$secret|" "$ENV_FILE"
    info "generated SESSION_SECRET"
  else
    info "SESSION_SECRET already set — leaving it alone"
  fi

  # Applied to PORT/PUBLIC_ORIGIN/PIT_ORIGIN so the rendered nginx vhost and
  # the running app cannot disagree about the port.
  sed -i "s|^PORT=.*$|PORT=$APP_PORT|" "$ENV_FILE"
  sed -i "s|^PUBLIC_ORIGIN=.*$|PUBLIC_ORIGIN=https://$APP_HOST|" "$ENV_FILE"
  sed -i "s|^PIT_ORIGIN=.*$|PIT_ORIGIN=https://$APP_HOST|" "$ENV_FILE"
  info "PORT=$APP_PORT, PUBLIC_ORIGIN=https://$APP_HOST"

  mkdir -p "$APP_DIR/data"
  info "data directory at $APP_DIR/data"
fi

# ------------------------------------------------------------- rendering ---

step "Rendering unit and vhost"

mkdir -p "$OUT_DIR"

render() {
  sed -e "s|@APP_USER@|$APP_USER|g" \
      -e "s|@APP_DIR@|$APP_DIR|g" \
      -e "s|@APP_HOST@|$APP_HOST|g" \
      -e "s|@APP_PORT@|$APP_PORT|g" \
      -e "s|@NODE_BIN@|$NODE_BIN|g" \
      "$1" > "$2"
}

render "$HERE/moshcode-dev.service" "$OUT_DIR/moshcode-dev.service"
render "$HERE/nginx-vhost.conf"     "$OUT_DIR/$APP_HOST.conf"

# A placeholder that survives rendering means a template gained a variable
# `render` does not know about, and it would reach /etc as a literal token —
# an ExecStart or a proxy_pass that fails at runtime rather than here.
#
# Comment lines are excluded because both templates document their own
# placeholder syntax, and matching that documentation made this guard fail on
# correctly-rendered output. Comments do not affect behaviour; the directives
# below them do.
if leftover="$(grep -vh '^[[:space:]]*#' "$OUT_DIR"/* 2>/dev/null | grep -o '@[A-Z_]\{2,\}@' | sort -u | paste -sd' ' -)" && [ -n "$leftover" ]; then
  die "unsubstituted placeholders in $OUT_DIR: $leftover — add them to render() in $(basename "${BASH_SOURCE[0]}")"
fi

info "$OUT_DIR/moshcode-dev.service"
info "$OUT_DIR/$APP_HOST.conf"

# ------------------------------------------------------------ smoke test ---

if [ "$RENDER_ONLY" != "1" ] && [ "$SKIP_SMOKE" != "1" ]; then
  step "Smoke test"

  # Booted exactly as systemd will boot it — same binary, same directory, same
  # .env — but on a scratch port, so this proves the app without colliding with
  # the real one if it is already running.
  SMOKE_PORT="${SMOKE_PORT:-$((APP_PORT + 1000))}"
  SMOKE_LOG="$(mktemp)"

  ( cd "$APP_DIR" && PORT="$SMOKE_PORT" "$NODE_BIN" src/server.mjs >"$SMOKE_LOG" 2>&1 ) &
  SMOKE_PID=$!
  # shellcheck disable=SC2064  # expand SMOKE_PID now, not at trap time
  trap "kill $SMOKE_PID 2>/dev/null || true; rm -f '$SMOKE_LOG'" EXIT

  ok=0
  for _ in $(seq 1 30); do
    if ! kill -0 "$SMOKE_PID" 2>/dev/null; then break; fi
    if curl -fsS --max-time 2 "http://127.0.0.1:$SMOKE_PORT/healthz" >/dev/null 2>&1; then ok=1; break; fi
    sleep 1
  done

  if [ "$ok" = "1" ]; then
    info "GET /healthz -> $(curl -fsS "http://127.0.0.1:$SMOKE_PORT/healthz")"
    info "the app is good. Anything that fails from here is nginx or the certificate."
  else
    echo >&2
    sed 's/^/    /' "$SMOKE_LOG" >&2
    die "the app did not answer /healthz on port $SMOKE_PORT — fix this before wiring nginx"
  fi

  kill "$SMOKE_PID" 2>/dev/null || true
  wait "$SMOKE_PID" 2>/dev/null || true
  trap - EXIT
  rm -f "$SMOKE_LOG"
fi

# ----------------------------------------------------------- what is left ---

cat <<EOF

$(printf '\033[1m==> Ready. The remaining steps need root:\033[0m')

  # 1. the service
  sudo install -m 644 $OUT_DIR/moshcode-dev.service /etc/systemd/system/
  sudo systemctl daemon-reload
  sudo systemctl enable --now moshcode-dev

  # 2. the certificate, over HTTP-01 on port 80.
  #    Needs $APP_HOST to resolve to this box first.
  sudo mkdir -p /var/www/acme
  sudo certbot certonly --webroot -w /var/www/acme -d $APP_HOST

  # 3. the vhost — installed only after the certificate exists, because it
  #    references files under /etc/letsencrypt/live/$APP_HOST/ and nginx
  #    refuses to start when an ssl_certificate path is missing.
  sudo install -m 644 $OUT_DIR/$APP_HOST.conf /etc/nginx/sites-available/$APP_HOST
  sudo ln -sfn /etc/nginx/sites-available/$APP_HOST /etc/nginx/sites-enabled/$APP_HOST
  sudo nginx -t && sudo systemctl reload nginx

  # 4. verify, innermost layer outwards. If the first passes and the second
  #    fails, it is nginx or the certificate — not the app.
  curl -fsS http://127.0.0.1:$APP_PORT/healthz
  curl -fsS https://$APP_HOST/healthz

EOF
