#!/usr/bin/env bash
set -uo pipefail
echo "=== compose ps ==="
docker compose ps || echo "docker not accessible"
echo
echo "=== port 8070 ==="
ss -ltnp 2>/dev/null | awk '$4 ~ /:8070$/ || $4 ~ /:8069$/' || true
echo
echo "=== odoo web logs (last 40) ==="
docker compose logs web --tail=40 2>&1 || echo "cannot read logs"
echo
echo "=== direct curl to odoo ==="
curl -sS -o /dev/null -w "http_code=%{http_code}\n" --max-time 8 http://127.0.0.1:8070/web/login || echo "curl failed"