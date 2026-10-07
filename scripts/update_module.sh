#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$ROOT_DIR"

DB="${ODOO_DB:-odoo}"
MODULE="${1:-bn_root_invoicing}"

echo "==> Stopping Odoo web"
docker compose stop web

echo "==> Upgrading '$MODULE' in '$DB'"
docker compose run --rm web odoo \
  -d "$DB" \
  -u "$MODULE" \
  --stop-after-init \
  --no-http

echo "==> Starting Odoo web"
docker compose up -d web

echo "==> Done. Reload the app."