# DCMS v1

This is the production-track evolution of the MVP. Everything from the four v1 design docs (`dcms-v1-storage.md`, `dcms-v1-workflow.md`, `dcms-v1-sso.md`, `dcms-v1-search.md`) is implemented and wired together here.

The MVP is preserved unchanged at `../dcms-mvp/` for reference and comparison.

## What changed from the MVP

| Area | MVP | v1 |
|---|---|---|
| **Storage** | Local disk via `multer`; API streams the bytes | MinIO/S3 with presigned URLs; bytes go browser ↔ object store |
| **Workflow** | Anyone can click any status transition button | Engine assigns tasks to the right person; only the assignee can act |
| **Auth** | Bcrypt password against local users table | OIDC via the corporate IdP; bcrypt kept as a dev-only fallback |
| **Search** | `ILIKE` against `title` and `doc_code` | Elasticsearch with ICU analyzer; multilingual, fuzzy, ranked |
| **Sessions** | JWT only, no revocation | JWT + `user_sessions` table; logout works everywhere |
| **Frontend** | `Bearer` token in `localStorage` | `httpOnly` cookie set by the backend; SPA reads `/auth/me` on load |

## Stack

- **Postgres 15** — metadata, source of truth
- **MinIO** (or any S3-compatible) — file storage
- **Elasticsearch 8.13** with the `analysis-icu` plugin — full-text search index
- **Node.js 20 + Express** — single-file API, `pg` driver, `openid-client`, `@aws-sdk/client-s3`, `@elastic/elasticsearch`
- **React 18 + Vite** — single-file app component

## Prerequisites

- Docker + Docker Compose
- Node.js 20+

## First run

```bash
# 1. Start Postgres, MinIO, Elasticsearch (auto-runs migrate.sql + seed.sql on first boot of pg)
docker compose up -d
docker compose logs -f postgres   # wait for "database system is ready", then Ctrl-C

# 2. Backend
cd backend
cp .env.example .env
npm install
npm run init-bucket               # creates the MinIO bucket (only needed once)
npm run dev                       # listens on :4000

# 3. Frontend (new terminal)
cd frontend
npm install
npm run dev                       # listens on :5173, proxies /api → :4000
```

Open <http://localhost:5173>.

Useful UIs you'll get for free:

- MinIO console: <http://localhost:9001> (login `minioadmin / minioadmin`)
- Elasticsearch: <http://localhost:9200>
- API health (incl. component status): <http://localhost:4000/health>

## Demo accounts

Same as the MVP. Password for all is `password`. SSO is **disabled by default** (no `OIDC_ISSUER_URL` in `.env.example`); the dev login screen shows the password form. To turn on SSO, fill in the OIDC block in `.env` — see `dcms-v1-sso.md` for IdP-specific blocks.

| Email | Role | Workflow role(s) | Discipline |
|---|---|---|---|
| `alice@example.com` | controller | controller, project_manager, client_rep | — |
| `bob@example.com`   | reviewer   | discipline_lead | STR |
| `chris@example.com` | member     | discipline_lead | ARC |

## Try the full v1 loop

This exercises every new capability — storage, workflow, search, the lot.

1. Sign in as **alice**.
2. **Register** tab → click an existing document, or **+ New document** to create one. Pick STR / DWG.
3. Click into the document, click **+ Upload new version**. Pick any file, revision `A`, add a note. Watch the modal step through: *Requesting upload URL → Uploading to storage → Computing checksum → Registering*. The file goes to MinIO directly; the API never sees the bytes.
4. The version appears as `draft`. Click **Start workflow**. The engine picks `standard_review` (because the document's source is `design`) and assigns step 1 (IDC) to **Bob** (STR discipline lead).
5. Sign out, sign in as **bob**. Open **My tasks**. The IDC task is waiting. Click **Approve**. Step 2 (Internal review) is now also assigned to him. Approve again. Step 3 (Client review) goes to Alice.
6. Sign in as **alice**, work through steps 3 and 4. After step 4, the version flips to `approved`.
7. Back on the document, click **Send transmittal** on the approved version. Pick Chris as recipient, send. The version flips to `issued` automatically.
8. Sign in as **chris**. **Inbox** tab → click **Acknowledge**.
9. Search: from any user, type "floor" or "beam" or "STR" in the search box. Results are ranked, highlighted, and stay accurate even when you submit a new version (the ES index updates write-through).

## Resetting

```bash
docker compose down -v             # wipes pg, MinIO, and ES volumes
docker compose up -d               # re-runs migrate.sql + seed.sql in pg

cd backend
npm run init-bucket                # re-create the MinIO bucket
npm run reindex                    # rebuild the ES index from pg
npm run dev
```

If you uploaded files in the previous run and just want to start fresh without losing them, drop `down -v` and only restart containers — pg keeps its data across non-`-v` restarts.

## Project layout

```
dcms-v1/
├── docker-compose.yml             # dev: postgres + minio + elasticsearch
├── elasticsearch.Dockerfile       # ES base + analysis-icu plugin
├── README.md
├── backend/
│   ├── Dockerfile                 # production image (multi-stage, non-root)
│   ├── package.json               # +@aws-sdk, +@elastic, +openid-client, +cookie-parser
│   ├── .env.example               # all v1 variables with placeholders
│   ├── migrate.sql                # MVP schema + workflow + SSO + sessions
│   ├── seed.sql                   # demo data + workflow templates + role assignments
│   ├── server.js                  # 600+ lines, every route
│   ├── init-bucket.js             # one-shot: create the S3 bucket
│   ├── reindex.js                 # bulk ES indexer
│   ├── migrate-files.js           # one-shot: MVP local files → MinIO
│   └── lib/
│       ├── storage.js             # presigned URL helpers
│       ├── workflow.js            # template-driven engine
│       ├── sso.js                 # OIDC flow
│       └── search.js              # ES index + sync
└── frontend/
    ├── Dockerfile                 # production image (Vite build → nginx)
    ├── nginx.conf                 # SPA fallback for production image
    ├── package.json               # unchanged from MVP
    ├── vite.config.js             # +changeOrigin for cookie proxying
    ├── index.html
    └── src/
        ├── main.jsx
        ├── App.jsx                # 780 lines: SSO login, two-phase upload,
        │                          # TaskInbox, debounced search, workflow progress
        └── style.css              # +badges +pills +highlights +tabs
```

## Configuration knobs that matter

The most consequential `.env` settings:

- `JWT_SECRET` — must be ≥32 chars and identical across all backend instances. Different secrets across pods means tokens issued by one are rejected by another.
- `ALLOW_PASSWORD_LOGIN` — `true` for dev, **unset** for production.
- `OIDC_ISSUER_URL` — empty disables SSO; setting it auto-enables. The library does OIDC discovery against `${ISSUER_URL}/.well-known/openid-configuration`.
- `S3_ENDPOINT` vs `S3_PUBLIC_ENDPOINT` — internal vs browser-facing host for MinIO. Different in production (internal `http://minio:9000`, public `https://files.example.com`).
- `ES_NODE` — single node URL for dev; in production point at the cluster's load balancer.
- `FRONTEND_URL` — used by SSO callback to redirect back to the SPA, and by CORS to allow credentialed requests.

## Going to production

The deployment doc (`../dcms-v1-deployment.md`) covers both deployment shapes end-to-end:

- **Docker Compose on a single host**, with Nginx + Let's Encrypt + nightly backups. Suitable up to ~50 users on one project.
- **Kubernetes**, with HPA on the backend, persistent volumes for PG and MinIO, cert-manager for TLS, and a GitHub Actions pipeline. Suitable for multi-project portfolios and HA.

Production Dockerfiles (`backend/Dockerfile` and `frontend/Dockerfile`) are already here. The production `docker-compose.prod.yml`, `nginx.conf`, and Kubernetes manifests are in the deployment doc as copy-paste blocks.

## Related documents

All in the parent directory:

- `../dcms-v1-brd.md` — Business case, budget, risks, governance
- `../dcms-v1-storage.md` — Object storage design (what this codebase implements)
- `../dcms-v1-workflow.md` — Workflow engine design (what this codebase implements)
- `../dcms-v1-sso.md` — OIDC SSO design (what this codebase implements)
- `../dcms-v1-search.md` — Elasticsearch design (what this codebase implements)
- `../dcms-v1-deployment.md` — Production deployment
- `../dcms-user-manual/` — End-user documentation (Docusaurus site)
- `../dcms-mvp/` — The MVP this evolved from
- `../dcms-schema-and-api.md` — Reference DDL + REST contract
- `../dcms-coding-and-workflow.md` — Document coding rules and workflow templates
