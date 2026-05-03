#!/usr/bin/env bash
# Run this ONCE from this folder after:   gh auth login
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v gh >/dev/null 2>&1; then
  echo "Install GitHub CLI: https://cli.github.com/"
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "Run this first in your terminal (browser login):"
  echo "  gh auth login"
  exit 1
fi

read -rp "New GitHub repo name (e.g. partner-conversation-game): " REPO
REPO="${REPO:-partner-conversation-game}"

echo "Creating https://github.com/$(gh api user -q .login)/${REPO} and pushing..."
gh repo create "${REPO}" --public --source=. --remote=origin --push

echo ""
echo "Done. Now enable Pages (one-time in browser):"
echo "  https://github.com/$(gh api user -q .login)/${REPO}/settings/pages"
echo "  → Build and deployment → Source: GitHub Actions"
echo ""
echo "Then open the Actions tab and wait for the green check."
echo "Your site will be at (after deploy succeeds):"
echo "  https://$(gh api user -q .login).github.io/${REPO}/"
