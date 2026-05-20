// DCMS MVP — single-file Express backend
// Covers: login, projects/members, document CRUD, version upload + download,
// status transitions, transmittals create + acknowledge.

const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || './uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || 'dcms',
  password: process.env.DB_PASSWORD || 'dcms_pw',
  database: process.env.DB_NAME || 'dcms',
});

const app = express();
app.use(cors());
app.use(express.json());

// ===== helpers =====
const ok = (res, data) => res.json({ code: 0, data });
const err = (res, status, code, message) => res.status(status).json({ code, message });

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return err(res, 401, 40101, 'Missing token');
  try {
    req.user = jwt.verify(h.slice(7), JWT_SECRET);
    next();
  } catch {
    return err(res, 401, 40101, 'Invalid token');
  }
}

async function audit(userId, action, entityType, entityId, detail) {
  try {
    await pool.query(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, detail)
       VALUES ($1,$2,$3,$4,$5)`,
      [userId, action, entityType, entityId, detail || null]
    );
  } catch (e) {
    console.error('audit failed:', e.message);
  }
}

async function nextDocSeq(projectId, disc, type) {
  const r = await pool.query(
    `SELECT doc_code FROM documents
     WHERE project_id=$1 AND discipline=$2 AND doc_type=$3
     ORDER BY doc_code DESC LIMIT 1`,
    [projectId, disc, type]
  );
  if (!r.rows.length) return 1;
  const m = r.rows[0].doc_code.match(/-(\d+)$/);
  return m ? parseInt(m[1], 10) + 1 : 1;
}

// Valid status transitions
const TRANSITIONS = {
  draft: ['in_review', 'cancelled'],
  in_review: ['pending_approval', 'draft'],
  pending_approval: ['approved', 'draft'],
  approved: ['issued'],
  issued: ['superseded'],
};

// Wrap async route handlers so we don't need try/catch everywhere
const r = (fn) => (req, res) => fn(req, res).catch((e) => {
  console.error('route error:', e);
  if (e.code === '23505') return err(res, 409, 40901, 'Duplicate');
  if (e.code === '23503') return err(res, 400, 40001, 'Foreign key violation');
  err(res, 500, 50001, 'Internal error');
});

// ===== auth =====
app.post('/api/v1/auth/login', r(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return err(res, 400, 40001, 'email and password required');
  const u = (await pool.query(
    'SELECT * FROM users WHERE email=$1 AND is_active=true', [email]
  )).rows[0];
  if (!u) return err(res, 401, 40101, 'Invalid credentials');
  if (!bcrypt.compareSync(password, u.password_hash)) {
    return err(res, 401, 40101, 'Invalid credentials');
  }
  const token = jwt.sign(
    { id: u.id, email: u.email, name: u.name, role: u.default_role },
    JWT_SECRET,
    { expiresIn: '12h' }
  );
  await audit(u.id, 'user.login', 'user', u.id);
  ok(res, { token, user: { id: u.id, email: u.email, name: u.name, role: u.default_role } });
}));

app.get('/api/v1/auth/me', auth, r(async (req, res) => {
  const projects = (await pool.query(
    `SELECT p.*, m.role FROM projects p
     JOIN project_members m ON m.project_id=p.id
     WHERE m.user_id=$1 AND p.deleted_at IS NULL
     ORDER BY p.created_at DESC`,
    [req.user.id]
  )).rows;
  ok(res, { user: req.user, projects });
}));

// ===== projects =====
app.get('/api/v1/projects', auth, r(async (req, res) => {
  const rows = (await pool.query(
    `SELECT p.*, m.role FROM projects p
     JOIN project_members m ON m.project_id=p.id
     WHERE m.user_id=$1 AND p.deleted_at IS NULL
     ORDER BY p.created_at DESC`,
    [req.user.id]
  )).rows;
  ok(res, rows);
}));

app.get('/api/v1/projects/:id/members', auth, r(async (req, res) => {
  const rows = (await pool.query(
    `SELECT u.id, u.name, u.email, m.role, m.discipline
     FROM project_members m JOIN users u ON u.id=m.user_id
     WHERE m.project_id=$1 ORDER BY u.name`,
    [req.params.id]
  )).rows;
  ok(res, rows);
}));

// ===== documents =====
app.get('/api/v1/projects/:pid/documents', auth, r(async (req, res) => {
  const { discipline, doc_type, status, q } = req.query;
  const conds = ['d.project_id=$1', 'd.deleted_at IS NULL'];
  const args = [req.params.pid];
  if (discipline) { args.push(discipline); conds.push(`d.discipline=$${args.length}`); }
  if (doc_type)   { args.push(doc_type);   conds.push(`d.doc_type=$${args.length}`); }
  if (q)          { args.push(`%${q}%`);   conds.push(`(d.title ILIKE $${args.length} OR d.doc_code ILIKE $${args.length})`); }
  let sql = `SELECT d.*, v.revision AS current_revision, v.status AS current_status
             FROM documents d
             LEFT JOIN document_versions v ON v.id=d.current_version_id
             WHERE ${conds.join(' AND ')}`;
  if (status) { args.push(status); sql += ` AND v.status=$${args.length}`; }
  sql += ' ORDER BY d.created_at DESC LIMIT 200';
  ok(res, (await pool.query(sql, args)).rows);
}));

app.post('/api/v1/projects/:pid/documents', auth, r(async (req, res) => {
  const { title, discipline, doc_type, source } = req.body || {};
  if (!title || !discipline || !doc_type) {
    return err(res, 400, 40001, 'title, discipline, doc_type required');
  }
  const proj = (await pool.query('SELECT code FROM projects WHERE id=$1', [req.params.pid])).rows[0];
  if (!proj) return err(res, 404, 40401, 'Project not found');
  const seq = await nextDocSeq(req.params.pid, discipline, doc_type);
  const docCode = `${proj.code}-${discipline}-${doc_type}-${String(seq).padStart(3, '0')}`;
  const row = (await pool.query(
    `INSERT INTO documents (project_id, doc_code, title, discipline, doc_type, source, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [req.params.pid, docCode, title, discipline, doc_type, source || 'design', req.user.id]
  )).rows[0];
  await audit(req.user.id, 'document.create', 'document', row.id, { doc_code: docCode });
  ok(res, row);
}));

app.get('/api/v1/documents/:id', auth, r(async (req, res) => {
  const d = (await pool.query(
    'SELECT * FROM documents WHERE id=$1 AND deleted_at IS NULL', [req.params.id]
  )).rows[0];
  if (!d) return err(res, 404, 40401, 'Not found');
  const versions = (await pool.query(
    `SELECT v.*, u.name AS created_by_name
     FROM document_versions v JOIN users u ON u.id=v.created_by
     WHERE v.document_id=$1 ORDER BY v.created_at DESC`,
    [req.params.id]
  )).rows;
  ok(res, { ...d, versions });
}));

// ===== versions (file upload) =====
const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 100 * 1024 * 1024 },
});

app.post('/api/v1/documents/:id/versions', auth, upload.single('file'), r(async (req, res) => {
  if (!req.file) return err(res, 400, 40001, 'File required (field name: file)');
  const { revision, change_note } = req.body || {};
  if (!revision || !change_note) {
    return err(res, 400, 40001, 'revision and change_note required');
  }
  const buf = fs.readFileSync(req.file.path);
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  try {
    const row = (await pool.query(
      `INSERT INTO document_versions
        (document_id, revision, status, file_key, file_name, file_size,
         mime_type, checksum_sha256, change_note, created_by)
       VALUES ($1,$2,'draft',$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.params.id, revision, req.file.filename, req.file.originalname,
       req.file.size, req.file.mimetype, sha, change_note, req.user.id]
    )).rows[0];
    await pool.query(
      'UPDATE documents SET current_version_id=$1, updated_at=now() WHERE id=$2',
      [row.id, req.params.id]
    );
    await audit(req.user.id, 'version.upload', 'document_version', row.id, { revision });
    ok(res, row);
  } catch (e) {
    if (e.code === '23505') {
      fs.unlinkSync(req.file.path);
      return err(res, 409, 40901, 'Revision already exists for this document');
    }
    throw e;
  }
}));

app.get('/api/v1/versions/:vid/download', auth, r(async (req, res) => {
  const v = (await pool.query(
    'SELECT * FROM document_versions WHERE id=$1', [req.params.vid]
  )).rows[0];
  if (!v) return err(res, 404, 40401, 'Not found');
  const filePath = path.join(UPLOAD_DIR, v.file_key);
  if (!fs.existsSync(filePath)) return err(res, 404, 40401, 'File missing on disk');
  res.download(filePath, v.file_name);
}));

app.post('/api/v1/versions/:vid/transition', auth, r(async (req, res) => {
  const { to_status, comment } = req.body || {};
  const v = (await pool.query(
    'SELECT status FROM document_versions WHERE id=$1', [req.params.vid]
  )).rows[0];
  if (!v) return err(res, 404, 40401, 'Not found');
  const allowed = TRANSITIONS[v.status] || [];
  if (!allowed.includes(to_status)) {
    return err(res, 409, 40901, `Cannot transition ${v.status} → ${to_status}`);
  }
  const issuedClause = to_status === 'issued' ? ', issued_at=now()' : '';
  await pool.query(
    `UPDATE document_versions SET status=$1${issuedClause} WHERE id=$2`,
    [to_status, req.params.vid]
  );
  await audit(req.user.id, 'version.transition', 'document_version',
              req.params.vid, { from: v.status, to: to_status, comment });
  ok(res, { id: req.params.vid, status: to_status });
}));

// ===== transmittals =====
app.get('/api/v1/projects/:pid/transmittals', auth, r(async (req, res) => {
  const rows = (await pool.query(
    `SELECT t.*, u.name AS sender_name,
       (SELECT COUNT(*) FROM transmittal_recipients tr WHERE tr.transmittal_id=t.id)::int
         AS recipient_count,
       (SELECT COUNT(*) FROM transmittal_recipients tr
          WHERE tr.transmittal_id=t.id AND tr.acknowledged_at IS NOT NULL)::int
         AS acknowledged_count
     FROM transmittals t JOIN users u ON u.id=t.sender_id
     WHERE t.project_id=$1 ORDER BY t.created_at DESC`,
    [req.params.pid]
  )).rows;
  ok(res, rows);
}));

app.post('/api/v1/projects/:pid/transmittals', auth, r(async (req, res) => {
  const { purpose, cover_note, version_ids, recipient_user_ids, due_at } = req.body || {};
  if (!purpose || !Array.isArray(version_ids) || !version_ids.length
      || !Array.isArray(recipient_user_ids) || !recipient_user_ids.length) {
    return err(res, 400, 40001,
      'purpose, version_ids[], recipient_user_ids[] required');
  }
  const proj = (await pool.query('SELECT code FROM projects WHERE id=$1', [req.params.pid])).rows[0];
  if (!proj) return err(res, 404, 40401, 'Project not found');
  const seq = (await pool.query(
    'SELECT COUNT(*)::int + 1 AS n FROM transmittals WHERE project_id=$1',
    [req.params.pid]
  )).rows[0].n;
  const trmNo = `${proj.code}-TRM-${new Date().getFullYear()}-${String(seq).padStart(4, '0')}`;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const t = (await client.query(
      `INSERT INTO transmittals
        (project_id, transmittal_no, purpose, cover_note, sender_id, status, sent_at, due_at)
       VALUES ($1,$2,$3,$4,$5,'sent',now(),$6) RETURNING *`,
      [req.params.pid, trmNo, purpose, cover_note || null, req.user.id, due_at || null]
    )).rows[0];
    for (let i = 0; i < version_ids.length; i++) {
      await client.query(
        `INSERT INTO transmittal_items (transmittal_id, document_version_id, position)
         VALUES ($1,$2,$3)`,
        [t.id, version_ids[i], i]
      );
    }
    for (const uid of recipient_user_ids) {
      await client.query(
        `INSERT INTO transmittal_recipients (transmittal_id, user_id) VALUES ($1,$2)`,
        [t.id, uid]
      );
    }
    await client.query('COMMIT');
    await audit(req.user.id, 'transmittal.send', 'transmittal', t.id,
                { no: trmNo, recipients: recipient_user_ids.length });
    ok(res, t);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}));

app.get('/api/v1/transmittals/my-pending', auth, r(async (req, res) => {
  const rows = (await pool.query(
    `SELECT tr.id AS recipient_id, t.id AS transmittal_id, t.transmittal_no,
            t.purpose, t.sent_at, t.due_at, t.cover_note,
            u.name AS sender_name
     FROM transmittal_recipients tr
     JOIN transmittals t ON t.id=tr.transmittal_id
     JOIN users u ON u.id=t.sender_id
     WHERE tr.user_id=$1 AND tr.acknowledged_at IS NULL
     ORDER BY t.sent_at DESC`,
    [req.user.id]
  )).rows;
  ok(res, rows);
}));

app.get('/api/v1/transmittals/:id', auth, r(async (req, res) => {
  const t = (await pool.query('SELECT * FROM transmittals WHERE id=$1', [req.params.id])).rows[0];
  if (!t) return err(res, 404, 40401, 'Not found');
  const items = (await pool.query(
    `SELECT ti.*, dv.revision, dv.file_name, dv.status,
            d.doc_code, d.title
     FROM transmittal_items ti
     JOIN document_versions dv ON dv.id=ti.document_version_id
     JOIN documents d ON d.id=dv.document_id
     WHERE ti.transmittal_id=$1 ORDER BY ti.position`,
    [req.params.id]
  )).rows;
  const recipients = (await pool.query(
    `SELECT tr.*, u.name, u.email FROM transmittal_recipients tr
     JOIN users u ON u.id=tr.user_id
     WHERE tr.transmittal_id=$1`,
    [req.params.id]
  )).rows;
  ok(res, { ...t, items, recipients });
}));

app.post('/api/v1/transmittals/:id/recipients/:rid/acknowledge', auth, r(async (req, res) => {
  const { response } = req.body || {};
  const row = (await pool.query(
    `UPDATE transmittal_recipients
     SET acknowledged_at=now(), response=$1
     WHERE id=$2 AND user_id=$3 AND transmittal_id=$4 AND acknowledged_at IS NULL
     RETURNING *`,
    [response || null, req.params.rid, req.user.id, req.params.id]
  )).rows[0];
  if (!row) return err(res, 404, 40401, 'Recipient not found or already acknowledged');
  await audit(req.user.id, 'transmittal.acknowledge', 'transmittal',
              req.params.id, { recipient_id: req.params.rid });
  ok(res, row);
}));

// ===== healthcheck =====
app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = Number(process.env.PORT) || 4000;
app.listen(PORT, () => {
  console.log(`DCMS API listening on http://localhost:${PORT}`);
  console.log(`Upload dir: ${UPLOAD_DIR}`);
});
