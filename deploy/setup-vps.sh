#!/usr/bin/env bash
# One-time, idempotent preparation of an Ubuntu/Debian VPS for the PastQ API.
# Run as root from the uploaded server directory:
#   API_DOMAIN=api.example.com [CERT_EMAIL=you@example.com] bash deploy/setup-vps.sh
set -euo pipefail
: "${API_DOMAIN:?set API_DOMAIN to the API hostname}"
HERE="$(cd "$(dirname "$0")" && pwd)"
export DEBIAN_FRONTEND=noninteractive

apt-get update -y
apt-get install -y ca-certificates curl nginx certbot python3-certbot-nginx \
  ufw fail2ban sqlite3 unattended-upgrades
command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh
systemctl enable --now docker fail2ban

# Firewall: SSH and web only. The API port stays on loopback behind Nginx.
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable

# Swap gives large-PDF rasterisation headroom on small plans.
if ! swapon --show | grep -q .; then
  fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

sed "s/__API_DOMAIN__/$API_DOMAIN/g" "$HERE/nginx-pastq.conf" > /etc/nginx/sites-available/pastq
ln -sf /etc/nginx/sites-available/pastq /etc/nginx/sites-enabled/pastq
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

if [ -n "${CERT_EMAIL:-}" ]; then EMAIL_ARGS=(-m "$CERT_EMAIL"); else EMAIL_ARGS=(--register-unsafely-without-email); fi
certbot --nginx -d "$API_DOMAIN" --non-interactive --agree-tos --redirect "${EMAIL_ARGS[@]}"

install -m 755 "$HERE/backup.sh" /usr/local/bin/pastq-backup
echo '30 2 * * * root /usr/local/bin/pastq-backup >> /var/log/pastq-backup.log 2>&1' > /etc/cron.d/pastq-backup
# Docker restarts a crashed container itself; this restarts one that is running
# but failing its health check (e.g. a hung event loop).
echo '*/2 * * * * root docker ps -q --filter health=unhealthy | xargs -r docker restart >> /var/log/pastq-watchdog.log 2>&1' > /etc/cron.d/pastq-watchdog
echo "VPS ready for https://$API_DOMAIN"
