# DCMS — Database Schema and API Design

This document is the development handoff: PostgreSQL DDL for every table and a REST contract for the MVP endpoints. Engineers should be able to start implementing without further clarification.

## 1. Conventions

- Database: PostgreSQL 15+. UUID v4 primary keys (`gen_random_uuid()` via `pgcrypto`).
- All timestamps are `timestamptz` and stored in UTC.
- Soft deletes use `deleted_at timestamptz NULL`; queries must filter on `deleted_at IS NULL` unless explicitly fetching archived records.
- Enum-like fields are stored as `text` with `CHECK` constraints, not native PG enums (easier to evolve).
- All foreign keys are `ON DELETE RESTRICT` by default. Audit-log FKs use `ON DELETE SET NULL` so deleting a user doesn't blow up history.
- JSON metadata uses `jsonb`, not `json`.

## 2. DDL

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- =========================================================
-- Users and project membership
-- =========================================================

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  name          text NOT NULL,
  password_hash text NOT NULL,
  default_role  text NOT NULL DEFAULT 'member'
                CHECK (default_role IN ('admin', 'controller', 'reviewer', 'member', 'vendor')),
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE projects (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,            -- e.g. BR26
  name        text NOT NULL,
  status      text NOT NULL DEFAULT 'active'
              CHECK (status IN ('active', 'on_hold', 'closed')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);

CREATE TABLE project_members (
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id),
  role        text NOT NULL
              CHECK (role IN ('admin', 'controller', 'reviewer', 'member', 'vendor')),
  discipline  text,                            -- ARC, STR, MEP, ...
  added_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);

CREATE INDEX idx_project_members_user ON project_members(user_id);

-- =========================================================
-- Documents and versions
-- =========================================================

CREATE TABLE documents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES projects(id),
  doc_code      text NOT NULL,                 -- e.g. BR26-STR-DWG-001
  title         text NOT NULL,
  discipline    text NOT NULL,                 -- ARC, STR, MEP, ...
  doc_type      text NOT NULL,                 -- DWG, CAL, SPC, RPT, ...
  source        text NOT NULL DEFAULT 'design'
                CHECK (source IN ('design', 'vendor', 'construction')),
  current_version_id uuid,                     -- FK set after first version inserted
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by    uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  UNIQUE (project_id, doc_code)
);

CREATE INDEX idx_documents_project_disc_type ON documents(project_id, discipline, doc_type);
CREATE INDEX idx_documents_title_trgm ON documents USING gin (title gin_trgm_ops);
-- Requires: CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE document_versions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id   uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  revision      text NOT NULL,                 -- 'A', 'B', '0', '1', ...
  status        text NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft', 'in_review', 'pending_approval',
                                   'approved', 'issued', 'superseded', 'cancelled')),
  file_key      text NOT NULL,                 -- S3/MinIO object key
  file_name     text NOT NULL,
  file_size     bigint NOT NULL,
  mime_type     text NOT NULL,
  checksum_sha256 text NOT NULL,
  change_note   text,
  created_by    uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  issued_at     timestamptz,
  UNIQUE (document_id, revision)
);

CREATE INDEX idx_doc_versions_status ON document_versions(status);
CREATE INDEX idx_doc_versions_document ON document_versions(document_id);

ALTER TABLE documents
  ADD CONSTRAINT documents_current_version_fk
  FOREIGN KEY (current_version_id) REFERENCES document_versions(id);

-- =========================================================
-- Transmittals (distribution bundles + acknowledgments)
-- =========================================================

CREATE TABLE transmittals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid NOT NULL REFERENCES projects(id),
  transmittal_no  text NOT NULL,               -- e.g. BR26-TRM-2026-0042
  purpose         text NOT NULL
                  CHECK (purpose IN ('for_information', 'for_review',
                                      'for_approval', 'for_construction')),
  cover_note      text,
  sender_id       uuid NOT NULL REFERENCES users(id),
  status          text NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft', 'sent', 'closed')),
  sent_at         timestamptz,
  due_at          timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, transmittal_no)
);

CREATE INDEX idx_transmittals_project ON transmittals(project_id);
CREATE INDEX idx_transmittals_sender ON transmittals(sender_id);

CREATE TABLE transmittal_items (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transmittal_id       uuid NOT NULL REFERENCES transmittals(id) ON DELETE CASCADE,
  document_version_id  uuid NOT NULL REFERENCES document_versions(id),
  position             int NOT NULL DEFAULT 0,
  UNIQUE (transmittal_id, document_version_id)
);

CREATE TABLE transmittal_recipients (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transmittal_id  uuid NOT NULL REFERENCES transmittals(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id),
  role            text,                        -- snapshot of role at send time
  acknowledged_at timestamptz,
  response        text,                        -- optional response/comment
  UNIQUE (transmittal_id, user_id)
);

CREATE INDEX idx_transmittal_recipients_user ON transmittal_recipients(user_id);

-- =========================================================
-- Workflow engine (lightweight — instances + steps)
-- =========================================================

CREATE TABLE workflow_instances (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_version_id  uuid NOT NULL UNIQUE REFERENCES document_versions(id) ON DELETE CASCADE,
  template_code        text NOT NULL,          -- 'standard_review', 'fast_track', 'vendor_submittal'
  current_step         text,
  status               text NOT NULL DEFAULT 'in_progress'
                       CHECK (status IN ('in_progress', 'completed', 'cancelled')),
  started_at           timestamptz NOT NULL DEFAULT now(),
  completed_at         timestamptz
);

CREATE TABLE workflow_steps (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id         uuid NOT NULL REFERENCES workflow_instances(id) ON DELETE CASCADE,
  step_name           text NOT NULL,
  sequence            int NOT NULL,
  assignee_id         uuid REFERENCES users(id),
  assignee_role       text,
  due_at              timestamptz,
  completed_at        timestamptz,
  action              text                     -- 'approved', 'rejected', 'commented', 'skipped'
                      CHECK (action IS NULL OR action IN
                            ('approved', 'rejected', 'commented', 'skipped')),
  comment             text,
  UNIQUE (instance_id, sequence)
);

CREATE INDEX idx_workflow_steps_assignee ON workflow_steps(assignee_id) WHERE completed_at IS NULL;

-- =========================================================
-- Distribution matrix (auto-routing rules)
-- =========================================================

CREATE TABLE distribution_matrix (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  discipline        text,                      -- NULL = applies to all
  doc_type          text,                      -- NULL = applies to all
  purpose           text NOT NULL
                    CHECK (purpose IN ('for_information', 'for_review',
                                        'for_approval', 'for_construction')),
  recipient_role    text NOT NULL,
  is_active         boolean NOT NULL DEFAULT true,
  UNIQUE (project_id, discipline, doc_type, purpose, recipient_role)
);

-- =========================================================
-- Audit log
-- =========================================================

CREATE TABLE audit_logs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  action        text NOT NULL,                 -- 'document.create', 'transmittal.send', ...
  entity_type   text NOT NULL,                 -- 'document', 'transmittal', ...
  entity_id     uuid,
  detail        jsonb,
  ip_address    inet,
  user_agent    text,
  occurred_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_user ON audit_logs(user_id, occurred_at DESC);
CREATE INDEX idx_audit_entity ON audit_logs(entity_type, entity_id);

-- =========================================================
-- General document library (team docs, not project-controlled)
-- =========================================================

CREATE TABLE general_documents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title       text NOT NULL,
  file_key    text NOT NULL,
  file_name   text NOT NULL,
  file_size   bigint NOT NULL,
  mime_type   text NOT NULL,
  department  text,
  tags        text[] NOT NULL DEFAULT '{}',
  uploaded_by uuid NOT NULL REFERENCES users(id),
  uploaded_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_general_tags ON general_documents USING gin (tags);
```

## 3. REST API

Base URL: `/api/v1`. All endpoints (except `/auth/login`) require `Authorization: Bearer <JWT>`. Responses follow `{ "code": 0, "data": ... }` on success and `{ "code": <non-zero>, "message": "..." }` on error.

### 3.1 Auth

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/auth/login` | `{ email, password }` | `{ token, user }` |
| GET  | `/auth/me`    | — | `{ user, projects: [...] }` |

### 3.2 Projects

| Method | Path | Notes |
|---|---|---|
| GET    | `/projects` | List projects the caller belongs to |
| POST   | `/projects` | Create — admin only |
| GET    | `/projects/:id` | |
| GET    | `/projects/:id/members` | |
| POST   | `/projects/:id/members` | `{ user_id, role, discipline }` |

### 3.3 Documents

| Method | Path | Notes |
|---|---|---|
| GET    | `/projects/:pid/documents` | Query params: `discipline`, `doc_type`, `status`, `q` (full-text), `page`, `page_size` |
| POST   | `/projects/:pid/documents` | `{ title, discipline, doc_type, source, metadata? }` — server allocates `doc_code` |
| GET    | `/documents/:id` | Includes all versions and current acknowledgments |
| PATCH  | `/documents/:id` | Editable: title, metadata; doc_code is immutable |
| DELETE | `/documents/:id` | Soft delete; controller+ only |

### 3.4 Document versions

| Method | Path | Notes |
|---|---|---|
| POST   | `/documents/:id/versions/init-upload` | Returns `{ upload_url, file_key, expires_in }` (presigned PUT) |
| POST   | `/documents/:id/versions` | After upload completes: `{ revision, file_key, file_name, file_size, mime_type, checksum_sha256, change_note? }` |
| POST   | `/versions/:vid/transition` | `{ to_status, comment? }` — drives workflow |
| GET    | `/versions/:vid/download-url` | Returns short-lived presigned GET URL |

### 3.5 Transmittals

| Method | Path | Notes |
|---|---|---|
| GET    | `/projects/:pid/transmittals` | Filters: `status`, `sender_id`, `due_before`, `q` |
| POST   | `/projects/:pid/transmittals` | `{ purpose, cover_note?, due_at?, version_ids: [...], recipient_user_ids: [...] }` — server allocates `transmittal_no`, sets `status=draft` |
| POST   | `/transmittals/:id/send` | Switches to `status=sent`; triggers email + audit log |
| GET    | `/transmittals/:id` | Includes items + recipients |
| POST   | `/transmittals/:id/recipients/:rid/acknowledge` | `{ response? }` — recipient confirms receipt |

### 3.6 Workflow

| Method | Path | Notes |
|---|---|---|
| GET    | `/versions/:vid/workflow` | Current instance + step history |
| GET    | `/workflow/my-pending` | All steps assigned to the caller, not yet completed |
| POST   | `/workflow-steps/:id/complete` | `{ action: "approved" \| "rejected" \| "commented", comment? }` |

### 3.7 Distribution matrix

| Method | Path | Notes |
|---|---|---|
| GET    | `/projects/:pid/distribution-matrix` | |
| POST   | `/projects/:pid/distribution-matrix` | `{ discipline?, doc_type?, purpose, recipient_role }` |
| DELETE | `/distribution-matrix/:id` | |
| GET    | `/projects/:pid/distribution-matrix/resolve` | Query: `discipline`, `doc_type`, `purpose` → returns suggested recipient roles |

### 3.8 Audit log

| Method | Path | Notes |
|---|---|---|
| GET    | `/audit-logs` | Filters: `entity_type`, `entity_id`, `user_id`, `from`, `to`, `action`. Cursor-paginated. |

### 3.9 General documents

| Method | Path | Notes |
|---|---|---|
| GET    | `/general-documents` | Filters: `department`, `tags[]`, `q` |
| POST   | `/general-documents` | `{ title, file_key, file_name, file_size, mime_type, department?, tags? }` |
| GET    | `/general-documents/:id/download-url` | |
| DELETE | `/general-documents/:id` | |

## 4. Error codes

| `code` | Meaning |
|---|---|
| `0`    | Success |
| `40001` | Bad request — validation failed |
| `40101` | Unauthenticated — missing or expired token |
| `40301` | Forbidden — caller lacks the required project role |
| `40401` | Resource not found |
| `40901` | Conflict — duplicate doc_code, revision, or transmittal_no |
| `50001` | Internal error |

## 5. Pagination and sorting

List endpoints accept:

- `page` (default `1`), `page_size` (default `20`, max `100`)
- `sort` — comma-separated; prefix `-` for descending. Example: `sort=-created_at,doc_code`

Responses include `total`, `page`, `page_size`.

## 6. File upload flow

1. Client calls `POST /documents/:id/versions/init-upload` → receives presigned PUT URL.
2. Client uploads bytes directly to MinIO/S3.
3. Client computes SHA-256 locally and calls `POST /documents/:id/versions` with metadata. Server verifies `checksum_sha256` matches what was uploaded.
4. Server creates `document_versions` row with `status='draft'` and writes an audit log.

This keeps large file traffic off the API server and lets the server enforce checksum integrity.
