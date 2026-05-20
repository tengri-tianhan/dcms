-- DCMS MVP — migration
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  name          text NOT NULL,
  password_hash text NOT NULL,
  default_role  text NOT NULL DEFAULT 'member'
                CHECK (default_role IN ('admin','controller','reviewer','member','vendor')),
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE projects (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,
  name        text NOT NULL,
  status      text NOT NULL DEFAULT 'active',
  created_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);

CREATE TABLE project_members (
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id),
  role        text NOT NULL CHECK (role IN ('admin','controller','reviewer','member','vendor')),
  discipline  text,
  added_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);

CREATE TABLE documents (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id         uuid NOT NULL REFERENCES projects(id),
  doc_code           text NOT NULL,
  title              text NOT NULL,
  discipline         text NOT NULL,
  doc_type           text NOT NULL,
  source             text NOT NULL DEFAULT 'design'
                     CHECK (source IN ('design','vendor','construction')),
  current_version_id uuid,
  created_by         uuid NOT NULL REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz,
  UNIQUE (project_id, doc_code)
);
CREATE INDEX idx_documents_project_disc_type ON documents(project_id, discipline, doc_type);

CREATE TABLE document_versions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id     uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  revision        text NOT NULL,
  status          text NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','in_review','pending_approval',
                                     'approved','issued','superseded','cancelled')),
  file_key        text NOT NULL,
  file_name       text NOT NULL,
  file_size       bigint NOT NULL,
  mime_type       text NOT NULL,
  checksum_sha256 text NOT NULL,
  change_note     text,
  created_by      uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  issued_at       timestamptz,
  UNIQUE (document_id, revision)
);

ALTER TABLE documents
  ADD CONSTRAINT documents_current_version_fk
  FOREIGN KEY (current_version_id) REFERENCES document_versions(id);

CREATE TABLE transmittals (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id     uuid NOT NULL REFERENCES projects(id),
  transmittal_no text NOT NULL,
  purpose        text NOT NULL CHECK (purpose IN ('for_information','for_review','for_approval','for_construction')),
  cover_note     text,
  sender_id      uuid NOT NULL REFERENCES users(id),
  status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','closed')),
  sent_at        timestamptz,
  due_at         timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, transmittal_no)
);

CREATE TABLE transmittal_items (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transmittal_id      uuid NOT NULL REFERENCES transmittals(id) ON DELETE CASCADE,
  document_version_id uuid NOT NULL REFERENCES document_versions(id),
  position            int NOT NULL DEFAULT 0,
  UNIQUE (transmittal_id, document_version_id)
);

CREATE TABLE transmittal_recipients (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transmittal_id  uuid NOT NULL REFERENCES transmittals(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id),
  role            text,
  acknowledged_at timestamptz,
  response        text,
  UNIQUE (transmittal_id, user_id)
);
CREATE INDEX idx_transmittal_recipients_user ON transmittal_recipients(user_id);

CREATE TABLE audit_logs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  action      text NOT NULL,
  entity_type text NOT NULL,
  entity_id   uuid,
  detail      jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_user ON audit_logs(user_id, occurred_at DESC);
CREATE INDEX idx_audit_entity ON audit_logs(entity_type, entity_id);
