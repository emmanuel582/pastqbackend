# Deployment entrypoint

Deploy this backend on Hostinger VPS with the checked-in
`docker-compose.hostinger.yml`. The complete, production-safe procedure,
environment-variable contract, persistent-volume backup command, Nginx proxy,
and readiness check are in [README.md](README.md).

Do not deploy `render.yaml` for the Hostinger production environment.

## Current production VPS

- API: `https://76.13.110.6.nip.io` (Nginx + Let's Encrypt, auto-renewing).
- Code: `/opt/pastq`; secrets: `/opt/pastq/.env.production` (root-only, never committed).
- Data: Docker volume `pastq_pastq-hostinger-data`; nightly backups at 02:30 to
  `/var/backups/pastq` (14 days) via `/usr/local/bin/pastq-backup`.
- Firewall allows SSH, HTTP and HTTPS only; SSH is key-only.
- Self-healing: Docker restarts on crash and at boot; a cron watchdog restarts an
  unhealthy container every 2 minutes; certbot renews TLS twice daily.
- `VISION_CONCURRENCY=100` so a whole book is in flight at once (the scheduler
  backs off automatically on provider rate limits). Measured: 20 scanned pages
  in 20 min for $0.34; a 100-page book is estimated at 20-30 min and about $2.

Update the server from a clean checkout (run from the repo root):

```bash
git -c core.autocrlf=false archive --format=tar HEAD | \
  ssh root@VPS 'mkdir -p /opt/pastq.new && tar -x -C /opt/pastq.new && \
    cp /opt/pastq/.env.production /opt/pastq.new/ && rm -rf /opt/pastq && mv /opt/pastq.new /opt/pastq && \
    cd /opt/pastq && docker compose -f docker-compose.hostinger.yml up -d --build'
```

On Vercel set `VITE_API_URL=https://76.13.110.6.nip.io` and add the Vercel
domain(s) to `FRONTEND_URL` in `.env.production`.
