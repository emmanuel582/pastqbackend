> Standalone backend repository: commands run from this repository root.
> Production requires a persistent writable data volume, verified Supabase configuration, an explicit FRONTEND_URL, and a stable SESSION_OWNER_HMAC_SECRET. Keep the ownership secret across redeploys. The retained Render free-plan example does not provide persistent storage; do not treat it as a durable production setup.

# PastQ backend — Hostinger production deployment

This service stores the question library, source images/PDFs, OCR artefacts, and
extraction sessions on the Hostinger VPS. Supabase is used only for user
authentication and student-owned progress data; it must never receive question
content.

## Deploy on a Hostinger VPS with Docker Compose

1. Provision a VPS with Docker/Compose and point an API hostname such as
   `api.example.com` to its public IP.
2. Clone this repository on the VPS, then enter its `server` directory.
3. Create the production secrets file without committing it:

   ```bash
   cp .env.example .env.production
   chmod 600 .env.production
   ```

4. Set these values in `.env.production`:

   ```dotenv
   NODE_ENV=production
   FRONTEND_URL=https://app.example.com
   DATA_DIR=/var/lib/pastq
   SUPABASE_URL=https://your-project.supabase.co
   SUPABASE_ANON_KEY=your-supabase-publishable-key
   ADMIN_USER_IDS=comma-separated-supabase-user-ids
   SESSION_OWNER_HMAC_SECRET=a-long-unique-random-secret
   LIBRARY_SYNC_SUPABASE=false
   ```

   Add the selected vision-provider secret too. Do not set
   `AUTH_DISABLED_FOR_LOCAL_DEVELOPMENT=true` on the VPS. Keep service-role keys
   out of client environment variables; the current API does not require one.
   `SESSION_OWNER_HMAC_SECRET` lets the VPS enforce extraction-session ownership
   using a one-way HMAC instead of storing a Supabase user identifier locally.

5. Start and check the service:

   ```bash
   docker compose -f docker-compose.hostinger.yml up -d --build
   docker compose -f docker-compose.hostinger.yml ps
   curl http://127.0.0.1:3000/api/health/ready
   ```

The named `pastq-hostinger-data` Docker volume is the durable Hostinger-side
store. Back it up before deploys and before any manual library cleanup:

```bash
docker run --rm -v pastq-hostinger-data:/data -v "$PWD":/backup \
  alpine tar czf /backup/pastq-data-$(date +%F).tgz -C /data .
```

## TLS reverse proxy

Terminate TLS at Nginx (or your Hostinger control-panel proxy) and proxy only to
the loopback port exposed by Compose:

```nginx
server {
  server_name api.example.com;
  client_max_body_size 50m;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
  }
}
```

Issue a certificate for that hostname, set the frontend’s `VITE_API_URL` to
`https://api.example.com`, and put the exact frontend origin in `FRONTEND_URL`.
The readiness route returns HTTP 503 until both writable VPS storage and
Supabase token verification are configured.

## Local development

```bash
npm install
cp .env.example .env
npm start
```

Only local development may use `AUTH_DISABLED_FOR_LOCAL_DEVELOPMENT=true`; this
switch is explicitly rejected when `NODE_ENV=production`.

## Study reminders

The authenticated reminder API and background scheduler use the existing persistent data directory. Deploy this backend before the matching frontend; see [reminder setup and device checks](docs/study-reminders.md) for stable keys, opt-in delivery and iPhone Home Screen requirements.

Discover adds authenticated public/private session joining and persistent memberships. Publishing remains admin-only until the teacher app and teacher authorization are implemented; see the [student-space API contract](docs/student-spaces.md).
