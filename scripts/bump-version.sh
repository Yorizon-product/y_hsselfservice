#!/bin/sh
# Pre-commit hook: auto-bump patch version when app code changes
# Only bumps if files outside openspec/scripts/.git are staged

STAGED=$(git diff --cached --name-only --diff-filter=ACM)

# Skip if only non-app files changed (openspec, scripts, config, docs)
APP_CHANGES=$(echo "$STAGED" | grep -E '^(app/|lib/|components/|middleware)' || true)

if [ -z "$APP_CHANGES" ]; then
  exit 0
fi

# Don't bump if package.json version was already manually changed in this commit
PKG_CHANGED=$(echo "$STAGED" | grep '^package.json$' || true)
if [ -n "$PKG_CHANGED" ]; then
  # Check if version line specifically changed
  VERSION_DIFF=$(git diff --cached -- package.json | grep '^\+.*"version"' || true)
  if [ -n "$VERSION_DIFF" ]; then
    exit 0
  fi
fi

# Bump patch version
CURRENT=$(node -pe "require('./package.json').version")
NEXT=$(node -pe "const [ma,mi,pa] = '${CURRENT}'.split('.').map(Number); \`\${ma}.\${mi}.\${pa+1}\`")

# Update package.json in place
node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.version = '${NEXT}';
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"

git add package.json

echo "[version-bump] ${CURRENT} -> ${NEXT}"
