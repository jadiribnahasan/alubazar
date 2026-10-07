#!/usr/bin/env bash
# Clear res.partner.lang values that have no matching active res.lang.
#
# A user whose lang is not installed makes Environment.lang raise
# "Invalid language code: <code>" on every request that reads env.lang, which
# breaks syncing and printing. Signups now validate the code (see
# controllers/auth.py::_resolve_lang), but rows written before that stay broken.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$ROOT_DIR"

DB="${ODOO_DB:-odoo}"
WANTED="${1:-bn_IN}"

echo "==> Activating '$WANTED' if it exists but is off"
docker compose run --rm web odoo \
  -d "$DB" \
  --stop-after-init \
  --no-http \
  -- <<EOF
env['res.lang']._activate_lang('${WANTED}')
env.cr.commit()
EOF

echo "==> Clearing dangling language codes on partners and users"
docker compose run --rm -T web odoo shell -d "$DB" --no-http <<'PY'
active = {code for code, _name in env['res.lang'].get_installed()}
Partners = env['res.partner'].sudo()
broken = Partners.search([('lang', '!=', False), ('lang', 'not in', sorted(active))])
for partner in broken:
    print(f"  clearing {partner.login or partner.name!r}: {partner.lang!r}")
if broken:
    broken.write({'lang': False})
    env.cr.commit()
print(f"active languages: {sorted(active)}")
print(f"cleared {len(broken)} partner(s)")
PY

echo "==> Done. Reload the app."