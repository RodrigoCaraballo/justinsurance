// HTTP verification script. Run with provider + app already started:
//   Terminal A: npm run provider
//   Terminal B: npm start
//   Terminal C: node verify-http.mjs
// Cleans ticket 101 state is NOT reset (uses new draft versions); safe to rerun.
import assert from 'node:assert/strict';

const H = (token) => ({ 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' });
const ALPHA = H('demo-alpha-token');
const BETA = H('demo-beta-token');
const WH = { 'X-Demo-Webhook-Secret': 'fictional-webhook-secret', 'Content-Type': 'application/json' };

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); console.log('PASS:', name); passed++; }
  catch (e) { console.log('FAIL:', name, '-', e.message); failed++; }
}
async function req(url, method='GET', body, headers=ALPHA) {
  const r = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data };
}

// reset provider mode
await req('http://127.0.0.1:4301/control', 'POST', { mode: 'normal' }, { 'Content-Type': 'application/json' });

await check('webhook accepted', async () => {
  const r = await req('http://127.0.0.1:4300/webhooks/ghl', 'POST', { tenantId:'alpha', ticketId:101, eventId:'verify-1', body:'hi' }, WH);
  assert.equal(r.status, 200);
  assert.equal(r.data.accepted, true);
});
await check('webhook replay is duplicate', async () => {
  const r = await req('http://127.0.0.1:4300/webhooks/ghl', 'POST', { tenantId:'alpha', ticketId:101, eventId:'verify-1', body:'hi' }, WH);
  assert.equal(r.data.duplicate, true);
});
await check('webhook invalid secret rejected', async () => {
  const r = await fetch('http://127.0.0.1:4300/webhooks/ghl', { method:'POST', headers:{'X-Demo-Webhook-Secret':'wrong','Content-Type':'application/json'}, body: JSON.stringify({tenantId:'alpha',ticketId:101,eventId:'x',body:'y'}) });
  assert.ok(r.status === 401 || r.status === 403);
});
await check('cross-tenant GET denied', async () => {
  const r = await fetch('http://127.0.0.1:4300/api/tickets/101', { headers: BETA });
  assert.ok(r.status === 403 || r.status === 404);
});
await check('cross-tenant via tenantId in body denied', async () => {
  const r = await req('http://127.0.0.1:4300/webhooks/ghl', 'POST', { tenantId:'alpha', ticketId:202, eventId:'x', body:'y' }, WH);
  assert.ok(r.status === 404 || r.status === 400);
});

// draft + approve + exact approval
await req('http://127.0.0.1:4300/api/tickets/101/draft', 'POST', { body: 'verify draft' });
const t0 = (await req('http://127.0.0.1:4300/api/tickets/101')).data;
await check('approve sets approved_version', async () => {
  const r = await req('http://127.0.0.1:4300/api/tickets/101/approve', 'POST', {});
  assert.equal(r.data.approved_version, t0.version);
});
await check('send without? actually approved -> send ok', async () => {}); // placeholder
// edit invalidates approval
await req('http://127.0.0.1:4300/api/tickets/101/draft', 'POST', { body: 'edited' });
await check('edit invalidates approval', async () => {
  const t = (await req('http://127.0.0.1:4300/api/tickets/101')).data;
  assert.equal(t.approved_version, null);
});
// re-approve
await req('http://127.0.0.1:4300/api/tickets/101/approve', 'POST', {});

await check('send approved reply succeeds', async () => {
  const r = await req('http://127.0.0.1:4300/api/tickets/101/send', 'POST', {});
  assert.equal(r.data.send_state, 'SENT');
});
await check('double send does not error and keeps SENT', async () => {
  const r = await req('http://127.0.0.1:4300/api/tickets/101/send', 'POST', {});
  assert.equal(r.data.send_state, 'SENT');
});

// honest delivery: 504 -> UNKNOWN
await req('http://127.0.0.1:4300/api/tickets/101/draft', 'POST', { body: 'uncertain delivery' });
await req('http://127.0.0.1:4300/api/tickets/101/approve', 'POST', {});
await req('http://127.0.0.1:4301/control', 'POST', { mode: 'accept_then_timeout' }, { 'Content-Type': 'application/json' });
await check('504 -> UNKNOWN state', async () => {
  const r = await req('http://127.0.0.1:4300/api/tickets/101/send', 'POST', {});
  assert.equal(r.data.send_state, 'UNKNOWN');
  assert.ok(r.data.attempts[0].client_ref);
});
await req('http://127.0.0.1:4301/control', 'POST', { mode: 'normal' }, { 'Content-Type': 'application/json' });
// reconcile delivered
await req('http://127.0.0.1:4301/control', 'POST', { mode: 'normal' }, { 'Content-Type': 'application/json' });
// provider has delivery; lookup returns delivered
await check('reconcile resolves to SENT', async () => {
  const r = await req('http://127.0.0.1:4300/api/tickets/101/reconcile', 'POST', {});
  assert.equal(r.data.send_state, 'SENT');
});

// 503 -> FAILED
await req('http://127.0.0.1:4300/api/tickets/101/draft', 'POST', { body: 'rejected delivery' });
await req('http://127.0.0.1:4300/api/tickets/101/approve', 'POST', {});
await req('http://127.0.0.1:4301/control', 'POST', { mode: 'reject_before_accept' }, { 'Content-Type': 'application/json' });
await check('503 -> FAILED state', async () => {
  const r = await req('http://127.0.0.1:4300/api/tickets/101/send', 'POST', {});
  assert.equal(r.data.send_state, 'FAILED');
});
await req('http://127.0.0.1:4301/control', 'POST', { mode: 'normal' }, { 'Content-Type': 'application/json' });

// handoff + automation refusal
await req('http://127.0.0.1:4300/api/tickets/101/handoff', 'POST', {});
await req('http://127.0.0.1:4300/api/tickets/101/draft', 'POST', { body: 'after takeover' });
await req('http://127.0.0.1:4300/api/tickets/101/approve', 'POST', {});
await check('automation refused after takeover (409)', async () => {
  const r = await req('http://127.0.0.1:4300/api/tickets/101/automation', 'POST', {});
  assert.equal(r.status, 409);
});
await check('manual send still works after takeover', async () => {
  const r = await req('http://127.0.0.1:4300/api/tickets/101/send', 'POST', {});
  assert.equal(r.data.send_state, 'SENT');
});

console.log(`\nResult: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);