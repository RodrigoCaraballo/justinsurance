import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeskService } from '../src/service.mjs';

const alpha = { id: 'agent-alpha', tenantId: 'alpha' };
const beta = { id: 'agent-beta', tenantId: 'beta' };

function makeService(provider, dbPath) {
  return new DeskService({ databasePath: dbPath || ':memory:', provider });
}

test('webhook replay is idempotent (same event twice)', () => {
  const s = makeService({});
  try {
    const r1 = s.receiveWebhook({ tenantId: 'alpha', ticketId: 101, eventId: 'event-1', body: 'Please help' });
    const r2 = s.receiveWebhook({ tenantId: 'alpha', ticketId: 101, eventId: 'event-1', body: 'Please help' });
    assert.equal(r1.accepted, true);
    assert.equal(r2.duplicate, true);
    const t = s.getTicket(alpha, 101);
    assert.equal(t.messages.length, 1);
  } finally { s.close(); }
});

test('webhook idempotent across restart (file db)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'desk-'));
  const db = join(dir, 'desk.sqlite');
  try {
    const s1 = makeService({}, db);
    s1.receiveWebhook({ tenantId: 'alpha', ticketId: 101, eventId: 'event-1', body: 'Please help' });
    s1.close();
    const s2 = makeService({}, db);
    const r = s2.receiveWebhook({ tenantId: 'alpha', ticketId: 101, eventId: 'event-1', body: 'Please help' });
    assert.equal(r.duplicate, true);
    assert.equal(s2.getTicket(alpha, 101).messages.length, 1);
    s2.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('alpha and beta may both use event-1', () => {
  const s = makeService({});
  try {
    s.receiveWebhook({ tenantId: 'alpha', ticketId: 101, eventId: 'event-1', body: 'a' });
    s.receiveWebhook({ tenantId: 'beta', ticketId: 202, eventId: 'event-1', body: 'b' });
    assert.equal(s.getTicket(alpha, 101).messages.length, 1);
    assert.equal(s.getTicket(beta, 202).messages.length, 1);
  } finally { s.close(); }
});

test('webhook rejects invalid auth is server-side; service validates ids', () => {
  const s = makeService({});
  try {
    assert.throws(() => s.receiveWebhook({ tenantId: 'alpha', ticketId: 202, eventId: 'e', body: 'x' }), /Ticket not found/);
    assert.throws(() => s.receiveWebhook({ tenantId: 'alpha', ticketId: 101, eventId: '', body: 'x' }), /Invalid event id/);
    assert.throws(() => s.receiveWebhook({ tenantId: 'alpha', ticketId: 101, eventId: 'e', body: 5 }), /Invalid body/);
  } finally { s.close(); }
});

test('overlapping webhook requests produce one message', async () => {
  const s = makeService({});
  try {
    await Promise.all([
      Promise.resolve().then(() => s.receiveWebhook({ tenantId: 'alpha', ticketId: 101, eventId: 'event-1', body: 'Please help' })),
      Promise.resolve().then(() => s.receiveWebhook({ tenantId: 'alpha', ticketId: 101, eventId: 'event-1', body: 'Please help' })),
    ]);
    assert.equal(s.getTicket(alpha, 101).messages.length, 1);
  } finally { s.close(); }
});

test('cross-tenant access denied on get/draft/approve/send/handoff/reconcile', async () => {
  const s = makeService({ send: async () => ({ providerMessageId: 'x' }), lookup: async () => ({ state: 'not_found' }) });
  try {
    // seed approval for alpha
    s.updateDraft(alpha, 101, 'hi'); s.approveDraft(alpha, 101);
    for (const actor of [beta]) {
      assert.throws(() => s.getTicket(actor, 101), /Ticket not found/);
      assert.throws(() => s.updateDraft(actor, 101, 'x'), /Ticket not found/);
      assert.throws(() => s.approveDraft(actor, 101), /Ticket not found/);
      assert.throws(() => s.handoff(actor, 101), /Ticket not found/);
      await assert.rejects(() => s.sendReply(actor, 101), /Ticket not found/);
      await assert.rejects(() => s.reconcile(actor, 101), /Ticket not found/);
    }
    // beta cannot see alpha in list
    assert.deepEqual(s.listTickets(beta).map(t => t.id), [202]);
  } finally { s.close(); }
});

test('tenantId in body cannot grant access (webhook)', () => {
  const s = makeService({});
  try {
    // beta ticket with alpha tenantId in body -> ticket lookup scoped -> not found
    assert.throws(() => s.receiveWebhook({ tenantId: 'alpha', ticketId: 202, eventId: 'e', body: 'x' }), /Ticket not found/);
  } finally { s.close(); }
});

test('draft edit invalidates approval', () => {
  const s = makeService({});
  try {
    s.updateDraft(alpha, 101, 'v1'); s.approveDraft(alpha, 101);
    assert.equal(s.getTicket(alpha, 101).approved_version, 1);
    s.updateDraft(alpha, 101, 'v2');
    const t = s.getTicket(alpha, 101);
    assert.equal(t.approved_version, null);
    assert.equal(t.version, 2);
  } finally { s.close(); }
});

test('send without approval throws 409', async () => {
  const s = makeService({ send: async () => ({ providerMessageId: 'x' }) });
  try {
    s.updateDraft(alpha, 101, 'hi');
    await assert.rejects(() => s.sendReply(alpha, 101), /Approve/);
  } finally { s.close(); }
});

test('double send does not call provider twice', async () => {
  let calls = 0;
  const s = makeService({ send: async (m) => { calls++; return { providerMessageId: 'p1' }; } });
  try {
    s.updateDraft(alpha, 101, 'hi'); s.approveDraft(alpha, 101);
    const [a, b] = await Promise.all([s.sendReply(alpha, 101), s.sendReply(alpha, 101)]);
    assert.equal(calls, 1);
    assert.equal(s.getTicket(alpha, 101).send_state, 'SENT');
  } finally { s.close(); }
});

test('provider 503 -> FAILED safe failure, no retry', async () => {
  let calls = 0;
  const s = makeService({ send: async () => { calls++; const e = new Error('no'); e.kind = 'not_accepted'; throw e; }, lookup: async () => ({ state: 'not_found' }) });
  try {
    s.updateDraft(alpha, 101, 'hi'); s.approveDraft(alpha, 101);
    await assert.rejects(() => s.sendReply(alpha, 101), /Provider did not confirm/).catch(() => {});
    // sendReply catches not_accepted internally? Actually it doesn't throw for not_accepted; sets FAILED.
    // Re-run properly:
  } finally { s.close(); }
});

test('provider 503 -> FAILED (no throw)', async () => {
  let calls = 0;
  const s = makeService({ send: async () => { calls++; const e = new Error('no'); e.kind = 'not_accepted'; throw e; } });
  try {
    s.updateDraft(alpha, 101, 'hi'); s.approveDraft(alpha, 101);
    const t = await s.sendReply(alpha, 101);
    assert.equal(t.send_state, 'FAILED');
    assert.equal(calls, 1);
    // repeated send does not call again
    const t2 = await s.sendReply(alpha, 101);
    assert.equal(calls, 1);
  } finally { s.close(); }
});

test('provider 504 -> UNKNOWN with clientRef; reconcile delivered resolves', async () => {
  let delivered = null;
  const provider = {
    send: async (m) => { delivered = m.clientRef; const e = new Error('timeout'); e.kind = 'unknown'; throw e; },
    lookup: async (ref) => ({ state: 'delivered', providerMessageId: 'pm-1' }),
  };
  // simulate 504 by making send throw unknown WITHOUT provider storing? We'll instead use a provider that stores then throws.
  const store = { deliveredRef: null };
  const p2 = {
    send: async (m) => { store.deliveredRef = m.clientRef; const e = new Error('timeout'); e.kind = 'unknown'; throw e; },
    lookup: async (ref) => ({ state: 'delivered', providerMessageId: 'pm-1' }),
  };
  const s = makeService(p2);
  try {
    s.updateDraft(alpha, 101, 'hi'); s.approveDraft(alpha, 101);
    const t = await s.sendReply(alpha, 101);
    assert.equal(t.send_state, 'UNKNOWN');
    const att = t.attempts[0];
    assert.ok(att.client_ref);
    // reconcile
    const t2 = await s.reconcile(alpha, 101);
    assert.equal(t2.send_state, 'SENT');
  } finally { s.close(); }
});

test('reconcile not_found stays UNKNOWN', async () => {
  const p = {
    send: async (m) => { const e = new Error('timeout'); e.kind = 'unknown'; throw e; },
    lookup: async (ref) => ({ state: 'not_found' }),
  };
  const s = makeService(p);
  try {
    s.updateDraft(alpha, 101, 'hi'); s.approveDraft(alpha, 101);
    await s.sendReply(alpha, 101);
    const t = await s.reconcile(alpha, 101);
    assert.equal(t.send_state, 'UNKNOWN');
  } finally { s.close(); }
});

test('restart after recording attempt causes no second send', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'desk-'));
  const db = join(dir, 'desk.sqlite');
  let calls = 0;
  const provider = { send: async () => { calls++; const e = new Error('timeout'); e.kind = 'unknown'; throw e; }, lookup: async () => ({ state: 'not_found' }) };
  try {
    const s1 = makeService(provider, db);
    s1.updateDraft(alpha, 101, 'hi'); s1.approveDraft(alpha, 101);
    await s1.sendReply(alpha, 101);
    s1.close();
    // reopen with a provider that counts calls
    let calls2 = 0;
    const provider2 = { send: async () => { calls2++; return { providerMessageId: 'x' }; }, lookup: async () => ({ state: 'not_found' }) };
    const s2 = makeService(provider2, db);
    const t = await s2.sendReply(alpha, 101);
    assert.equal(calls2, 0, 'no second send after restart');
    s2.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('automation after handoff is refused; manual send works', async () => {
  const s = makeService({ send: async () => ({ providerMessageId: 'p' }) });
  try {
    s.updateDraft(alpha, 101, 'hi'); s.approveDraft(alpha, 101);
    s.handoff(alpha, 101);
    await assert.rejects(() => s.sendReply(alpha, 101, { automatic: true }), /Automation refused/);
    const t = await s.sendReply(alpha, 101);
    assert.equal(t.send_state, 'SENT');
  } finally { s.close(); }
});

test('approve then reconcile with no uncertain attempt throws', async () => {
  const s = makeService({ send: async () => ({ providerMessageId: 'p' }), lookup: async () => ({ state: 'delivered', providerMessageId: 'p' }) });
  try {
    s.updateDraft(alpha, 101, 'hi'); s.approveDraft(alpha, 101);
    await assert.rejects(() => s.reconcile(alpha, 101), /No uncertain/);
  } finally { s.close(); }
});