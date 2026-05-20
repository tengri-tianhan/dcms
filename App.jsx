import React, { useEffect, useState, useCallback } from 'react';

// ============================================================================
// API helper — cookie-based; Bearer token kept as a fallback for the dev login
// ============================================================================
const api = {
  token: () => localStorage.getItem('dcms_token'),
  async req(path, opts = {}) {
    const headers = { ...opts.headers };
    if (opts.body && !(opts.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
    }
    const t = api.token();
    if (t) headers.Authorization = `Bearer ${t}`;
    const res = await fetch(`/api/v1${path}`, {
      ...opts,
      headers,
      credentials: 'include',
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.code !== 0) {
      throw new Error(json.message || `HTTP ${res.status}`);
    }
    return json.data;
  },
  get: (p) => api.req(p),
  post: (p, body) => api.req(p, { method: 'POST', body: JSON.stringify(body || {}) }),
  delete: (p) => api.req(p, { method: 'DELETE' }),
};

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ============================================================================
// Login — SSO button + (optional) password fallback
// ============================================================================
function Login({ onLogin }) {
  const [providers, setProviders] = useState({});
  const [email, setEmail] = useState('alice@example.com');
  const [password, setPassword] = useState('password');
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/auth/providers').then(setProviders).catch(() => {});
  }, []);

  const passwordSubmit = async (e) => {
    e.preventDefault();
    setError('');
    try {
      const data = await api.post('/auth/login', { email, password });
      // Cookie is set server-side; also stash the token for Bearer-only clients
      if (data.token) localStorage.setItem('dcms_token', data.token);
      localStorage.setItem('dcms_user', JSON.stringify(data.user));
      onLogin(data.user);
    } catch (e) { setError(e.message); }
  };

  const ssoSignIn = () => {
    window.location.href =
      `/api/v1/auth/sso/start?redirect_to=${encodeURIComponent(window.location.pathname)}`;
  };

  return (
    <div className="login-wrap">
      <div className="card login-card">
        <h1>DCMS</h1>
        <p className="muted">Sign in to continue.</p>

        {providers.sso && (
          <button className="btn-pri" onClick={ssoSignIn} style={{ width: '100%', marginBottom: 16 }}>
            Sign in with {providers.sso_label || 'single sign-on'}
          </button>
        )}

        {providers.password && (
          <>
            {providers.sso && <div className="muted small or-separator">— or —</div>}
            <form onSubmit={passwordSubmit}>
              <label>Email
                <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" required />
              </label>
              <label>Password
                <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" required />
              </label>
              {error && <div className="error">{error}</div>}
              <button type="submit">Sign in with password</button>
            </form>
            <p className="muted small">
              Demo accounts (password: <code>password</code>): alice (controller), bob (STR reviewer), chris (ARC member)
            </p>
          </>
        )}

        {!providers.sso && !providers.password && (
          <div className="error">No authentication method available.</div>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// Create document modal — unchanged from MVP
// ============================================================================
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
            {['ARC', 'STR', 'CIV', 'MEC', 'ELE', 'PLB', 'GEO', 'PRO'].map((d) =>
              <option key={d}>{d}</option>)}
          </select>
        </label>
        <label>Type
          <select value={docType} onChange={(e) => setDocType(e.target.value)}>
            {['DWG', 'CAL', 'SPC', 'RPT', 'MOM', 'LET', 'MAN', 'VND'].map((t) =>
              <option key={t}>{t}</option>)}
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

// ============================================================================
// Two-phase upload — init-upload → PUT to S3 → SHA-256 → register
// ============================================================================
function UploadVersionModal({ docId, onClose, onUploaded }) {
  const [file, setFile] = useState(null);
  const [revision, setRevision] = useState('A');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    if (!file) return setError('Pick a file');
    setBusy(true); setError(''); setProgress('');
    try {
      setProgress('Requesting upload URL…');
      const init = await api.post(`/documents/${docId}/versions/init-upload`, {
        file_name: file.name,
        mime_type: file.type || 'application/octet-stream',
        file_size: file.size,
      });

      setProgress('Uploading to storage…');
      const putRes = await fetch(init.upload_url, {
        method: 'PUT',
        body: file,
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
      });
      if (!putRes.ok) throw new Error(`Upload failed: ${putRes.status}`);

      setProgress('Computing checksum…');
      const buf = await file.arrayBuffer();
      const hashBuf = await crypto.subtle.digest('SHA-256', buf);
      const sha = Array.from(new Uint8Array(hashBuf))
        .map((b) => b.toString(16).padStart(2, '0')).join('');

      setProgress('Registering version…');
      const v = await api.post(`/documents/${docId}/versions`, {
        revision,
        file_key: init.file_key,
        file_name: file.name,
        file_size: file.size,
        mime_type: file.type || 'application/octet-stream',
        checksum_sha256: sha,
        change_note: note || 'Initial upload',
      });
      onUploaded(v);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); setProgress(''); }
  };

  return (
    <div className="modal-bg" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h3>Upload new version</h3>
        <label>Revision
          <input value={revision} onChange={(e) => setRevision(e.target.value)}
                 maxLength={3} required />
        </label>
        <label>File
          <input type="file" onChange={(e) => setFile(e.target.files[0])} required />
        </label>
        <label>Change note
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2}
                    placeholder="What changed?" />
        </label>
        {progress && <div className="muted small">{progress}</div>}
        {error && <div className="error">{error}</div>}
        <div className="actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-pri" disabled={busy}>
            {busy ? 'Uploading…' : 'Upload'}
          </button>
        </div>
      </form>
    </div>
  );
}

// ============================================================================
// Send transmittal modal — unchanged shape from MVP
// ============================================================================
function SendTransmittalModal({ projectId, versionId, onClose, onSent }) {
  const [members, setMembers] = useState([]);
  const [purpose, setPurpose] = useState('for_review');
  const [recipients, setRecipients] = useState([]);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    api.get(`/projects/${projectId}/members`).then(setMembers).catch(() => {});
  }, [projectId]);

  const toggle = (uid) =>
    setRecipients((rs) => rs.includes(uid) ? rs.filter((x) => x !== uid) : [...rs, uid]);

  const submit = async (e) => {
    e.preventDefault();
    if (!recipients.length) return setError('Pick at least one recipient');
    try {
      const t = await api.post(`/projects/${projectId}/transmittals`, {
        purpose, cover_note: note,
        version_ids: [versionId], recipient_user_ids: recipients,
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
        <div className="muted small">Recipients</div>
        <div className="recipients">
          {members.map((m) => (
            <label key={m.id} className="checkbox">
              <input type="checkbox" checked={recipients.includes(m.id)}
                     onChange={() => toggle(m.id)} />
              {m.name} <span className="muted small">{m.role}{m.discipline ? `/${m.discipline}` : ''}</span>
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

// ============================================================================
// Workflow progress — small inline summary
// ============================================================================
function WorkflowProgress({ wf }) {
  if (!wf) return <span className="muted small">No workflow</span>;
  const completed = wf.steps.filter((s) => s.status === 'completed').length;
  const total = wf.steps.length;
  const tooltip = wf.steps
    .map((s) => `${s.sequence}. ${s.step_name} (${s.status}${s.assignee_name ? ' → ' + s.assignee_name : ''})`)
    .join('\n');
  return (
    <div title={tooltip} className="wf-progress">
      <div className="small">{wf.template_name || wf.template_code}</div>
      <div className="muted small">{completed} / {total} steps · {wf.status}</div>
    </div>
  );
}

// ============================================================================
// Document detail — versions, workflow start, transmittal send
// ============================================================================
function DocumentDetail({ doc, project, onClose, onChange }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [showUpload, setShowUpload] = useState(false);
  const [sendFor, setSendFor] = useState(null);
  const [workflows, setWorkflows] = useState({});

  const load = useCallback(() => {
    api.get(`/documents/${doc.id}`).then(setData).catch((e) => setError(e.message));
  }, [doc.id]);

  useEffect(load, [load]);

  // Fetch workflow status per version (silent on 404 — version may have no workflow)
  useEffect(() => {
    if (!data?.versions) return;
    Promise.all(
      data.versions.map((v) =>
        api.get(`/versions/${v.id}/workflow`)
          .then((wf) => [v.id, wf])
          .catch(() => [v.id, null])
      )
    ).then((pairs) => setWorkflows(Object.fromEntries(pairs)));
  }, [data]);

  const download = async (vid) => {
    try {
      const { download_url } = await api.get(`/versions/${vid}/download-url`);
      window.location.href = download_url;
    } catch (e) { setError(e.message); }
  };

  const startWorkflow = async (vid) => {
    try {
      await api.post(`/versions/${vid}/start-workflow`, {});
      load(); onChange?.();
    } catch (e) { setError(e.message); }
  };

  if (!data) return null;

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="detail-head">
          <div>
            <div className="mono">{data.doc_code}</div>
            <h3>{data.title}</h3>
            <div className="muted small">
              {data.discipline} · {data.doc_type} · {data.source}
            </div>
          </div>
          <button onClick={onClose}>Close</button>
        </div>

        <div className="version-head">
          <h4>Versions</h4>
          <button className="btn-pri" onClick={() => setShowUpload(true)}>
            + Upload new version
          </button>
        </div>

        <table className="d-table">
          <thead>
            <tr>
              <th>Rev</th><th>Status</th><th>Workflow</th><th>File</th>
              <th>Uploaded</th><th></th>
            </tr>
          </thead>
          <tbody>
            {data.versions.map((v) => (
              <tr key={v.id}>
                <td className="mono">{v.revision}</td>
                <td><span className={`badge badge-${v.status}`}>{v.status}</span></td>
                <td><WorkflowProgress wf={workflows[v.id]} /></td>
                <td className="muted small">
                  {v.file_name}<br />
                  {(v.file_size / 1024).toFixed(0)} KB
                </td>
                <td className="muted small">
                  {v.created_by_name}<br />
                  {new Date(v.created_at).toLocaleString()}
                </td>
                <td style={{ textAlign: 'right' }}>
                  <button onClick={() => download(v.id)}>Download</button>
                  {v.status === 'draft' && !workflows[v.id] && (
                    <button className="btn-pri" onClick={() => startWorkflow(v.id)}>
                      Start workflow
                    </button>
                  )}
                  {(v.status === 'approved' || v.status === 'issued') && (
                    <button className="btn-pri" onClick={() => setSendFor(v.id)}>
                      Send transmittal
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {!data.versions.length && (
              <tr><td colSpan={6} className="muted small">No versions yet. Upload one to get started.</td></tr>
            )}
          </tbody>
        </table>

        {error && <div className="error">{error}</div>}

        {showUpload && (
          <UploadVersionModal docId={doc.id}
                              onClose={() => setShowUpload(false)}
                              onUploaded={() => { setShowUpload(false); load(); onChange?.(); }} />
        )}
        {sendFor && (
          <SendTransmittalModal projectId={project.id} versionId={sendFor}
                                onClose={() => setSendFor(null)}
                                onSent={() => { setSendFor(null); load(); onChange?.(); }} />
        )}
      </div>
    </div>
  );
}

// ============================================================================
// Task inbox — workflow steps assigned to me
// ============================================================================
function TaskInbox({ onChange }) {
  const [tasks, setTasks] = useState([]);
  const [error, setError] = useState('');
  const [actingOn, setActingOn] = useState(null);

  const load = useCallback(() => {
    api.get('/workflow/my-pending').then(setTasks).catch((e) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  const act = async (stepId, action) => {
    const comment = action === 'rejected'
      ? prompt('Reason for rejection (optional):')
      : action === 'commented' ? prompt('Comment:') : null;
    if (action === 'commented' && !comment) return;
    setActingOn(stepId);
    try {
      await api.post(`/workflow-steps/${stepId}/complete`, { action, comment });
      load(); onChange?.();
    } catch (e) { setError(e.message); }
    finally { setActingOn(null); }
  };

  if (!tasks.length && !error) {
    return <div className="card muted">No pending tasks.</div>;
  }

  return (
    <div className="card">
      <h3>My pending tasks</h3>
      {error && <div className="error">{error}</div>}
      <table className="d-table">
        <thead>
          <tr><th>Document</th><th>Step</th><th>Due</th><th style={{ textAlign: 'right' }}>Action</th></tr>
        </thead>
        <tbody>
          {tasks.map((t) => (
            <tr key={t.step_id}>
              <td>
                <div className="mono">{t.doc_code} · Rev {t.revision}</div>
                <div className="muted small">{t.title}</div>
              </td>
              <td>
                {t.step_name}
                <div className="muted small">{t.template_code}</div>
              </td>
              <td className="muted small">
                {t.due_at ? new Date(t.due_at).toLocaleDateString() : '—'}
              </td>
              <td style={{ textAlign: 'right' }}>
                <button onClick={() => act(t.step_id, 'commented')}
                        disabled={actingOn === t.step_id}>Comment</button>
                <button onClick={() => act(t.step_id, 'rejected')}
                        disabled={actingOn === t.step_id}>Reject</button>
                <button className="btn-pri" onClick={() => act(t.step_id, 'approved')}
                        disabled={actingOn === t.step_id}>Approve</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ============================================================================
// Inbox — transmittals I haven't acknowledged
// ============================================================================
function Inbox({ onChange }) {
  const [list, setList] = useState([]);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    api.get('/transmittals/my-pending').then(setList).catch((e) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  const ack = async (row) => {
    const response = prompt('Response (optional):');
    try {
      await api.post(
        `/transmittals/${row.transmittal_id}/recipients/${row.recipient_id}/acknowledge`,
        { response }
      );
      load(); onChange?.();
    } catch (e) { setError(e.message); }
  };

  if (!list.length && !error) {
    return <div className="card muted">Inbox is empty.</div>;
  }

  return (
    <div className="card">
      <h3>My inbox</h3>
      {error && <div className="error">{error}</div>}
      <table className="d-table">
        <thead>
          <tr><th>Transmittal</th><th>From</th><th>Purpose</th><th>Sent</th><th></th></tr>
        </thead>
        <tbody>
          {list.map((row) => (
            <tr key={row.recipient_id}>
              <td className="mono">{row.transmittal_no}<div className="muted small">{row.cover_note}</div></td>
              <td>{row.sender_name}</td>
              <td><span className={`pill pill-${row.purpose}`}>{row.purpose.replace(/_/g, ' ')}</span></td>
              <td className="muted small">{new Date(row.sent_at).toLocaleString()}</td>
              <td style={{ textAlign: 'right' }}>
                <button className="btn-pri" onClick={() => ack(row)}>Acknowledge</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ============================================================================
// Register — document list with debounced search + filters
// ============================================================================
function Register({ project, onOpenDoc, reloadKey }) {
  const [docs, setDocs] = useState([]);
  const [highlights, setHighlights] = useState({});
  const [searchMode, setSearchMode] = useState(false);
  const [q, setQ] = useState('');
  const [discipline, setDiscipline] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [showCreate, setShowCreate] = useState(false);

  const load = useCallback(async () => {
    try {
      if (q && q.length >= 2) {
        setSearchMode(true);
        const params = new URLSearchParams({ q });
        if (discipline) params.set('discipline', discipline);
        if (status) params.set('status', status);
        const res = await api.get(`/projects/${project.id}/documents/search?${params}`);
        setDocs(res.hits);
        const h = {};
        for (const hit of res.hits) {
          if (hit._highlight?.title) h[hit.id] = hit._highlight.title[0];
        }
        setHighlights(h);
      } else {
        setSearchMode(false);
        setHighlights({});
        const params = new URLSearchParams();
        if (discipline) params.set('discipline', discipline);
        if (status) params.set('status', status);
        const rows = await api.get(`/projects/${project.id}/documents?${params}`);
        setDocs(rows);
      }
    } catch (e) { setError(e.message); }
  }, [project.id, q, discipline, status]);

  // Debounced reload on input changes
  useEffect(() => {
    const h = setTimeout(load, q ? 200 : 0);
    return () => clearTimeout(h);
  }, [load, q]);

  // External reload (after upload / workflow / transmittal in detail panel)
  useEffect(() => { load(); }, [reloadKey, load]);

  return (
    <div>
      <div className="filters">
        <input className="search" placeholder="Search by code or title…"
               value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={discipline} onChange={(e) => setDiscipline(e.target.value)}>
          <option value="">All disciplines</option>
          {['ARC', 'STR', 'CIV', 'MEC', 'ELE'].map((d) => <option key={d}>{d}</option>)}
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          {['draft', 'in_review', 'pending_approval', 'approved', 'issued', 'superseded', 'cancelled']
            .map((s) => <option key={s}>{s}</option>)}
        </select>
        <div className="filter-spacer" />
        <button className="btn-pri" onClick={() => setShowCreate(true)}>+ New document</button>
      </div>

      {searchMode && (
        <div className="muted small" style={{ margin: '4px 0 8px' }}>
          {docs.length} result{docs.length === 1 ? '' : 's'} ranked by relevance
        </div>
      )}

      {error && <div className="error">{error}</div>}

      <table className="d-table">
        <thead>
          <tr>
            <th>Code / Title</th><th>Discipline</th><th>Type</th>
            <th>Current rev</th><th>Status</th><th>Updated</th>
          </tr>
        </thead>
        <tbody>
          {docs.map((d) => (
            <tr key={d.id} onClick={() => onOpenDoc(d)} className="clickable">
              <td>
                <div className="mono">{d.doc_code}</div>
                <div className="muted small"
                     dangerouslySetInnerHTML={{
                       __html: highlights[d.id] || escapeHtml(d.title),
                     }} />
              </td>
              <td>{d.discipline}</td>
              <td>{d.doc_type}</td>
              <td className="mono">{d.current_revision || '—'}</td>
              <td>
                {d.current_status
                  ? <span className={`badge badge-${d.current_status}`}>{d.current_status}</span>
                  : <span className="muted small">no version</span>}
              </td>
              <td className="muted small">{new Date(d.updated_at).toLocaleDateString()}</td>
            </tr>
          ))}
          {!docs.length && (
            <tr><td colSpan={6} className="muted small" style={{ padding: 24, textAlign: 'center' }}>
              No documents match.
            </td></tr>
          )}
        </tbody>
      </table>

      {showCreate && (
        <CreateDocModal projectId={project.id}
                        onClose={() => setShowCreate(false)}
                        onCreated={() => { setShowCreate(false); load(); }} />
      )}
    </div>
  );
}

// ============================================================================
// App shell — auth, project, tabs
// ============================================================================
export default function App() {
  const [user, setUser]       = useState(null);
  const [projects, setProjects] = useState([]);
  const [project, setProject]   = useState(null);
  const [tab, setTab]           = useState('register');
  const [openDoc, setOpenDoc]   = useState(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [error, setError]       = useState('');
  const [booting, setBooting]   = useState(true);

  // Try to restore a session from the cookie set by SSO or password login.
  useEffect(() => {
    (async () => {
      try {
        const data = await api.get('/auth/me');
        setUser(data.user);
        setProjects(data.projects);
        setProject(data.projects[0] || null);
      } catch {
        // Not signed in — show login
      } finally { setBooting(false); }
    })();
  }, []);

  const reload = () => setReloadKey((k) => k + 1);

  const logout = async () => {
    try { await api.post('/auth/logout', {}); } catch {}
    localStorage.removeItem('dcms_token');
    localStorage.removeItem('dcms_user');
    setUser(null); setProject(null); setProjects([]);
  };

  if (booting) return <div className="login-wrap"><div className="muted">Loading…</div></div>;
  if (!user) return <Login onLogin={async () => {
    const data = await api.get('/auth/me');
    setUser(data.user); setProjects(data.projects); setProject(data.projects[0] || null);
  }} />;

  if (!project) {
    return (
      <div className="login-wrap">
        <div className="card login-card">
          <h2>No project</h2>
          <p className="muted">You're signed in as <strong>{user.email}</strong> but haven't been added to any project yet.</p>
          <button onClick={logout}>Sign out</button>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <strong>DCMS</strong>
          <span className="muted"> / </span>
          {projects.length > 1 ? (
            <select value={project.id} onChange={(e) =>
              setProject(projects.find((p) => p.id === e.target.value))}>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          ) : <span>{project.name}</span>}
        </div>
        <div className="user-bar">
          <span className="muted">{user.name} · {project.role}</span>
          <button onClick={logout}>Sign out</button>
        </div>
      </header>

      <nav className="tabs">
        <button className={tab === 'register' ? 'tab active' : 'tab'}
                onClick={() => setTab('register')}>Register</button>
        <button className={tab === 'tasks' ? 'tab active' : 'tab'}
                onClick={() => setTab('tasks')}>My tasks</button>
        <button className={tab === 'inbox' ? 'tab active' : 'tab'}
                onClick={() => setTab('inbox')}>Inbox</button>
      </nav>

      <main className="content">
        {error && <div className="error">{error}</div>}
        {tab === 'register' && (
          <Register project={project} reloadKey={reloadKey}
                    onOpenDoc={(d) => setOpenDoc(d)} />
        )}
        {tab === 'tasks' && <TaskInbox onChange={reload} />}
        {tab === 'inbox' && <Inbox onChange={reload} />}
      </main>

      {openDoc && (
        <DocumentDetail doc={openDoc} project={project}
                        onClose={() => setOpenDoc(null)}
                        onChange={reload} />
      )}
    </div>
  );
}
