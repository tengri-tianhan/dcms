# DCMS — Document Coding Rules and Workflow Templates

This document defines the conventions the system enforces: how documents are named, how revisions advance, what status a document can be in, and which workflow template applies when. It is reference material for document controllers and the rules the system checks at runtime.

## 1. Document codes

### 1.1 Format

```
{PROJ}-{DISC}-{TYPE}-{NNN}-{REV}
```

Each segment is fixed width and separated by hyphens. Example: `BR26-STR-DWG-001-A`.

### 1.2 Segments

**PROJ** — project code. 3 to 6 alphanumeric characters, uppercase. Assigned by the admin when the project is created. Examples: `BR26`, `HKZM`, `RIYL2`.

**DISC** — discipline code. 3 letters, uppercase. The system ships with this default set; admins can extend per project.

| Code | Discipline | Code | Discipline |
|---|---|---|---|
| `ARC` | Architectural | `MEC` | Mechanical |
| `STR` | Structural    | `ELE` | Electrical |
| `CIV` | Civil         | `PLB` | Plumbing |
| `GEO` | Geotechnical  | `INS` | Instrumentation |
| `PRO` | Process       | `PJM` | Project management |

**TYPE** — document type. 3 letters, uppercase.

| Code | Document type | Code | Document type |
|---|---|---|---|
| `DWG` | Drawing            | `RPT` | Report |
| `CAL` | Calculation        | `MOM` | Minutes of meeting |
| `SPC` | Specification      | `LET` | Letter |
| `PRO` | Procedure          | `TRM` | Transmittal |
| `MAN` | Manual             | `VND` | Vendor data |

**NNN** — running sequence within the (project, discipline, type) tuple. 3 digits, zero-padded; system allocates the next available number when a document is created. Reaching `999` triggers an admin notification to widen to 4 digits.

**REV** — revision. See §2.

### 1.3 What the system enforces

- `doc_code` is unique per project and **immutable** after creation. If a document was coded wrong, soft-delete and recreate.
- Sequence numbers are server-allocated, not user-supplied, to prevent gaps and races.
- A document's `discipline` and `doc_type` cannot change after creation, because they're embedded in the code.

## 2. Revisions

### 2.1 Scheme

Two-phase, matching common EPC practice:

| Phase | Revisions | Meaning |
|---|---|---|
| Design phase | `A`, `B`, `C`, … | Iterating before formal issue |
| Issue phase  | `0`, `1`, `2`, … | After first formal release ("Issued for construction" or equivalent) |

A document's first revision is `A`. It progresses through letters during review cycles. The first issue resets to `0`. Subsequent revisions to an issued document increment from `0`: `1`, `2`, `3`, …

### 2.2 When to bump

| Trigger | Action |
|---|---|
| Internal change before any review | No bump — overwrite the existing version's file with a new upload (allowed only for `status=draft`) |
| Submitted for IDC or formal review | Bump letter: `A` → `B` |
| Reviewer comments addressed | Bump letter again |
| First formal release | Set revision to `0` |
| Change after issue | Bump number: `0` → `1` |

The previous revision is automatically marked `superseded` when a newer one becomes `approved`.

### 2.3 Authoring rules

- Only the original creator or a document controller can upload a new revision.
- Each revision must include a `change_note` (free text, 1+ chars). Empty change notes are rejected.
- The file checksum is stored — uploading the byte-identical file as a "new revision" is rejected to prevent accidental dupes.

## 3. Status lifecycle

```
draft ──▶ in_review ──▶ pending_approval ──▶ approved ──▶ issued
  │            │                  │              │           │
  │            │                  └─▶ rejected ──┘           │
  │            ▼                                              │
  └──▶ cancelled                              ◀── superseded ─┘
```

| Status | Set by | Meaning |
|---|---|---|
| `draft`            | Author on upload | Editable; can re-upload file |
| `in_review`        | Author submits   | Reviewer assigned via workflow |
| `pending_approval` | Reviewer signs off | Approver assigned via workflow |
| `approved`         | Approver signs off | Cleared for issue, but not yet distributed |
| `issued`           | Controller releases via transmittal | Live document — distribution tracked |
| `superseded`       | System (on newer revision becoming `approved`) | Read-only |
| `cancelled`        | Controller | Document withdrawn; reason required |

Transitions only follow the arrows. The API rejects out-of-order transitions with `code 40901`.

## 4. Workflow templates

The system ships with three templates. A project admin picks the default per (discipline, doc_type) pair; controllers can override per-document at the point of submission.

### 4.1 Standard design review

Used for: most engineering drawings, calculations, and specifications.

| # | Step | Assignee role | SLA (working days) | On approve | On reject |
|---|---|---|---|---|---|
| 1 | Draft       | Author       | —  | → step 2 | — |
| 2 | IDC         | Lead of each impacted discipline | 3 | → step 3 | → step 1 |
| 3 | Internal review | Discipline lead | 2 | → step 4 | → step 1 |
| 4 | Client review | Client rep | 5 | → step 5 | → step 1 |
| 5 | Approval    | Project manager | 1 | sets `approved` | → step 1 |
| 6 | Issue       | Document controller | 1 | sets `issued`; opens transmittal | n/a |

### 4.2 Fast track (for information)

Used for: meeting minutes, internal letters, status reports — anything that doesn't need client sign-off.

| # | Step | Assignee role | SLA | On approve | On reject |
|---|---|---|---|---|---|
| 1 | Draft | Author | — | → step 2 | — |
| 2 | Controller log | Document controller | 1 | sets `approved` → `issued`; auto-distributes per matrix | → step 1 |

### 4.3 Vendor submittal

Used for: vendor data, supplier drawings, equipment manuals.

| # | Step | Assignee role | SLA | On approve | On reject |
|---|---|---|---|---|---|
| 1 | Vendor submit | Vendor | — | → step 2 | — |
| 2 | DC log | Document controller | 1 | → step 3 | → step 1 (returned with comments) |
| 3 | Discipline review | Relevant discipline lead | 5 | → step 4 | → step 1 (returned with comments) |
| 4 | Disposition | Discipline lead | 1 | One of: `approved`, `approved_with_comments`, `rejected` | n/a |
| 5 | Return to vendor | Document controller | 1 | Closes workflow; transmittal sent to vendor | n/a |

## 5. Distribution matrix

When a document reaches `approved` (or `issued` for fast-track), the system looks up the distribution matrix to suggest recipients for the transmittal. The matrix is a set of rules per project:

```
(discipline, doc_type, purpose) → [recipient_role, recipient_role, ...]
```

`discipline` and `doc_type` may be `NULL` (wildcard). The system collects all matching rules and unions the recipient roles.

### 5.1 Example matrix (Bridge-PJ-2026)

| Discipline | Doc type | Purpose | Recipient roles |
|---|---|---|---|
| `*` | `*` | `for_construction` | Site supervisor, QA/QC, Owner rep |
| `STR` | `DWG` | `for_construction` | + Structural site engineer |
| `MEP` | `SPC` | `for_construction` | + MEP contractor |
| `*` | `MOM` | `for_information` | All project members |
| `*` | `VND` | `for_review` | Discipline lead, Procurement |

The controller can edit the suggested list before sending — the matrix is a default, not a hard rule.

### 5.2 What the system enforces

- Every transmittal must have at least one recipient.
- A recipient must be a member of the same project (no cross-project distribution).
- Vendors can only receive transmittals where they were the original document source.

## 6. Acknowledgments and overdue tracking

When a transmittal is sent, every recipient gets an unacknowledged entry. The system:

- Sends an email + in-app notification on send.
- Marks recipients as **overdue** if `now() > transmittal.due_at` and `acknowledged_at IS NULL`.
- Sends a reminder at `due_at - 1 day` and another at `due_at + 1 day`.
- Surfaces overdue counts on the project dashboard ("3 transmittals overdue" with a link to the filtered list).

Recipients acknowledge from their inbox view; the action writes `acknowledged_at = now()` and an optional response comment.

## 7. Audit log

Every action that changes state is recorded with `(user_id, action, entity_type, entity_id, detail, ip, occurred_at)`. The action taxonomy:

| Action | When |
|---|---|
| `document.create` | New document registered |
| `document.update` | Title or metadata edited |
| `document.delete` | Soft delete |
| `version.upload`  | New version uploaded |
| `version.transition` | Status changed |
| `transmittal.create` | Transmittal drafted |
| `transmittal.send`   | Transmittal sent to recipients |
| `transmittal.acknowledge` | Recipient acknowledged |
| `workflow.complete_step` | Workflow step actioned |
| `matrix.create` / `matrix.delete` | Distribution rule changed |
| `user.login` / `user.logout` | Session events |

Audit logs are immutable from the application — there's no `UPDATE` or `DELETE` endpoint. Cleanup is a DBA operation governed by retention policy (default: 7 years).
