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
#
# Re-running updates an existing install in place.

set -eu

REPO="moshcoder/moshcode"
INSTALL_URL="https://moshcoding.com/install.sh"
MOSHCODE_HOME="${MOSHCODE_HOME:-$HOME/.moshcode}"
MOSHCODE_BIN="${MOSHCODE_BIN:-$HOME/.local/bin}"
WRAPPER="$MOSHCODE_BIN/moshcode"

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

# ---- prerequisites --------------------------------------------------------
need() { command -v "$1" >/dev/null 2>&1 || fail "$1 is required but not found."; }

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

# ---- commands -------------------------------------------------------------
run_install() {
    printf '\n%smoshcode installer%s %s— code hard, mosh harder 🤘%s\n\n' "$BOLD" "$RESET" "$ASH" "$RESET"
    need curl; need tar
    check_node
    _ref="$(resolve_ref)"
    fetch_and_unpack "$_ref"
    write_wrapper
    ensure_path
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
    rm -rf "$MOSHCODE_HOME" 2>/dev/null || true
    ok "removed $WRAPPER and $MOSHCODE_HOME. 🤘"
}

CMD="${1:-install}"
if [ $# -gt 0 ]; then shift; fi
case "$CMD" in
    install)            run_install ;;
    update|upgrade)     run_install ;;   # re-fetch latest, same path
    remove|uninstall)   run_remove ;;
    -h|--help|help)
        sed -n '2,28p' "$0" 2>/dev/null || printf 'moshcode installer — install | update | remove\n' ;;
    *) fail "unknown command: $CMD (try: install | update | remove)" ;;
esac
