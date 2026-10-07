#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$ROOT_DIR"

DB="${ODOO_DB:-odoo}"

echo "==> Seeding sample Bangladeshi grocery products into '$DB'"
docker compose run --rm -T web odoo shell \
  --config=/etc/odoo/odoo.conf \
  -d "$DB" < "$SCRIPT_DIR/seed_products.py"

echo "==> Done. Restart the app or press the sync button to pull them in."