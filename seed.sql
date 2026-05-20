-- DCMS MVP — seed data
-- All three demo users have password: password

WITH new_users AS (
  INSERT INTO users (email, name, password_hash, default_role) VALUES
    ('alice@example.com', 'Alice Chen',  crypt('password', gen_salt('bf', 10)), 'controller'),
    ('bob@example.com',   'Bob Smith',   crypt('password', gen_salt('bf', 10)), 'reviewer'),
    ('chris@example.com', 'Chris Liang', crypt('password', gen_salt('bf', 10)), 'member')
  RETURNING id, email
), new_project AS (
  INSERT INTO projects (code, name) VALUES ('BR26', 'Bridge-PJ-2026')
  RETURNING id
), members AS (
  INSERT INTO project_members (project_id, user_id, role, discipline)
  SELECT (SELECT id FROM new_project), id,
         CASE email
           WHEN 'alice@example.com' THEN 'controller'
           WHEN 'bob@example.com'   THEN 'reviewer'
           ELSE 'member' END,
         CASE email
           WHEN 'bob@example.com'   THEN 'STR'
           WHEN 'chris@example.com' THEN 'ARC'
           ELSE NULL END
  FROM new_users
  RETURNING user_id
)
SELECT 'seeded' AS status;

-- Create two sample documents with an initial version each
DO $$
DECLARE
  v_project uuid;
  v_alice   uuid;
  v_chris   uuid;
  v_doc1    uuid;
  v_doc2    uuid;
  v_ver1    uuid;
  v_ver2    uuid;
  v_trm     uuid;
BEGIN
  SELECT id INTO v_project FROM projects WHERE code='BR26';
  SELECT id INTO v_alice   FROM users WHERE email='alice@example.com';
  SELECT id INTO v_chris   FROM users WHERE email='chris@example.com';

  INSERT INTO documents (project_id, doc_code, title, discipline, doc_type, created_by)
    VALUES (v_project, 'BR26-ARC-DWG-001', 'Architectural floor plan, level 1', 'ARC', 'DWG', v_chris)
    RETURNING id INTO v_doc1;

  INSERT INTO documents (project_id, doc_code, title, discipline, doc_type, created_by)
    VALUES (v_project, 'BR26-STR-CAL-001', 'Beam load calculation, span 12m', 'STR', 'CAL', v_alice)
    RETURNING id INTO v_doc2;

  INSERT INTO document_versions
    (document_id, revision, status, file_key, file_name, file_size, mime_type, checksum_sha256, change_note, created_by, issued_at)
    VALUES (v_doc1, 'A', 'issued', 'seed/arc-dwg-001-a.pdf', 'floor-plan-L1.pdf',
            102400, 'application/pdf',
            'a665a45920422f9d417e4867efdc4fb8a04a1f3fff1fa07e998e86f7f7a27ae3',
            'Initial release', v_chris, now())
    RETURNING id INTO v_ver1;
  UPDATE documents SET current_version_id = v_ver1 WHERE id = v_doc1;

  INSERT INTO document_versions
    (document_id, revision, status, file_key, file_name, file_size, mime_type, checksum_sha256, change_note, created_by)
    VALUES (v_doc2, 'A', 'in_review', 'seed/str-cal-001-a.pdf', 'beam-calc-A.pdf',
            55200, 'application/pdf',
            'b665a45920422f9d417e4867efdc4fb8a04a1f3fff1fa07e998e86f7f7a27ae3',
            'For peer review', v_alice, NULL)
    RETURNING id INTO v_ver2;
  UPDATE documents SET current_version_id = v_ver2 WHERE id = v_doc2;

  -- One transmittal already sent: Alice → Chris with the issued floor plan
  INSERT INTO transmittals (project_id, transmittal_no, purpose, cover_note, sender_id, status, sent_at)
    VALUES (v_project, 'BR26-TRM-2026-0001', 'for_construction',
            'Please confirm receipt before Friday.', v_alice, 'sent', now())
    RETURNING id INTO v_trm;

  INSERT INTO transmittal_items (transmittal_id, document_version_id) VALUES (v_trm, v_ver1);
  INSERT INTO transmittal_recipients (transmittal_id, user_id) VALUES (v_trm, v_chris);

  INSERT INTO audit_logs (user_id, action, entity_type, entity_id, detail)
    VALUES (v_alice, 'transmittal.send', 'transmittal', v_trm,
            jsonb_build_object('no', 'BR26-TRM-2026-0001'));
END $$;
