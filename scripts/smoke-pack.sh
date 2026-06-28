#!/usr/bin/env bash
# Packaging smoke test: prove the published tarball installs, imports, and
# typechecks for a real Bun consumer. Run by CI and by release before publish.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "==> building"
bun run build

echo "==> packing"
# npm pack prints the tarball filename on its last stdout line; honors "files".
TARBALL="$(npm pack --silent | tail -n1)"
TARBALL_ABS="$REPO_ROOT/$TARBALL"
echo "    packed $TARBALL"

SMOKE_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$SMOKE_DIR"
  rm -f "$TARBALL_ABS"
}
trap cleanup EXIT

echo "==> installing tarball + TS toolchain into $SMOKE_DIR"
cd "$SMOKE_DIR"
cat > package.json <<'JSON'
{ "name": "mdvault-smoke", "private": true, "type": "module" }
JSON
bun add "$TARBALL_ABS" typescript @types/bun

echo "==> runtime import check"
cat > index.ts <<'TS'
import { createVault } from 'mdvault';

if (typeof createVault !== 'function') {
  throw new Error('createVault is not exported from mdvault');
}
console.log('runtime import OK');
TS
bun run index.ts

echo "==> consumer typecheck"
cat > tsconfig.json <<'JSON'
{
  "compilerOptions": {
    "moduleResolution": "bundler",
    "module": "ESNext",
    "target": "ESNext",
    "types": ["bun"],
    "noEmit": true,
    "strict": true,
    "skipLibCheck": true
  },
  "include": ["index.ts"]
}
JSON
bunx tsc --noEmit

echo "==> smoke OK"
