#!/bin/sh
# moshcode — one-line installer 🤘
#
# Usage:
#   curl -fsSL https://moshcoding.com/install.sh | sh
#   curl -fsSL https://moshcoding.com/install.sh | sh -s -- update      (alias: upgrade)
#   curl -fsSL https://moshcoding.com/install.sh | sh -s -- remove      (alias: uninstall)
#
# (also works straight from GitHub:)
#   curl -fsSL https://raw.githubusercontent.com/moshcoder/moshcode/main/install.sh | sh
#
# What it does — dead simple, no build step:
#   1. Checks for Node.js 18+ (moshcode is zero-dependency ESM — needs a node).
#   2. Downloads the latest release tarball of moshcoder/moshcode from GitHub
#      (falls back to the main branch if no release is published yet).
#   3. Unpacks it to $MOSHCODE_HOME (default: $HOME/.moshcode).
#   4. Drops a `moshcode` wrapper at $MOSHCODE_BIN (default: $HOME/.local/bin)
#      that just exec's `node $MOSHCODE_HOME/bin/moshcode.mjs "$@"`.
#   5. Ensures that bin dir is on your PATH.
#
# Env overrides:
#   MOSHCODE_HOME=/path      install dir      (default: $HOME/.moshcode)
#   MOSHCODE_BIN=/path/dir   wrapper bin dir  (default: $HOME/.local/bin)
#   MOSHCODE_REF=vX.Y.Z      pin a tag/branch (default: latest release, else main)
#   MOSHCODE_ALLOW_ROOT=1    install as root anyway (see below)
#   MOSHCODE_NO_PROXY=1      skip the pinned-TLS proxy (https:// on a Moshpit
#                            name will not verify without it)
#
# Do not install this with sudo. moshcode is a user-level CLI, and every path
# here is derived from $HOME — under sudo that is /root, so the payload and the
# wrapper land in root's home where your own user cannot read them. Nothing
# fails at install time; it surfaces later as "permission denied" on a binary
# that looks installed. The installer refuses that case and tells you how.
#
# Re-running updates an existing install in place.

set -eu

REPO="moshcoder/moshcode"
INSTALL_URL="https://moshcoding.com/install.sh"
MOSHCODE_HOME="${MOSHCODE_HOME:-$HOME/.moshcode}"
MOSHCODE_BIN="${MOSHCODE_BIN:-$HOME/.local/bin}"
WRAPPER="$MOSHCODE_BIN/moshcode"
SCRIPT_WRAPPER="$MOSHCODE_BIN/moshscript"

PROXY_INSTALLER="${MOSHCODE_PROXY_INSTALLER:-https://raw.githubusercontent.com/profullstack/moshpit-proxy/main/install.sh}"

# ---- pretty output (acid-lime, matching the CLI) --------------------------
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
    ACID=$(printf '\033[38;2;158;240;26m'); ASH=$(printf '\033[38;2;139;147;138m')
    RED=$(printf '\033[31m'); BOLD=$(printf '\033[1m'); RESET=$(printf '\033[0m')
else
    ACID=''; ASH=''; RED=''; BOLD=''; RESET=''
fi
info() { printf '%s·%s %s\n' "$ASH" "$RESET" "$*"; }
ok()   { printf '%s✓%s %s\n' "$ACID" "$RESET" "$*"; }
fail() { printf '%s✗%s %s\n' "$RED" "$RESET" "$*" >&2; exit 1; }
# Unlike fail(), does not exit: an optional component that did not install is
# not a reason to leave the CLI half-written.
warn() { printf '%s!%s %s\n' "$RED" "$RESET" "$*" >&2; }

# ---- prerequisites --------------------------------------------------------
need() { command -v "$1" >/dev/null 2>&1 || fail "$1 is required but not found."; }

# Installing under sudo silently installs for the wrong user. Every path here
# comes from $HOME, which sudo sets to /root, so the payload and wrappers land
# in a directory mode 0700 root — invisible to the user who ran the command.
# The install reports success and only breaks later, at first use.
#
# A bare root shell (containers, CI images, root-only boxes) has no SUDO_USER
# and is a legitimate way to install, so only the sudo-from-a-real-user case is
# refused, and MOSHCODE_ALLOW_ROOT overrides even that.
check_not_sudo() {
    [ "$(id -u)" = "0" ] || return 0
    [ -n "${SUDO_USER:-}" ] || return 0
    if [ -n "${MOSHCODE_ALLOW_ROOT:-}" ]; then
        info "MOSHCODE_ALLOW_ROOT set — installing as root into $MOSHCODE_HOME"
        return 0
    fi
    fail "don't install moshcode with sudo.

  Every path is based on \$HOME, which sudo has set to $HOME, so this would
  install for root and leave $SUDO_USER unable to run it.

  Run it as yourself instead:
      curl -fsSL $INSTALL_URL | sh

  If you really do want it system-wide, choose the paths explicitly:
      sudo MOSHCODE_ALLOW_ROOT=1 MOSHCODE_HOME=/opt/moshcode \\
           MOSHCODE_BIN=/usr/local/bin sh -c 'curl -fsSL $INSTALL_URL | sh'"
}

check_node() {
    command -v node >/dev/null 2>&1 || fail \
        "Node.js 18+ is required. Install it (https://nodejs.org) and re-run."
    _major="$(node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1)"
    [ "${_major:-0}" -ge 18 ] || fail "Node.js 18+ required, found $(node -v)."
    ok "Node.js $(node -v)"
    unset _major
}

# Resolve the download URL for the latest release tag, or fall back to main.
resolve_ref() {
    if [ -n "${MOSHCODE_REF:-}" ]; then
        echo "$MOSHCODE_REF"; return 0
    fi
    # Ask GitHub for the latest release tag (no auth needed for public repos).
    _tag="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null \
        | grep '"tag_name"' | head -1 | sed 's/.*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/')"
    if [ -n "$_tag" ]; then echo "$_tag"; else echo "main"; fi
    unset _tag
}

fetch_and_unpack() {
    _ref="$1"
    _url="https://codeload.github.com/$REPO/tar.gz/$_ref"
    info "downloading moshcode@$_ref"
    _tmp="$(mktemp -d 2>/dev/null || mktemp -d -t moshcode)"
    if ! curl -fsSL "$_url" | tar -xz -C "$_tmp" 2>/dev/null; then
        rm -rf "$_tmp"; fail "download failed ($_url) — check the ref/network."
    fi
    # Tarball extracts to a single top-level dir (e.g. moshcode-main/).
    _src="$(find "$_tmp" -maxdepth 1 -type d -name 'moshcode-*' | head -1)"
    [ -n "$_src" ] && [ -f "$_src/bin/moshcode.mjs" ] || { rm -rf "$_tmp"; fail "unexpected tarball layout."; }
    rm -rf "$MOSHCODE_HOME"
    mkdir -p "$(dirname "$MOSHCODE_HOME")"
    mv "$_src" "$MOSHCODE_HOME"
    rm -rf "$_tmp"
    chmod +x "$MOSHCODE_HOME/bin/moshcode.mjs" 2>/dev/null || true
    ok "installed to $MOSHCODE_HOME"
    unset _ref _url _tmp _src
}

write_wrapper() {
    mkdir -p "$MOSHCODE_BIN"
    cat > "$WRAPPER" <<WRAP_EOF
#!/bin/sh
# moshcode wrapper — installed by $INSTALL_URL. Re-run the installer to update.
exec node "$MOSHCODE_HOME/bin/moshcode.mjs" "\$@"
WRAP_EOF
    chmod +x "$WRAPPER"
    ok "wrapper at $WRAPPER"

    # moshscript — thin alias for `moshcode run`, so .mosh files can use
    # #!/usr/bin/env moshscript as a shebang and run like shell scripts.
    cat > "$SCRIPT_WRAPPER" <<SCRIPT_EOF
#!/bin/sh
# moshscript wrapper — installed by $INSTALL_URL. Re-run the installer to update.
exec node "$MOSHCODE_HOME/bin/moshcode.mjs" run "\$@"
SCRIPT_EOF
    chmod +x "$SCRIPT_WRAPPER"
    ok "wrapper at $SCRIPT_WRAPPER"
}

ensure_path() {
    case ":$PATH:" in *":$MOSHCODE_BIN:"*) return 0 ;; esac
    for rc in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile"; do
        [ -f "$rc" ] || continue
        grep -q "$MOSHCODE_BIN" "$rc" 2>/dev/null && continue
        printf '\n# Added by moshcode installer\nexport PATH="%s:$PATH"\n' "$MOSHCODE_BIN" >> "$rc"
    done
    info "add $MOSHCODE_BIN to PATH in this shell:  export PATH=\"$MOSHCODE_BIN:\$PATH\""
}

# ---- the pinned-TLS proxy -------------------------------------------------
# Without this, HTTPS on a Moshpit name cannot work. No public CA will ever sign
# for `.eggs`, so a name answers its origin's own self-signed leaf and a stock
# client refuses it — correctly. moshpit-proxy generates one local root and
# terminates TLS in the one language a browser accepts, which turns "trust this
# certificate" from a thing you do per name into a thing you do once.
#
# Installed here rather than left as a follow-up step because the alternative is
# `moshcode dns enable` finishing successfully, every name resolving, and every
# https:// URL still failing — which reads as broken, not as unfinished.
#
# This is the one part of the install that touches the system's trust store, so
# it is the one part with an opt-out: MOSHCODE_NO_PROXY=1 skips it entirely, and
# `moshpit-proxy install.sh --uninstall` undoes it later. It installs no DNS
# routing and starts no resolver -- `moshcode dns enable` stays a thing a person
# types deliberately.
install_proxy() {
    if [ -n "${MOSHCODE_NO_PROXY:-}" ]; then
        info "skipping the pinned-TLS proxy (MOSHCODE_NO_PROXY is set) — https:// on a Moshpit name will not verify"
        return 0
    fi

    info "installing the pinned-TLS proxy (so https:// on a Moshpit name verifies)"

    # Downloaded first and run second, rather than `curl … | sh`.
    #
    # A pipeline reports the exit status of its LAST command, and a `sh` handed
    # an empty stdin by a 404 exits 0 — so piping reports a successful install
    # for a script that never arrived. Verified: pointed at a missing URL, the
    # piped form printed "✓ pinned-TLS proxy installed, local root trusted".
    _proxy_sh="$(mktemp 2>/dev/null)" || {
        warn "could not create a temp file for the pinned-TLS proxy installer — skipping"
        return 0
    }
    if ! curl -fsSL "$PROXY_INSTALLER" -o "$_proxy_sh" 2>/dev/null; then
        rm -f "$_proxy_sh"
        warn "could not download the pinned-TLS proxy — moshcode is fine, but https:// on a Moshpit name will not verify"
        warn "  retry:  curl -fsSL $PROXY_INSTALLER | sh"
        return 0
    fi

    # `--yes` because this installer is normally reached through a pipe, where
    # there is no terminal to answer its prompt on. Announced above rather than
    # asked, and MOSHCODE_NO_PROXY is the opt-out.
    if sh "$_proxy_sh" --yes >/dev/null 2>&1; then
        ok "pinned-TLS proxy installed, local root trusted"
        info "  it covers .moshpit by default — for other endings:"
        info "  MOSHPIT_PROXY_TLDS=moshpit,eggs,hacker,2600"
        info "  undo just this:  curl -fsSL $PROXY_INSTALLER | sh -s -- --uninstall"
    else
        # Never fatal. moshcode is a coding CLI first, and a machine that cannot
        # finish an optional component still wants the CLI it asked for. Said out
        # loud so it is not discovered later as a TLS error with no explanation.
        warn "the pinned-TLS proxy did not install — moshcode is fine, but https:// on a Moshpit name will not verify"
        warn "  retry:  curl -fsSL $PROXY_INSTALLER | sh"
    fi
    rm -f "$_proxy_sh"
    unset _proxy_sh
}

# ---- commands -------------------------------------------------------------
run_install() {
    printf '\n%smoshcode installer%s %s— code hard, mosh harder 🤘%s\n\n' "$BOLD" "$RESET" "$ASH" "$RESET"
    check_not_sudo
    need curl; need tar
    check_node
    _ref="$(resolve_ref)"
    fetch_and_unpack "$_ref"
    write_wrapper
    ensure_path
    install_proxy
    printf '\n%sdone.%s run:\n' "$ACID" "$RESET"
    printf '  moshcode                 # open the TUI shell\n'
    printf '  moshcode start claude    # raw engine session (use agents for autonomous)\n'
    printf '  moshcode prd "your idea" # plan with a numbered OpenPRD\n'
    printf '  moshcode tools           # install/run UGig and CoinPay CLIs\n'
    printf '  moshcode help\n\n'
    unset _ref
}

run_remove() {
    info "removing moshcode"
    rm -f "$WRAPPER" 2>/dev/null || true
    rm -f "$SCRIPT_WRAPPER" 2>/dev/null || true
    rm -rf "$MOSHCODE_HOME" 2>/dev/null || true
    ok "removed $WRAPPER, $SCRIPT_WRAPPER, and $MOSHCODE_HOME. 🤘"
}

CMD="${1:-install}"
if [ $# -gt 0 ]; then shift; fi
case "$CMD" in
    install)            run_install ;;
    update|upgrade)     run_install ;;   # re-fetch latest, same path
    remove|uninstall)   run_remove ;;
    -h|--help|help)
        sed -n '2,33p' "$0" 2>/dev/null || printf 'moshcode installer — install | update | remove\n' ;;
    *) fail "unknown command: $CMD (try: install | update | remove)" ;;
esac
