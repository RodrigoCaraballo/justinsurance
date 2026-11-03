import { randomUUID } from 'node:crypto';
import { openStore, record, ticketView, DeskError } from './store.mjs';

export class DeskService {
  constructor({ databasePath = ':memory:', provider }) {
    this.db = openStore(databasePath);
    this.provider = provider;
  }
  close() { this.db.close(); }

  _tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); this.db.exec('COMMIT'); return r; }
    catch (e) { try { this.db.exec('ROLLBACK'); } catch {} throw e; }
  }

  listTickets(actor) {
    return this.db.prepare('SELECT * FROM tickets WHERE tenant_id = ? ORDER BY id').all(actor.tenantId);
  }

  row(actor, id) {
    const row = this.db.prepare('SELECT * FROM tickets WHERE id = ? AND tenant_id = ?').get(id, actor.tenantId);
    if (!row) throw new DeskError(404, 'Ticket not found');
    return row;
  }

  getTicket(actor, id) { return ticketView(this.db, this.row(actor, id)); }

  receiveWebhook(event) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) throw new DeskError(400, 'Invalid event');
    const tenantId = event.tenantId;
    const ticketId = event.ticketId;
    const eventId = event.eventId;
    const body = event.body;
    if (typeof tenantId !== 'string' || !tenantId.trim()) throw new DeskError(400, 'Invalid tenant');
    if (typeof ticketId !== 'number' || !Number.isInteger(ticketId)) throw new DeskError(400, 'Invalid ticket');
    if (typeof eventId !== 'string' || !eventId.trim()) throw new DeskError(400, 'Invalid event id');
    if (typeof body !== 'string') throw new DeskError(400, 'Invalid body');

    const t = this.db.prepare('SELECT * FROM tickets WHERE id = ? AND tenant_id = ?').get(ticketId, tenantId);
    if (!t) throw new DeskError(404, 'Ticket not found');

    // Idempotent, atomic write + business change.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db.prepare('SELECT * FROM processed_events WHERE tenant_id = ? AND event_id = ?').get(tenantId, eventId);
      if (existing) {
        this.db.exec('ROLLBACK');
        return { accepted: true, duplicate: true };
      }
      this.db.prepare('INSERT INTO processed_events(tenant_id, event_id, ticket_id, body) VALUES (?, ?, ?, ?)')
        .run(tenantId, eventId, t.id, body);
      this.db.prepare('INSERT INTO messages(ticket_id, event_id, body) VALUES (?, ?, ?)')
        .run(t.id, eventId, body);
      record(this.db, t.id, 'inbound', eventId);
      this.db.exec('COMMIT');
      return { accepted: true };
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch {}
      const msg = String(e?.message || e);
      if (msg.includes('CONSTRAINT') || msg.includes('UNIQUE')) {
        return { accepted: true, duplicate: true };
      }
      throw e;
    }
  }

  updateDraft(actor, id, body) {
    const t = this.row(actor, id);
    if (typeof body !== 'string' || !body.trim()) throw new DeskError(400, 'A reply is required');
    this._tx(() => {
      this.db.prepare("UPDATE tickets SET draft = ?, version = version + 1, approved_version = NULL, send_state = 'DRAFT' WHERE id = ?")
        .run(body, id);
      record(this.db, id, 'draft_updated', actor.id);
    });
    return this.getTicket(actor, id);
  }

  approveDraft(actor, id) {
    const t = this.row(actor, id);
    if (!t.draft || !t.draft.trim()) throw new DeskError(400, 'No draft');
    this._tx(() => {
      this.db.prepare('UPDATE tickets SET approved_version = version WHERE id = ?').run(id);
      record(this.db, id, 'approved', actor.id);
    });
    return this.getTicket(actor, id);
  }

  handoff(actor, id) {
    this.row(actor, id);
    this._tx(() => {
      this.db.prepare("UPDATE tickets SET owner = 'human' WHERE id = ?").run(id);
      record(this.db, id, 'human_handoff', actor.id);
    });
    return this.getTicket(actor, id);
  }

  async sendReply(actor, id, { automatic = false } = {}) {
    const t = this.row(actor, id);
    if (automatic && t.owner === 'human') {
      throw new DeskError(409, 'Automation refused after human takeover');
    }
    if (t.approved_version == null || t.approved_version !== t.version) {
      throw new DeskError(409, 'Approve the reply first');
    }

    const clientRef = randomUUID();

    // Create an attempt if none exists for this approved version.
    let created = false;
    try {
      this.db.exec('BEGIN IMMEDIATE');
      const existing = this.db.prepare('SELECT * FROM attempts WHERE ticket_id = ? AND version = ?').get(id, t.version);
      if (existing) {
        this.db.exec('ROLLBACK');
      } else {
        this.db.prepare('INSERT INTO attempts(ticket_id, version, client_ref, body, state) VALUES (?, ?, ?, ?, ?)')
          .run(id, t.version, clientRef, t.draft, 'PENDING');
        this.db.prepare("UPDATE tickets SET send_state = 'PENDING' WHERE id = ?").run(id);
        this.db.exec('COMMIT');
        created = true;
      }
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch {}
      const msg = String(e?.message || e);
      if (!(msg.includes('CONSTRAINT') || msg.includes('UNIQUE'))) throw e;
      // constraint violation -> someone else created it
    }

    const attempt = this.db.prepare('SELECT * FROM attempts WHERE ticket_id = ? AND version = ?').get(id, t.version);
    if (!attempt) throw new DeskError(500, 'Failed to record attempt');

    // If we did not create this attempt, do not call the provider.
    if (!created || attempt.client_ref !== clientRef) {
      return this.getTicket(actor, id);
    }

    // Call the provider (outside transaction).
    let newState = 'UNKNOWN';
    let providerId = null;
    let outcome = 'unknown';
    try {
      const result = await this.provider.send({ clientRef: attempt.client_ref, ticketId: id, body: attempt.body });
      providerId = result?.providerMessageId ?? null;
      newState = 'SENT';
      outcome = 'sent';
    } catch (error) {
      if (error && error.kind === 'not_accepted') {
        newState = 'FAILED';
        outcome = 'failed';
      } else {
        newState = 'UNKNOWN';
        outcome = 'unknown';
      }
    }

    this._tx(() => {
      this.db.prepare('UPDATE attempts SET state = ?, provider_id = ? WHERE client_ref = ?')
        .run(newState, providerId, attempt.client_ref);
      this.db.prepare('UPDATE tickets SET send_state = ? WHERE id = ?')
        .run(newState === 'SENT' ? 'SENT' : newState, id);
      const auditAction = outcome === 'sent' ? 'sent'
        : (outcome === 'failed' ? 'delivery_failed' : 'delivery_unknown');
      record(this.db, id, auditAction, `${automatic ? 'automation' : actor.id}: ${providerId ?? 'n/a'}`);
    });

    return this.getTicket(actor, id);
  }

  async reconcile(actor, id) {
    const t = this.row(actor, id);
    const attempt = this.db.prepare("SELECT * FROM attempts WHERE ticket_id = ? AND state IN ('PENDING','UNKNOWN') ORDER BY id DESC LIMIT 1").get(id);
    if (!attempt || !['PENDING', 'UNKNOWN'].includes(attempt.state)) {
      throw new DeskError(409, 'No uncertain delivery to reconcile');
    }

    let lookupResult;
    try {
      lookupResult = await this.provider.lookup(attempt.client_ref);
    } catch (e) {
      this._tx(() => record(this.db, id, 'reconcile_failed', actor.id));
      throw new DeskError(502, 'Lookup unavailable');
    }

    if (lookupResult && lookupResult.state === 'delivered') {
      this._tx(() => {
        this.db.prepare('UPDATE attempts SET state = ?, provider_id = ? WHERE client_ref = ?')
          .run('DELIVERED', lookupResult.providerMessageId ?? attempt.provider_id, attempt.client_ref);
        this.db.prepare("UPDATE tickets SET send_state = 'SENT' WHERE id = ?").run(id);
        record(this.db, id, 'reconciled_delivered', actor.id);
      });
    } else {
      this._tx(() => record(this.db, id, 'reconcile_inconclusive', actor.id));
    }
    return this.getTicket(actor, id);
  }
}