# Handoff

## Changes and ownership

Implemented in `src/store.mjs` and `src/service.mjs` (server/UI unchanged except SIGINT handling in `src/server.mjs`).

The work followed a documented plan: `SOLUTION.md` (English) / `SOLUTION_ES.md` (Spanish) captured the design decisions and open questions first; OpenCode then executed the implementation against that plan; finally the result was validated with the automated and manual checks listed below.

- **Safe inbound delivery:** added `processed_events` table with PK `(tenant_id, event_id)`; `receiveWebhook` now validates auth/IDs server-side, looks up the ticket scoped to the supplied tenant, and writes the event + message + audit in one `BEGIN IMMEDIATE` transaction. Replays (including overlapping and post-restart) return `{duplicate:true}` without re-applying.
- **Customer isolation:** `row(actor, id)` now filters `WHERE id = ? AND tenant_id = ?`; every ticket-scoped operation (`getTicket`, `updateDraft`, `approveDraft`, `handoff`, `sendReply`, `reconcile`) goes through it. A client-supplied `tenantId` is validated against the ticket and rejected on mismatch; it never grants access.
- **Exact approval:** `updateDraft` bumps `version` and clears `approved_version`; `approveDraft` sets `approved_version = version`; `sendReply` requires `approved_version === version`. Editing after approval invalidates it.
- **Honest delivery:** `sendReply` persists an attempt (`PENDING`, stable `clientRef`) before calling the provider; classifies 503 as `FAILED` (safe failure), 504/network as `UNKNOWN`; never auto-retries; repeated/overlapping sends reuse the existing attempt. `reconcile` uses `provider.lookup` and resolves to `SENT` only on `delivered`; `not_found` is inconclusive and leaves `UNKNOWN`.
- **Human takeover:** `handoff` sets owner to `human` and audits; `sendReply({automatic:true})` refuses with 409 after takeover; manual approved send still works.
- **Usable handoff:** UI already renders conversation, owner, draft/approval, delivery state, audit trail and attempts as text (no HTML injection); UNKNOWN state and reconcile action are available.

## Verification

Commands and results (from a clean checkout, Node 24+):

- `npm test` → **19/19 passing** (2 baseline smoke + 17 new).
- `npm run provider` + `npm start`, then `node verify-http.mjs` → **15/15 passing**.
- Manual restart-during-delay scenario (provider `accept_then_delay`, kill app mid-send, restart) → provider ledger shows 1 delivery; ticket `send_state = PENDING`; second send creates no new delivery; reconcile → `SENT`.

New tests cover: webhook replay twice and after restart; overlapping webhooks; Alpha/Beta both using `event-1`; invalid webhook auth/IDs; cross-tenant denial on all routes; `tenantId` in body cannot grant access; draft edit invalidates approval; send without approval (409); double send (one provider call); 503 → `FAILED`; 504 → `UNKNOWN` + reconcile delivered/not_found; restart after attempt (no second send); automation refused after handoff; reconcile with nothing uncertain (409).

## Operator instructions

- **Uncertain send (`UNKNOWN`):** the provider may have accepted the message but did not confirm (504 or connection loss). Do not resend manually or re-approve to "try again" — that risks a duplicate. Click **Check delivery** (`reconcile`) to query the provider by the stored `clientRef`. If the provider confirms `delivered`, the ticket resolves to `SENT` without resending. If the result is `not_found`, delivery remains unconfirmed (inconclusive) — leave it `UNKNOWN` and escalate; do not treat it as proof of non-delivery. For a definite rejection (503, shown as `FAILED`), the message was not accepted and a new approved draft/version is required to retry.
- **After restart:** an in-flight attempt stays `PENDING`/`UNKNOWN` with its original `clientRef`; no second send occurs. Reconcile once the provider is reachable.
- **Takeover:** once "Take over" commits, automation dispatch is refused server-side; the human agent can still send a properly approved reply.

## Remaining risks and production plan

- Single local process and SQLite; no distributed locking or multi-instance coordination. For production, move to a managed DB with row-level locking and idempotency keys enforced at the DB layer.
- No real authentication/OAuth, audit signing, or rate limiting; fixture tokens only.
- No sophisticated retry scheduler; uncertain deliveries require operator reconciliation.
- No recall of messages dispatched before takeover.
- First checks for a real GHL pilot: verify webhook signature verification against GHL's scheme, confirm delivery status endpoint semantics (accepted vs. delivered), reconcile polling/backoff, idempotency key propagation, tenant isolation at the DB layer, observability (metrics/logs on UNKNOWN), rollback plan (disable automation, keep manual send).

## AI use and time

- Tools used: OpenCode agent (this session) for planning, code generation, review, and test authoring.
- Process: I first planned the solution in `SOLUTION.md`/`SOLUTION_ES.md` (decisions + open questions), then had OpenCode execute the implementation against that plan, and finally validated it with `npm test` and `verify-http.mjs` plus the manual restart/delay scenario.
- One suggestion accepted/changed: the agent initially proposed retrying on any provider error; I changed it to classify 503 as a definite failure (no retry) and 504/network as `UNKNOWN` requiring explicit reconciliation, per the contract. Verified by unit tests for both modes and the restart-during-delay integration check.
- Approximate time spent: ~2 hours.