# Verification protocol

## 0. Prerequisites
- Node.js 24+ (`node --version`).
- Clean checkout; no `data/` directory (remove it if present from prior runs).

## 1. Automated unit tests
```sh
npm test
```
Expected: all tests pass (baseline + solution tests). Current result: 19/19.

## 2. Start services
Terminal A:
```sh
npm run provider
```
Terminal B:
```sh
npm start
```
Wait for both "listening" messages. Port 4300 (app), 4301 (provider).

## 3. HTTP end-to-end verification
Terminal C:
```sh
node verify-http.mjs
```
Expected: `Result: N passed, 0 failed`. Covers:
- Webhook accept + replay dedup + invalid secret + cross-tenant body.
- Cross-tenant GET denied.
- Draft + exact approval (approve, edit invalidates, re-approve).
- Send approved reply succeeds; double send keeps SENT.
- 504 → UNKNOWN + clientRef; reconcile → SENT.
- 503 → FAILED.
- Handoff blocks automation (409); manual send still works.

## 4. Manual restart-recovery verification (delay)
1. Ensure services running (normal mode).
2. Reset data for a clean run (stop both processes first):
   ```sh
   # stop processes, then:
   rm -rf data
   ```
3. Start provider + app again.
4. Create + approve a draft:
   ```sh
   curl -X POST http://127.0.0.1:4300/api/tickets/101/draft -H 'Authorization: Bearer demo-alpha-token' -H 'Content-Type: application/json' -d '{"body":"delay test"}'
   curl -X POST http://127.0.0.1:4300/api/tickets/101/approve -H 'Authorization: Bearer demo-alpha-token' -H 'Content-Type: application/json' -d '{}'
   ```
5. Set provider to delay mode:
   ```sh
   curl -X POST http://127.0.0.1:4301/control -H 'Content-Type: application/json' -d '{"mode":"accept_then_delay"}'
   ```
6. Start send (will hang 10s):
   ```sh
   curl -X POST http://127.0.0.1:4300/api/tickets/101/send -H 'Authorization: Bearer demo-alpha-token' -H 'Content-Type: application/json' -d '{}'
   ```
   Kill the app process (Ctrl+C in Terminal B) within the 10s window.
7. Wait 10s for provider to finish. Check deliveries:
   ```sh
   curl http://127.0.0.1:4301/deliveries
   ```
   Expected: 1 delivery.
8. Restart app (Terminal B: `npm start`).
9. Check ticket:
   ```sh
   curl http://127.0.0.1:4300/api/tickets/101 -H 'Authorization: Bearer demo-alpha-token'
   ```
   Expected: `send_state` = `PENDING`, one attempt with `state: PENDING`.
10. Call send again:
    ```sh
    curl -X POST http://127.0.0.1:4300/api/tickets/101/send -H 'Authorization: Bearer demo-alpha-token' -H 'Content-Type: application/json' -d '{}'
    ```
    Expected: no new delivery (`GET /deliveries` count still 1).
11. Reconcile:
    ```sh
    curl -X POST http://127.0.0.1:4300/api/tickets/101/reconcile -H 'Authorization: Bearer demo-alpha-token' -H 'Content-Type: application/json' -d '{}'
    ```
    Expected: `send_state` = `SENT`.

## 5. UI verification (manual)
1. Open `http://127.0.0.1:4300`.
2. Sign in as Alpha, select ticket 101.
3. Verify conversation, owner, draft/approval, delivery status, audit trail render.
4. Use "Use suggested reply" → "Save draft" → "Approve saved draft" → "Send manually".
5. Trigger a 504 (provider mode accept_then_timeout) and confirm UI shows `UNKNOWN` delivery state and "Check delivery" resolves it.
6. Confirm customer text is rendered as text (no HTML execution) — inspect that `<script>` in a message body is shown literally.

## 6. Final checklist
- [ ] `npm test` all green.
- [ ] `node verify-http.mjs` all green.
- [ ] Restart-during-delay scenario leaves 1 delivery and no second send.
- [ ] Cross-tenant access returns 403/404 on all routes.
- [ ] No `data/` committed; `.gitignore` excludes it.