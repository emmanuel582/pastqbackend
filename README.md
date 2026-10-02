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

## Shipped question library

`npm start` installs **Chemistry Remix** from `seeds/chemistry-remix/` into the library before accepting requests: 1,899 extracted questions (1,894 have multiple-choice options), plus 121 referenced diagrams. It appears in the frontend's library and Science track as **Chemistry Remix**. No PDF upload, model call or Supabase import is needed.

- Catalog: `GET /api/library/catalog`
- Questions: `GET /api/library/bundles/A6uka2qCMT3HUY9EZutJc`
- Diagrams: `GET /api/library/figures/chem-run3/<filename>`

Set `DATA_DIR` (or `PASTQ_DATA_DIR`) to a persistent disk directory to retain local corrections. `PASTQ_LIBRARY_DIR` can override the bundle/catalog directory separately. Restarts restore missing shipped files and catalog entries without overwriting existing questions or diagrams. Source review flags and missing answer keys are retained.

The deployed frontend's `VITE_API_URL` must point to this running backend, not the separate MCP repository. Verify `/api/library/catalog` after deployment before checking the frontend library.
