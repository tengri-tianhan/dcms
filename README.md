# DCMS MVP

Minimum runnable version of the Document Control Management System. Covers the three core flows:

- **Upload** — register a document, upload versions
- **Distribute** — bundle versions into a transmittal and send to recipients
- **Acknowledge** — recipients confirm receipt; sender sees who's pending

Out of scope for this MVP (minimum viable product): workflow engine, distribution matrix auto-routing, full-text search via Elasticsearch, notifications, general document library.

## Stack

- **Database** — PostgreSQL 15 (in Docker)
- **Backend** — Node.js + Express, `pg` (no ORM), `multer` for file uploads, `jsonwebtoken` + `bcryptjs` for auth
- **Frontend** — React 18 + Vite
- **File storage** — local disk (`./backend/uploads`); swap in MinIO/S3 when scaling

## Prerequisites

- Docker + Docker Compose
- Node.js 18+

## First run

```bash
# 1. Start the database (auto-runs migrate.sql and seed.sql on first boot)
docker compose up -d
docker compose logs -f postgres   # wait for "database system is ready to accept connections", then Ctrl+C

# 2. Backend
cd backend
cp .env.example .env
npm install
npm run dev                       # listens on :4000

# 3. Frontend (new terminal)
cd frontend
npm install
npm run dev                       # listens on :5173, proxies /api to :4000
```

Open http://localhost:5173.

## Demo accounts

Password for all: `password`

| Email | Role | Notes |
|---|---|---|
| `alice@example.com` | controller | Can create docs, send transmittals, transition statuses |
| `bob@example.com`   | reviewer   | STR discipline reviewer |
| `chris@example.com` | member     | ARC discipline; has a pending transmittal to acknowledge |

The seed creates one project (Bridge-PJ-2026), two documents, and one already-sent transmittal from Alice to Chris.

## Try the full loop

1. Sign in as **alice@example.com**.
2. On the Register tab, click **+ New document**. Pick STR / DWG and a title.
3. The document appears in the list. Click it to open the detail view.
4. Click **+ Upload new version**. Pick any file, set revision to `A`, add a note. Upload.
5. The version appears with status `draft`. Click **Submit for review** → `Approve review` → `Approve` → `Issue` to walk it through the state machine.
6. Once `approved` or `issued`, click **Send transmittal**. Pick Chris as recipient, set purpose, send.
7. Sign out, sign in as **chris@example.com**. Open the **Inbox** tab — the transmittal is there. Click **Acknowledge**.
8. Sign back in as Alice. The transmittal's acknowledged count is now updated.

## Resetting

```bash
docker compose down -v        # wipes the database volume
rm -rf backend/uploads/*      # wipes uploaded files
docker compose up -d          # re-runs migrate + seed
```

## Project layout

```
dcms-mvp/
├── docker-compose.yml
├── README.md
├── backend/
│   ├── package.json
│   ├── server.js              # all routes in one file
│   ├── migrate.sql            # DDL for 9 tables
│   ├── seed.sql               # demo users, project, docs, transmittal
│   └── .env.example
└── frontend/
    ├── package.json
    ├── vite.config.js
    ├── index.html
    └── src/
        ├── main.jsx
        ├── App.jsx            # all components in one file
        └── style.css
```

## API reference

See `dcms-schema-and-api.md` (in the parent directory) for the full REST contract. The MVP implements the subset needed for the upload → distribute → acknowledge loop:

- `POST /api/v1/auth/login`
- `GET  /api/v1/auth/me`
- `GET  /api/v1/projects`
- `GET  /api/v1/projects/:id/members`
- `GET  /api/v1/projects/:pid/documents`
- `POST /api/v1/projects/:pid/documents`
- `GET  /api/v1/documents/:id`
- `POST /api/v1/documents/:id/versions` (multipart, field `file`)
- `GET  /api/v1/versions/:vid/download`
- `POST /api/v1/versions/:vid/transition`
- `GET  /api/v1/projects/:pid/transmittals`
- `POST /api/v1/projects/:pid/transmittals`
- `GET  /api/v1/transmittals/my-pending`
- `GET  /api/v1/transmittals/:id`
- `POST /api/v1/transmittals/:id/recipients/:rid/acknowledge`

## What to add next

In priority order if you want to evolve this toward production:

1. **Workflow engine** — replace the manual `POST /versions/:vid/transition` with workflow instances + steps, so reviewers get assigned tasks instead of buttons that anyone can click.
2. **Distribution matrix** — when sending a transmittal, suggest recipients from the (discipline, doc_type, purpose) rules instead of making the sender pick from scratch.
3. **Object storage** — swap local disk for MinIO or S3; the API stays the same, only `multer` storage backend changes.
4. **Notifications** — Redis queue + email worker for transmittal send and overdue reminders.
5. **Audit log UI** — there's an `/api/v1/audit-logs` endpoint to add; the data is already being written.
6. **SSO** — replace the bcrypt login with OIDC/SAML against the org IdP.
