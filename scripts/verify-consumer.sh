#!/bin/bash
# Proves the *published artifact* works for a consumer, which the unit suite
# cannot: it imports from src/ inside the repo, where the `exports` map, the
# `files` allowlist and the emitted .d.ts are all bypassed.
#
# Steps:
#   1. build and pack the tarball
#   2. install that tarball into examples/basic, as a customer would
#   3. typecheck the sample app against the shipped .d.ts, under settings
#      STRICTER than the library's own (exactOptionalPropertyTypes, no
#      skipLibCheck) so types that only work internally are caught
#   4. run the sample app end to end against its local mock API
#
# No network and no credentials required.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EXAMPLE="$ROOT/examples/basic"

cd "$ROOT"

echo "==> building"
npm run build --silent

echo "==> packing"
rm -f intempt-*.tgz
TARBALL="$(npm pack --silent)"
echo "    $TARBALL"

echo "==> installing the tarball into examples/basic"
cd "$EXAMPLE"
rm -rf node_modules package-lock.json
npm install --silent --no-audit --no-fund
npm install --silent --no-audit --no-fund "$ROOT/$TARBALL"

echo "==> resolved version"
node -e 'console.log("    intempt@" + require("intempt/package.json").version)'

echo "==> typechecking the sample app against the shipped types"
npm run typecheck --silent

echo "==> running the sample app"
npm start --silent

cd "$ROOT"
rm -f "$TARBALL"
echo "==> consumer verification passed"
