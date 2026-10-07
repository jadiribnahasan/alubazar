#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$ROOT_DIR"

DB="${ODOO_DB:-odoo}"

echo "==> Stopping Odoo web"
docker compose stop web || true

echo "==> Dropping and recreating database '$DB' (this deletes all data)"
docker compose exec -T db dropdb -U odoo --if-exists "$DB"
docker compose exec -T db createdb -U odoo -O odoo "$DB"

echo "==> Installing modules"
docker compose run --rm web odoo \
  --config=/etc/odoo/odoo.conf \
  -d "$DB" \
  -i account,stock,bn_root_invoicing \
  --without-demo=all \
  --stop-after-init \
  --no-http

echo "==> Starting Odoo web"
docker compose up -d web

echo "==> Done. Open http://localhost:8070"