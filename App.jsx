import React, { useEffect, useState } from 'react';

// ===== tiny API helper =====
const api = {
  token: () => localStorage.getItem('dcms_token'),
  async req(path, opts = {}) {
    const headers = { ...opts.headers };
    if (!(opts.body instanceof FormData)) headers['Content-Type'] = 'application/json';
    const t = api.token();
    if (t) headers.Authorization = `Bearer ${t}`;
    const res = await fetch(`/api/v1${path}`, { ...opts, headers });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.code !== 0) {
      throw new Error(json.message || `HTTP ${res.status}`);
    }
    return json.data;
  },
  get: (p) => api.req(p),
  post: (p, body) => api.req(p, { method: 'POST', body: JSON.stringify(body) }),
  postForm: (p, form) => api.req(p, { method: 'POST', body: form }),
};

// ===== Login =====
function Login({ onLogin }) {
  const [email, setEmail] = useState('alice@example.com');
  const [password, setPassword] = useState('password');
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    try {
      const data = await api.post('/auth/login', { email, password });
      localStorage.setItem('dcms_token', data.token);
      localStorage.setItem('dcms_user', JSON.stringify(data.user));
      onLogin(data.user);
    } catch (e) {
      setError(e.message);
    }
  };

  return (
    <div className="login-wrap">
      <form className="card login-card" onSubmit={submit}>
        <h1>DCMS</h1>
        <p className="muted">Sign in to continue.</p>
        <label>Email
          <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" required />
        </label>
        <label>Password
          <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" required />
        </label>
        {error && <div className="error">{error}</div>}
        <button type="submit" className="btn btn-pri">Sign in</button>
        <p className="muted small">Demo accounts (password: <code>password</code>): alice@example.com (controller), bob@example.com (reviewer), chris@example.com (member)</p>
      </form>
    </div>
  );
}

// ===== Create Document modal =====
function CreateDocModal({ projectId, onClose, onCreated }) {
  const [title, setTitle] = useState('');
  const [discipline, setDiscipline] = useState('ARC');
  const [docType, setDocType] = useState('DWG');
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    try {
      const doc = await api.post(`/projects/${projectId}/documents`, {
        title, discipline, doc_type: docType,
      });
      onCreated(doc);
    } catch (e) { setError(e.message); }
  };

  return (
    <div className="modal-bg" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h3>New document</h3>
        <label>Title
          <input value={title} onChange={(e) => setTitle(e.target.value)} required />
        </label>
        <label>Discipline
          <select value={discipline} onChange={(e) => setDiscipline(e.target.value)}>
            <option>ARC</option><option>STR</option><option>MEP</option>
            <option>CIV</option><option>GEO</option><option>ELE</option>
          </select>
        </label>
        <label>Document type
          <select value={docType} onChange={(e) => setDocType(e.target.value)}>
            <option>DWG</option><option>CAL</option><option>SPC</option>
            <option>RPT</option><option>PRO</option><option>MOM</option>
          </select>
        </label>
        {error && <div className="error">{error}</div>}
        <div className="actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-pri">Create</button>
        </div>
      </form>
    </div>
  );
}

// ===== Upload Version modal =====
function UploadVersionModal({ docId, onClose, onUploaded }) {
  const [file, setFile] = useState(null);
  const [revision, setRevision] = useState('A');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!file) return setError('Pick a file');
    setBusy(true); setError('');
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('revision', revision);
      form.append('change_note', note || 'Initial upload');
      const v = await api.postForm(`/documents/${docId}/versions`, form);
      onUploaded(v);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="modal-bg" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h3>Upload new version</h3>
        <label>Revision
          <input value={revision} onChange={(e) => setRevision(e.target.value)} maxLength={3} required />
        </label>
        <label>File
          <input type="file" onChange={(e) => setFile(e.target.files[0])} required />
        </label>
        <label>Change note
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="What changed?" />
        </label>
        {error && <div className="error">{error}</div>}
        <div className="actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-pri" disabled={busy}>{busy ? 'Uploading…' : 'Upload'}</button>
        </div>
      </form>
    </div>
  );
}

// ===== Send Transmittal modal =====
function SendTransmittalModal({ projectId, versionId, onClose, onSent }) {
  const [members, setMembers] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [purpose, setPurpose] = useState('for_review');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    api.get(`/projects/${projectId}/members`).then(setMembers).catch((e) => setError(e.message));
  }, [projectId]);

  const toggle = (id) => {
    const s = new Set(selected);
    s.has(id) ? s.delete(id) : s.add(id);
    setSelected(s);
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!selected.size) return setError('Pick at least one recipient');
    try {
      const t = await api.post(`/projects/${projectId}/transmittals`, {
        purpose,
        cover_note: note || null,
        version_ids: [versionId],
        recipient_user_ids: [...selected],
      });
      onSent(t);
    } catch (e) { setError(e.message); }
  };

  return (
    <div className="modal-bg" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h3>Send transmittal</h3>
        <label>Purpose
          <select value={purpose} onChange={(e) => setPurpose(e.target.value)}>
            <option value="for_information">For information</option>
            <option value="for_review">For review</option>
            <option value="for_approval">For approval</option>
            <option value="for_construction">For construction</option>
          </select>
        </label>
        <label>Recipients</label>
        <div className="member-list">
          {members.map((m) => (
            <label key={m.id} className="member-row">
              <input type="checkbox" checked={selected.has(m.id)} onChange={() => toggle(m.id)} />
              <span>{m.name}</span>
              <span className="muted small">{m.role}{m.discipline ? ` · ${m.discipline}` : ''}</span>
            </label>
          ))}
        </div>
        <label>Cover note
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
        </label>
        {error && <div className="error">{error}</div>}
        <div className="actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-pri">Send</button>
        </div>
      </form>
    </div>
  );
}

// ===== Document Detail (versions + actions) =====
function DocumentDetail({ doc, projectId, onClose, onChange }) {
  const [data, setData] = useState(null);
  const [uploadFor, setUploadFor] = useState(null);
  const [sendFor, setSendFor] = useState(null);
  const [error, setError] = useState('');

  const load = () => api.get(`/documents/${doc.id}`).then(setData).catch((e) => setError(e.message));
  useEffect(load, [doc.id]);

  const transition = async (vid, to) => {
    try {
      await api.post(`/versions/${vid}/transition`, { to_status: to });
      load(); onChange?.();
    } catch (e) { setError(e.message); }
  };

  const download = (vid) => {
    const t = api.token();
    fetch(`/api/v1/versions/${vid}/download`, { headers: { Authorization: `Bearer ${t}` } })
      .then((r) => r.blob())
      .then((b) => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(b);
        a.download = '';
        a.click();
      });
  };

  if (!data) return <div className="card">Loading…</div>;

  return (
    <div className="card detail-card">
      <div className="row-between">
        <div>
          <div className="mono">{data.doc_code}</div>
          <h2>{data.title}</h2>
          <div className="muted small">{data.discipline} · {data.doc_type} · {data.source}</div>
        </div>
        <button onClick={onClose}>Close</button>
      </div>

      <div className="row-between" style={{ marginTop: 16, marginBottom: 8 }}>
        <h3 style={{ margin: 0 }}>Versions</h3>
        <button className="btn-pri" onClick={() => setUploadFor(data.id)}>+ Upload new version</button>
      </div>

      <table className="v-table">
        <thead>
          <tr><th>Rev</th><th>Status</th><th>File</th><th>By</th><th>Created</th><th></th></tr>
        </thead>
        <tbody>
          {data.versions.map((v) => (
            <tr key={v.id}>
              <td className="mono">{v.revision}</td>
              <td><span className={`badge b-${v.status.replace('_', '-')}`}>{v.status}</span></td>
              <td>{v.file_name}</td>
              <td>{v.created_by_name}</td>
              <td className="muted small">{new Date(v.created_at).toLocaleString()}</td>
              <td className="v-actions">
                <button onClick={() => download(v.id)}>Download</button>
                {v.status === 'draft' && <button onClick={() => transition(v.id, 'in_review')}>Submit for review</button>}
                {v.status === 'in_review' && <button onClick={() => transition(v.id, 'pending_approval')}>Approve review</button>}
                {v.status === 'pending_approval' && <button onClick={() => transition(v.id, 'approved')}>Approve</button>}
                {v.status === 'approved' && <button onClick={() => transition(v.id, 'issued')}>Issue</button>}
                {(v.status === 'approved' || v.status === 'issued') &&
                  <button className="btn-pri" onClick={() => setSendFor(v.id)}>Send transmittal</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {error && <div className="error">{error}</div>}

      {uploadFor && (
        <UploadVersionModal
          docId={uploadFor}
          onClose={() => setUploadFor(null)}
          onUploaded={() => { setUploadFor(null); load(); onChange?.(); }}
        />
      )}
      {sendFor && (
        <SendTransmittalModal
          projectId={projectId}
          versionId={sendFor}
          onClose={() => setSendFor(null)}
          onSent={() => { setSendFor(null); load(); onChange?.(); }}
        />
      )}
    </div>
  );
}

// ===== Inbox (my pending acknowledgments) =====
function Inbox() {
  const [items, setItems] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(null);

  const load = () => api.get('/transmittals/my-pending').then(setItems).catch((e) => setError(e.message));
  useEffect(load, []);

  const ack = async (tid, rid) => {
    setBusy(rid);
    try {
      await api.post(`/transmittals/${tid}/recipients/${rid}/acknowledge`, { response: 'Received' });
      load();
    } catch (e) { setError(e.message); }
    finally { setBusy(null); }
  };

  if (!items.length) return <div className="card muted">Nothing pending acknowledgment.</div>;

  return (
    <div className="card">
      <h3>Pending acknowledgment</h3>
      {items.map((t) => (
        <div key={t.recipient_id} className="inbox-row">
          <div>
            <div className="mono">{t.transmittal_no}</div>
            <div className="muted small">From {t.sender_name} · {t.purpose.replace('_', ' ')} · {new Date(t.sent_at).toLocaleString()}</div>
            {t.cover_note && <div className="small" style={{ marginTop: 4 }}>{t.cover_note}</div>}
          </div>
          <button className="btn-pri" disabled={busy === t.recipient_id}
            onClick={() => ack(t.transmittal_id, t.recipient_id)}>
            {busy === t.recipient_id ? 'Acknowledging…' : 'Acknowledge'}
          </button>
        </div>
      ))}
      {error && <div className="error">{error}</div>}
    </div>
  );
}

// ===== Document Register =====
function Register({ project, user, onLogout }) {
  const [docs, setDocs] = useState([]);
  const [openDoc, setOpenDoc] = useState(null);
  const [creating, setCreating] = useState(false);
  const [tab, setTab] = useState('register');
  const [q, setQ] = useState('');
  const [filterDisc, setFilterDisc] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [error, setError] = useState('');

  const load = () => {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (filterDisc) params.set('discipline', filterDisc);
    if (filterStatus) params.set('status', filterStatus);
    return api.get(`/projects/${project.id}/documents?${params}`).then(setDocs).catch((e) => setError(e.message));
  };
  useEffect(() => { load(); }, [project.id, q, filterDisc, filterStatus]);

  return (
    <>
      <header className="topbar">
        <div className="topbar-l">
          <strong>DCMS</strong>
          <span className="muted">/ {project.name}</span>
        </div>
        <div className="topbar-r">
          <span className="muted">{user.name} · {user.role}</span>
          <button onClick={onLogout}>Sign out</button>
        </div>
      </header>

      <nav className="tabs">
        <button className={tab === 'register' ? 'tab active' : 'tab'} onClick={() => setTab('register')}>Register</button>
        <button className={tab === 'inbox' ? 'tab active' : 'tab'} onClick={() => setTab('inbox')}>Inbox</button>
      </nav>

      {tab === 'inbox' && <Inbox />}

      {tab === 'register' && (
        <>
          <div className="filters">
            <input placeholder="Search code or title…" value={q} onChange={(e) => setQ(e.target.value)} />
            <select value={filterDisc} onChange={(e) => setFilterDisc(e.target.value)}>
              <option value="">All disciplines</option>
              <option>ARC</option><option>STR</option><option>MEP</option><option>CIV</option>
            </select>
            <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
              <option value="">All statuses</option>
              <option value="draft">Draft</option>
              <option value="in_review">In review</option>
              <option value="approved">Approved</option>
              <option value="issued">Issued</option>
            </select>
            <button className="btn-pri" onClick={() => setCreating(true)}>+ New document</button>
          </div>

          <table className="d-table">
            <thead>
              <tr><th>Code</th><th>Title</th><th>Disc.</th><th>Rev</th><th>Status</th><th>Updated</th></tr>
            </thead>
            <tbody>
              {docs.map((d) => (
                <tr key={d.id} className="clickable" onClick={() => setOpenDoc(d)}>
                  <td className="mono">{d.doc_code}</td>
                  <td>{d.title}</td>
                  <td>{d.discipline}</td>
                  <td className="mono">{d.current_revision || '—'}</td>
                  <td>{d.current_status
                    ? <span className={`badge b-${d.current_status.replace('_', '-')}`}>{d.current_status}</span>
                    : <span className="muted small">no version</span>}</td>
                  <td className="muted small">{new Date(d.updated_at).toLocaleString()}</td>
                </tr>
              ))}
              {!docs.length && <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 32 }}>No documents.</td></tr>}
            </tbody>
          </table>
        </>
      )}

      {error && <div className="error">{error}</div>}

      {creating && (
        <CreateDocModal
          projectId={project.id}
          onClose={() => setCreating(false)}
          onCreated={(doc) => { setCreating(false); load(); setOpenDoc(doc); }}
        />
      )}
      {openDoc && (
        <div className="overlay">
          <DocumentDetail
            doc={openDoc}
            projectId={project.id}
            onClose={() => setOpenDoc(null)}
            onChange={load}
          />
        </div>
      )}
    </>
  );
}

// ===== App root =====
export default function App() {
  const [user, setUser] = useState(() => {
    const raw = localStorage.getItem('dcms_user');
    return raw ? JSON.parse(raw) : null;
  });
  const [project, setProject] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!user) return;
    api.get('/projects').then((ps) => {
      if (ps.length) setProject(ps[0]);
    }).catch((e) => setError(e.message));
  }, [user]);

  const logout = () => {
    localStorage.clear();
    setUser(null);
    setProject(null);
  };

  if (!user) return <Login onLogin={setUser} />;
  if (!project) return <div className="muted" style={{ padding: 32 }}>{error || 'Loading project…'}</div>;
  return <Register project={project} user={user} onLogout={logout} />;
}
