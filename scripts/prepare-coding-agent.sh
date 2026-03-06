#!/usr/bin/env bash
set -euo pipefail

# Prepare vendor installation of @mariozechner/pi-coding-agent for inclusion in the VSIX.
# Intended to be run during packaging (CI or local) before `vsce package`.

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
VENDOR_DIR="$ROOT_DIR/vendor"

echo "Preparing vendor directory: $VENDOR_DIR"

# Clean vendor
rm -rf "$VENDOR_DIR"
mkdir -p "$VENDOR_DIR"

# Install production-only package into vendor
echo "Installing @mariozechner/pi-coding-agent into vendor (production deps only)..."
# --no-audit --no-fund to make install quieter in CI; change version if you want a pinned one
npm install --prefix "$VENDOR_DIR" @mariozechner/pi-coding-agent@latest --production --no-audit --no-fund

# Optional: remove files not needed at runtime to reduce VSIX size
# Keep node_modules and package.json; remove docs, tests, examples if present
# Note: adjust patterns if package layout changes
if [ -d "$VENDOR_DIR/node_modules/@mariozechner/pi-coding-agent/test" ]; then
  rm -rf "$VENDOR_DIR/node_modules/@mariozechner/pi-coding-agent/test"
fi
if [ -d "$VENDOR_DIR/node_modules/@mariozechner/pi-coding-agent/docs" ]; then
  rm -rf "$VENDOR_DIR/node_modules/@mariozechner/pi-coding-agent/docs"
fi

echo "Prepare complete. Vendor contents:"
ls -la "$VENDOR_DIR/node_modules/@mariozechner/" || true

exit 0
