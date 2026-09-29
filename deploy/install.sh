#!/usr/bin/env bash
# Install the already prepared Ask backend on timbergeron.com. No content rebuilds.
set -euo pipefail

APP=/home/woods/codedev/qssm-wiki
SITE=/etc/nginx/sites-available/timbergeron.com
SNIPPET=/etc/nginx/snippets/qssm-wiki.conf

[[ $(id -u) -eq 0 ]] || { echo "Run this installer with sudo."; exit 1; }
test -s "$APP/site/data/reference.json"
test -s "$APP/data/knowledge/qssm.sqlite"
runuser -u woods -- /usr/bin/node --env-file="$APP/.env" --input-type=module -e '
  if (!process.env.OPENROUTER_API_KEY?.trim()) throw new Error("Missing OpenRouter key");
  await import("node:sqlite");
'

BACKUP=$(mktemp -d /etc/nginx/qssm-wiki-backup.XXXXXX)
cp -p "$SITE" "$BACKUP/site.conf"
if [[ -f "$SNIPPET" ]]; then cp -p "$SNIPPET" "$BACKUP/snippet.conf"; fi
install -m 644 "$APP/deploy/nginx-location.conf" "$SNIPPET"
python3 - "$SITE" "$SNIPPET" <<'PY'
from pathlib import Path
import sys
site = Path(sys.argv[1])
include = '    include ' + sys.argv[2] + ';'
text = site.read_text()
if include.strip() not in text:
    anchor = '    include /etc/nginx/snippets/nullius.conf;'
    if text.count(anchor) != 1:
        raise SystemExit('Expected one HTTPS Nullius include; site config left unchanged.')
    site.write_text(text.replace(anchor, anchor + '\n' + include, 1))
PY
if ! nginx -t; then
    cp -p "$BACKUP/site.conf" "$SITE"
    if [[ -f "$BACKUP/snippet.conf" ]]; then
        cp -p "$BACKUP/snippet.conf" "$SNIPPET"
    else
        rm -f "$SNIPPET"
    fi
    echo "Nginx validation failed; previous configuration restored."
    exit 1
fi

install -m 644 "$APP/deploy/qssm-wiki.service" /etc/systemd/system/qssm-wiki.service
systemctl daemon-reload
if systemctl list-unit-files qssm-wiki-refresh.timer --no-legend | grep -q '^qssm-wiki-refresh.timer'; then
    systemctl disable --now qssm-wiki-refresh.timer
fi
systemctl enable qssm-wiki
systemctl restart qssm-wiki
for attempt in {1..20}; do
    if curl -fsS http://127.0.0.1:3012/api/status >/dev/null; then break; fi
    sleep 0.5
done
curl -fsS http://127.0.0.1:3012/api/status
systemctl reload nginx
echo
echo "Ask backend installed. Nginx backup: $BACKUP"
curl -fsS https://timbergeron.com/qssm-wiki/api/status
echo
