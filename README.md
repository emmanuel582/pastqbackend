# PastQ Backend (Render)

## Deploy on Render

1. Go to [Render Dashboard](https://dashboard.render.com) → **New** → **Web Service**
2. Connect repo: `https://github.com/emmanuel582/pastqbackend`
3. Settings:
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Health Check Path:** `/api/health`
4. Add environment variables:

| Key | Value |
|-----|--------|
| `NODE_VERSION` | `22` |
| `MISTRAL_API_KEY` | your Mistral key |
| `SUPABASE_URL` | `https://ovrlwgslzqvdofgkfcxl.supabase.co` |
| `SUPABASE_ANON_KEY` | your Supabase anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | your Supabase service role key (recommended) |
| `FRONTEND_URL` | your Vercel URL, e.g. `https://pastqfrontend.vercel.app` |

5. Deploy → copy the Render URL (e.g. `https://pastq-backend.onrender.com`)

Or use Blueprint: this repo includes `render.yaml`.

## Local

```bash
npm install
cp .env.example .env
npm start
```

`npm start` runs the vision API (`index.js`) used by the Vercel frontend (`/api/health`, `/api/vision/*`).

For the alternate OpenRouter extraction server: `npm run start:extraction` (health at `/health`).
