#!/usr/bin/env bash
# Install polvo as a global `polvo` command (npm link into this checkout).
#
#   From a checkout:   ./scripts/install.sh
#   Fresh machine:     curl -fsSL https://raw.githubusercontent.com/MRegra/polvo/master/scripts/install.sh | bash
#                      (clones into $POLVO_DIR, default ~/.local/share/polvo)
#
# Afterwards, `polvo update` pulls master and rebuilds; `npm unlink -g polvo` uninstalls.
set -euo pipefail

REPO_URL="${POLVO_REPO:-https://github.com/MRegra/polvo.git}"

say() { printf '\033[36m›\033[0m %s\n' "$*"; }
die() { printf '\033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

command -v git >/dev/null || die "git is required"
command -v node >/dev/null || die "Node.js >= 20 is required (https://nodejs.org or nvm)"
command -v npm >/dev/null || die "npm is required"
node_major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$node_major" -ge 20 ] || die "Node.js >= 20 is required (found $(node -v))"

# Use the checkout this script lives in; when piped from curl there is none, so clone.
script_dir=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi
if [ -n "$script_dir" ] && [ -f "$script_dir/../package.json" ] && grep -q '"name": "polvo"' "$script_dir/../package.json"; then
  dir="$(cd "$script_dir/.." && pwd)"
else
  dir="${POLVO_DIR:-$HOME/.local/share/polvo}"
  if [ -d "$dir/.git" ]; then
    say "using existing checkout $dir"
  else
    say "cloning $REPO_URL into $dir"
    mkdir -p "$(dirname "$dir")"
    git clone --quiet --branch master "$REPO_URL" "$dir"
  fi
fi

cd "$dir"
say "installing dependencies"
npm ci --no-audit --no-fund --loglevel=error
say "building"
npm run --silent build
say "linking the global polvo command"
npm link --loglevel=error >/dev/null

hash -r 2>/dev/null || true
if command -v polvo >/dev/null; then
  say "installed $(polvo --version) → $(command -v polvo)"
else
  die "built, but \`polvo\` is not on PATH — add \"$(npm prefix -g)/bin\" to PATH"
fi
cat <<MSG

  next:  ollama pull qwen3-coder:30b   (if you haven't)
         cd <a project> && polvo
  later: polvo update                  (pull master + rebuild)
MSG
