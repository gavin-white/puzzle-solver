# Scramble Squares Solver

Upload a photo of a Scramble Squares puzzle and get a step-by-step solution. Computer vision detects the nine pieces, matches edge patterns, and an algorithm finds valid layouts.

**Repository:** [github.com/gavin-white/puzzle-solver](https://github.com/gavin-white/puzzle-solver)

- **Frontend:** React + Vite (`frontend/`)
- **Backend:** FastAPI + OpenCV + PyTorch (`backend/`)

## Project structure

```
puzzle-solver/
├── frontend/          # React UI (deployed to Netlify)
├── backend/           # FastAPI API (deployed to Google Cloud Run)
└── dev.sh             # Run frontend + backend together locally
```

## Local development

### Backend

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements-dev.txt   # or requirements.txt for prod deps only
cp .env.example .env                  # optional
python -m src.api.server
```

API runs at `http://localhost:8000`. Health check: `GET /health`.

### Frontend

```bash
cd frontend
npm install
cp .env.example .env                  # optional
npm run dev
```

UI runs at `http://localhost:5173`.

### Both at once

From the repo root:

```bash
./dev.sh
```

## Environment variables

`.env` files are for **local development only**. They are gitignored and are not deployed.

| Variable | Where | Purpose |
|----------|-------|---------|
| `VITE_API_BASE_URL` | Frontend (`.env` or Netlify) | Backend URL (default: `http://localhost:8000`) |
| `VITE_USE_MOCK_API` | Frontend | Set to `true` to run UI without the backend |
| `CORS_ORIGINS` | Backend (`.env` or Cloud Run) | Allowed frontend origins, comma-separated |
| `ENVIRONMENT` | Backend | `development` or `production` (controls error detail) |
| `DEBUG_DETECTION` | Backend | Save debug images during piece detection |
| `DEBUG_CLUSTERING` | Backend | Save debug images during clustering |

See `frontend/.env.example` and `backend/.env.example` for details.

**Production:** set these in the hosting platform, not in `.env` files.

- **Netlify:** `VITE_API_BASE_URL` must be set before build (Vite bakes it in at build time).
- **Cloud Run:** set `CORS_ORIGINS` to your frontend URL (e.g. `https://puzzle.gavinwh.com`).

## Deployment

### Frontend (Netlify)

| Setting | Value |
|---------|-------|
| Base directory | `frontend` |
| Build command | `npm run build` |
| Publish directory | `dist` |

Environment variable:

```
VITE_API_BASE_URL=https://your-api-xxxxx.run.app
```

`frontend/netlify.toml` configures build settings automatically when Netlify detects it.

**Custom domain:** add `puzzle.gavinwh.com` (or your subdomain) on the puzzle Netlify site, then add a CNAME record pointing `puzzle` → `your-site-name.netlify.app`.

### Backend (Google Cloud Run)

Build and deploy from `backend/`:

```bash
gcloud builds submit --tag us-central1-docker.pkg.dev/YOUR_PROJECT_ID/puzzle-solver/api:latest

gcloud run deploy puzzle-solver-api \
  --image us-central1-docker.pkg.dev/YOUR_PROJECT_ID/puzzle-solver/api:latest \
  --region us-central1 \
  --allow-unauthenticated \
  --memory 2Gi \
  --cpu 2 \
  --timeout 300 \
  --set-env-vars "ENVIRONMENT=production,CORS_ORIGINS=https://puzzle.gavinwh.com"
```

The Dockerfile listens on Cloud Run's `PORT` and uses CPU-only PyTorch.

After Netlify is live, update `CORS_ORIGINS` on Cloud Run to match your frontend URL.

## API endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/detect` | Detect nine piece bounding boxes from an image |
| `POST` | `/api/submit` | Warp pieces and return triangle images + clusters |
| `POST` | `/api/match-triangles` | Match cluster representatives |
| `POST` | `/api/solve` | Find puzzle solutions |
| `POST` | `/api/hint` | Get next suggested placement |
| `POST` | `/api/info` | Puzzle difficulty and statistics |
| `GET` | `/health` | Health check |

## CLI (optional)

The backend includes a CLI for local experimentation:

```bash
cd backend
source .venv/bin/activate
python -m src.cli --help
```
