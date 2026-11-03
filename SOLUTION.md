# SOLUTION.md — Planned solution (English)

> Planned solution for the JustInsurance support-desk work sample. Decisions below come from the candidate's answers; the implementation follows them consistently across all requirements. This document is the blueprint that will be executed.

## 0. Overview (README + CONTRACT)

### What README asks for
- Goal: make one customer-support workflow safe and usable (inbox connected to a GHL-like mock CRM).
- Time: up to 3h implementation + 45min walkthrough. Node 24+, built-in SQLite, no npm deps.
- Run: Terminal A `npm run provider`, Terminal B `npm start`, Terminal C `npm run event` (twice), `npm test`.
- Deliverables: code + tests, `HANDOFF.md` (≤2 pages), AI-use note, approximate time. Exclude `data/`, secrets, deps.
- Six required behaviors: (1) safe/idempotent inbound delivery; (2) tenant isolation; (3) exact approval; (4) honest delivery + recovery; (5) human takeover; (6) usable handoff.
- Not required: full CRM, real OAuth, production auth, real LLM, SCORM, etc.

### What CONTRACT fixes
- Ports: app 4300, provider 4301. Identities: `demo-alpha-token`→alpha/ticket 101; `demo-beta-token`→beta/ticket 202; webhook secret `fictional-webhook-secret`.
- Public HTTP routes (preserve). Provider semantics: 503 = definitely not accepted; 504 = unknown; connection loss = unknown; lookup `not_found` = inconclusive.
- `DeskService` with `listTickets, getTicket, receiveWebhook, updateDraft, approveDraft, handoff, sendReply, reconcile, close`, accepts `{databasePath, provider}`.
- Provider: async `send(payload)` (may throw with `kind:'not_accepted'` or anything else = uncertain), `lookup(clientRef)`.
- Persistence in SQLite `data/`; restart must retain state.

### Intentional starter defects
- `row()` does not filter by tenant → cross-tenant access.
- `receiveWebhook()` is not idempotent (no processed-events table).
- `updateDraft()` does not invalidate approval exactly.
- `sendReply()` retries, uses a new clientRef each time, marks SENT without evidence, does not handle 504/unknown, does not check takeover.
- `reconcile()` not implemented.
- UI lacks explicit UNKNOWN state.

---

## 1. Safe inbound delivery (webhook idempotency)

**Decision summary:** idempotency keyed by `(tenant_id, event_id)` with an optimistic/versioned write; a replay is ignored; auth and IDs are validated server-side; the write and its business change succeed or fail together in one transaction.

- **Q1.1 — Idempotency model:** `processed_events` table with PK `(tenant_id, event_id)`. Columns: `tenant_id TEXT`, `event_id TEXT`, `ticket_id INTEGER`, `body TEXT`, `processed_at TEXT`. PK guarantees uniqueness per organization (Alpha and Beta may both have `event-1`).
- **Q1.2 — Transaction / concurrency:** one SQLite transaction wraps `INSERT processed_events` + `INSERT messages` + `INSERT audit`. Use `BEGIN IMMEDIATE` (exclusive) to serialize writers; `busy_timeout` already 3000ms. Optimistic version control is an *additional* guard (row version check on ticket), but the unique constraint on processed events is the authoritative idempotency key. On constraint violation → treat as replay → return `{accepted:true, duplicate:true}` without re-applying.
- **Q1.3 — Same event, different body:** ignored (idempotent). The first body wins; subsequent replays return the duplicate result and do not overwrite the message or audit.
- **Q1.4 — Webhook auth + IDs:** validate `X-Demo-Webhook-Secret`; on mismatch 401. Validate `tenantId`, `ticketId`, `eventId`, `body` server-side: tenant must match a known ticket (`tickets.id = ticketId AND tenant_id = tenantId`); `eventId` non-empty string; `body` string. Cross-tenant / mismatched IDs → 400/404. Never trust a client-supplied tenant to authorize beyond this validation; the ticket lookup is scoped.
- **Q1.5 — Replay after restart:** `processed_events` persists in SQLite, so a restart does not lose idempotency. The unique PK survives restarts.
- **Q1.6 — Overlapping requests:** `BEGIN IMMEDIATE` + unique constraint + catch `SQLITE_CONSTRAINT` → idempotent success. Optimistic version control (ticket `version`) is used where a ticket mutation occurs; for inbound messages the event PK is the guard.

---

## 2. Customer isolation

**Decision summary:** server-side identity is authoritative; `row()` filters by tenant; any supplied `tenantId` is validated and rejected on mismatch; all ticket-scoped reads/writes go through the filtered `row()`.

- **Q2.1 — `row(actor, id)`:** `SELECT * FROM tickets WHERE id = ? AND tenant_id = ?`; if none → `DeskError(404, 'Ticket not found')`. No tenant leakage.
- **Q2.2 — All operations through `row()`:** `getTicket`, `updateDraft`, `approveDraft`, `handoff`, `sendReply`, `reconcile` all call the filtered `row()`. `listTickets` already filters by `actor.tenantId`.
- **Q2.3 — Supplied `tenantId`:** ignored for authorization; if present in a webhook it must match the ticket's tenant or the request is rejected (400/404). Browser-supplied tenant never grants access.
- **Q2.4 — Messages/audit/attempts:** read via `ticketView` only after `row()` validates ownership; never queried by raw id without tenant check.
- **Q2.5 — Cross-tenant tests:** alpha → ticket 202 and beta → ticket 101 must return 403/404 on GET, draft, approve, send, automation, handoff, reconcile, and audit access.

---

## 3. Exact approval

**Decision summary:** versioned draft + `approved_version`; editing bumps version and clears approval; send requires `approved_version === version`; repeated/overlapping send is deduplicated by the unique `(ticket_id, version)` on attempts.

- **Q3.1 — Model:** `draft TEXT`, `version INTEGER`, `approved_version INTEGER NULL`. `updateDraft` sets `draft`, `version = version + 1`, `approved_version = NULL`, `send_state = 'DRAFT'`. `approveDraft` sets `approved_version = version` only if a non-empty draft exists.
- **Q3.2 — Send guard:** `sendReply` requires `approved_version IS NOT NULL AND approved_version === version`. The body sent is the current `draft` (which cannot have changed without bumping version and clearing approval). If not approved → 409.
- **Q3.3 — Dedup of send:** attempts table has `UNIQUE(ticket_id, version)`. Before sending, check for an existing attempt for `(ticket, version)`; if present, return its current state without calling the provider or creating a new attempt. Repeated clicks/overlapping requests reuse the same attempt.
- **Q3.4 — Post-send state:** on confirmed delivery → `send_state = 'SENT'`. Keep `approved_version` (it records what was approved/sent).
- **Q3.5 — Re-edit after send:** `updateDraft` resets `send_state = 'DRAFT'` and clears `approved_version`, starting a new cycle.

---

## 4. Honest delivery and recovery

**Decision summary:** persist an attempt (with a stable clientRef) before calling the provider; classify 503 as safe failure, 504/network as UNKNOWN; never auto-retry; reconcile via lookup without resending; restart-safe via persisted attempt.

- **Q4.1 — Attempt first:** `sendReply` creates an attempt row (`state = 'PENDING'`, fresh `clientRef = randomUUID()`) in a transaction *before* calling `provider.send`. This is the durable record of intent.
- **Q4.2 — 503 (not_accepted):** mark attempt `FAILED` (safe failure), `send_state = 'FAILED'`, audit `delivery_failed`. No retry. Return ticket.
- **Q4.3 — 504 / network (unknown):** mark attempt `UNKNOWN`, store `clientRef` (and `providerMessageId` if present), `send_state = 'UNKNOWN'`, audit `delivery_unknown`. Do not resend. Return ticket.
- **Q4.4 — 200 (accepted):** mark attempt `DELIVERED` with `providerMessageId`, `send_state = 'SENT'`, audit `sent`.
- **Q4.5 — Restart safety:** the attempt persists with its clientRef. `sendReply` checks for an existing attempt for `(ticket, version)` first; if found, it returns the current state without creating a new attempt or calling the provider. A restart after recording an attempt causes no second send.
- **Q4.6 — `reconcile`:** load the last attempt. If `state === 'UNKNOWN'` (or PENDING): call `provider.lookup(clientRef)`.
  - `delivered` → set attempt `DELIVERED` + `providerMessageId`, `send_state = 'SENT'`, audit `reconciled_delivered`.
  - `not_found` → inconclusive: keep `UNKNOWN`, audit `reconcile_inconclusive`. Do not authorize a retry.
  - lookup throws → audit `reconcile_failed`, return error; state unchanged.
  - If no uncertain attempt → 409/400 "nothing to reconcile".
- **Q4.7 — `accept_then_delay` (10s):** supports kill/restart during send; the attempt is already persisted (PENDING/UNKNOWN depending on outcome), so restart leaves it recoverable; reconcile afterward.
- **Q4.8 — Idempotent reconcile:** repeated reconcile calls only consult the provider; never resend. If already DELIVERED, return current state.
- **Q4.9 — clientRef stability:** one clientRef per attempt, persisted. A new attempt (new approved version) gets a new clientRef. No blind reuse across versions.

---

## 5. Human takeover

**Decision summary:** `handoff` sets owner to `human` and audits; automation dispatch is refused server-side after takeover; manual approved send remains allowed.

- **Q5.1 — `handoff`:** `owner = 'human'`, audit `human_handoff`. Does not invalidate draft/approval (operator may still send an approved reply).
- **Q5.2 — Automation refused:** `sendReply(..., {automatic:true})` checks `owner === 'human'` → `DeskError(409, 'Automation refused after human takeover')`. Enforced in server-side code, not UI.
- **Q5.3 — Manual send after takeover:** allowed if a valid approval exists (`approved_version === version`).
- **Q5.4 — In-flight automation:** takeover committed before dispatch refuses the dispatch; a message already dispatched before takeover is not recalled (out of scope). Concurrency: the owner check happens at the moment of actual send inside the transaction.

---

## 6. Usable handoff (UI)

- **Q6.1 — Show:** conversation, owner, current draft/approval, delivery status, audit trail, attempts. Already partially present; extend to show UNKNOWN and next safe action.
- **Q6.2 — Safe rendering:** customer text via `textContent` (already). Never `innerHTML`. Audit/messages rendered as text.
- **Q6.3 — UNKNOWN state + next action:** display `UNKNOWN` delivery state and enable "Check delivery" (reconcile). Disable Send when not approved or when an UNKNOWN attempt exists.
- **Q6.4 — Refresh/errors:** refresh ticket after each action; surface errors in `#notice`.
- **Q6.5 — XSS:** keep all untrusted text as text nodes; no HTML injection in audit rendering.

---

## 7. Architecture / concurrency / persistence

- **Q7.1 — Transactions:** manual `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK` via `db.exec` around multi-statement writes (webhook, send, reconcile). Single statements remain autocommit.
- **Q7.2 — Concurrency:** SQLite `busy_timeout = 3000ms` + short transactions + `BEGIN IMMEDIATE` serializes writers. Per-ticket logical locking is approximated by the transaction; acceptable for single-process scope.
- **Q7.3 — Schema migration:** idempotent `CREATE TABLE IF NOT EXISTS` + guarded `ALTER TABLE` (try/catch) for new columns (`approved_version` already exists; add `processed_events`, ensure `attempts` columns). Keep fixture seed with `INSERT OR IGNORE`.
- **Q7.4 — `close()`:** closes db; tests use `:memory:`.
- **Q7.5 — `DeskError`:** keep status-bearing errors; server maps to HTTP.

### Schema additions

```sql
CREATE TABLE IF NOT EXISTS processed_events (
  tenant_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  ticket_id INTEGER NOT NULL,
  body TEXT NOT NULL,
  processed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, event_id)
);
```

`attempts` already has `UNIQUE(ticket_id, version)` and `client_ref TEXT NOT NULL UNIQUE`. Add `state` values: `PENDING`, `DELIVERED`, `FAILED`, `UNKNOWN`. Add column `created_at` optional (not required).

---

## 8. Tests to add

- Webhook replay twice (same event) → one message, one audit; second returns duplicate.
- Webhook replay after restart (new DeskService on same db) → still one message.
- Overlapping webhook requests → one message.
- Alpha/beta cross-tenant on all routes → 403/404.
- `tenantId` in request body cannot grant access.
- Draft edit invalidates approval (`approved_version` becomes null).
- Send without approval → 409.
- Double send (repeated click / overlapping) → one provider call.
- Provider 503 → FAILED, no retry.
- Provider 504 → UNKNOWN + clientRef; reconcile delivered → SENT.
- Provider `not_found` on reconcile → stays UNKNOWN.
- Restart after recording attempt → no second send.
- Automation after handoff → refused; manual send still works.
- UI renders customer text as text (no HTML execution) — manual/optional.

Provider fake supports modes: normal, 503, 504, delay, not_found lookup.

---

## 9. HANDOFF.md / AI note / time (to be filled at submission)

- **Q9.1 — Approximate time spent:** _TBD._
- **Q9.2 — AI tools used + one accepted/changed suggestion + verification:** _TBD._
- **Q9.3 — Remaining limitations:** _TBD (single process, no distributed DB, no real OAuth, no real LLM, no recall of dispatched messages, no sophisticated retry scheduler)._

---

## Execution order

1. Schema + store helpers (processed_events, tenant-filtered row, transaction helpers).
2. `receiveWebhook` idempotent transaction.
3. Tenant isolation in `row()` + all methods.
4. Exact approval (version + approved_version invalidation).
5. `sendReply` with attempt-first, classification, dedup, takeover check.
6. `reconcile`.
7. `handoff` + automation refusal.
8. UI updates for UNKNOWN state + safe rendering.
9. Tests.
10. HANDOFF.md + AI note.

A smaller honest implementation is preferred over unsupported production claims.

## Implementation status

Implemented in `src/store.mjs` and `src/service.mjs` (server/UI unchanged except SIGINT). Verification: `npm test` → 19/19 passing (2 baseline + 17 new). Manual integration verified: webhook replay dedup, accept_then_timeout → UNKNOWN + reconcile → SENT, reject_before_accept → FAILED, handoff blocks automation, manual send after takeover works, cross-tenant 404, restart during accept_then_delay leaves attempt PENDING with no second delivery.