# SOLUTION_ES.md — Solución planificada (Español)

> Solución planificada para el work sample del support desk de JustInsurance. Las decisiones provienen de las respuestas del candidato y se aplican de forma coherente a todos los requisitos. Este documento es el plano que se ejecutará.

## 0. Overview (README + CONTRACT)

### Lo que pide el README
- Objetivo: hacer usable y seguro un flujo de soporte (inbox conectado a un CRM mock tipo GHL).
- Tiempo: hasta 3h de implementación + 45min de walkthrough. Node 24+, SQLite integrado, sin dependencias npm.
- Arranque: Terminal A `npm run provider`, Terminal B `npm start`, Terminal C `npm run event` (dos veces), `npm test`.
- Entregables: código + tests, `HANDOFF.md` (≤2 páginas), nota de uso de IA, tiempo aproximado. Excluir `data/`, secretos, deps.
- Seis comportamientos requeridos: (1) entrega inbound segura/idempotente; (2) aislamiento por tenant; (3) aprobación exacta; (4) entrega honesta + recuperación; (5) toma de control humana; (6) handoff usable.
- No requerido: CRM completo, OAuth real, auth de producción, LLM real, SCORM, etc.

### Lo que fija el CONTRACT
- Puertos: app 4300, provider 4301. Identidades: `demo-alpha-token`→alpha/ticket 101; `demo-beta-token`→beta/ticket 202; webhook secret `fictional-webhook-secret`.
- Rutas HTTP públicas (preservar). Semántica del provider: 503 = definitivamente no aceptado; 504 = desconocido; pérdida de conexión = desconocido; lookup `not_found` = inconcluso.
- `DeskService` con `listTickets, getTicket, receiveWebhook, updateDraft, approveDraft, handoff, sendReply, reconcile, close`, acepta `{databasePath, provider}`.
- Provider: `send(payload)` asíncrono (puede lanzar con `kind:'not_accepted'` u otro = incierto), `lookup(clientRef)`.
- Persistencia en SQLite `data/`; restart debe conservar estado.

### Defectos intencionales del starter
- `row()` no filtra por tenant → acceso cross-tenant.
- `receiveWebhook()` no es idempotente (sin tabla de eventos procesados).
- `updateDraft()` no invalida la aprobación de forma exacta.
- `sendReply()` reintenta, usa clientRef nuevo, marca SENT sin evidencia, no maneja 504/unknown, no chequea takeover.
- `reconcile()` no implementado.
- UI sin estado UNKNOWN explícito.

---

## 1. Entrega inbound segura (idempotencia del webhook)

**Resumen de decisiones:** idempotencia por `(tenant_id, event_id)` con escritura optimista/versionada; un replay se ignora; se validan auth e IDs server-side; la escritura y su cambio de negocio tienen éxito o fallan juntos en una transacción.

- **Q1.1 — Modelo de idempotencia:** tabla `processed_events` con PK `(tenant_id, event_id)`. Columnas: `tenant_id TEXT`, `event_id TEXT`, `ticket_id INTEGER`, `body TEXT`, `processed_at TEXT`. La PK garantiza unicidad por organización (Alpha y Beta pueden tener ambos `event-1`).
- **Q1.2 — Transacción / concurrencia:** una transacción SQLite envuelve `INSERT processed_events` + `INSERT messages` + `INSERT audit`. Usar `BEGIN IMMEDIATE` (exclusivo) para serializar escritores; `busy_timeout` ya es 3000ms. El control de versión optimista es una guarda *adicional* (chequeo de versión de ticket), pero la restricción unique de eventos procesados es la clave de idempotencia autoritativa. Ante violación de restricción → tratar como replay → devolver `{accepted:true, duplicate:true}` sin re-aplicar.
- **Q1.3 — Mismo evento, body distinto:** se ignora (idempotente). El primer body gana; los replays posteriores devuelven el resultado duplicado y no sobrescriben mensaje ni auditoría.
- **Q1.4 — Auth del webhook + IDs:** validar `X-Demo-Webhook-Secret`; si no coincide → 401. Validar `tenantId`, `ticketId`, `eventId`, `body` server-side: el tenant debe coincidir con un ticket existente (`tickets.id = ticketId AND tenant_id = tenantId`); `eventId` string no vacío; `body` string. IDs cross-tenant o no coincidentes → 400/404. Nunca confiar en un tenant provisto por el cliente para autorizar más allá de esta validación; el lookup de ticket está acotado.
- **Q1.5 — Replay tras restart:** `processed_events` persiste en SQLite, por lo que un restart no pierde idempotencia. La PK unique sobrevive a los restarts.
- **Q1.6 — Requests solapadas:** `BEGIN IMMEDIATE` + restricción unique + captura de `SQLITE_CONSTRAINT` → éxito idempotente. El control de versión optimista (version del ticket) se usa donde hay mutación de ticket; para mensajes inbound la PK del evento es la guarda.

---

## 2. Aislamiento de clientes

**Resumen de decisiones:** la identidad server-side es autoritativa; `row()` filtra por tenant; cualquier `tenantId` provisto se valida y se rechaza si difiere; todas las lecturas/escrituras por ticket pasan por `row()` filtrado.

- **Q2.1 — `row(actor, id)`:** `SELECT * FROM tickets WHERE id = ? AND tenant_id = ?`; si no hay → `DeskError(404, 'Ticket not found')`. Sin fuga de tenant.
- **Q2.2 — Todas las operaciones por `row()`:** `getTicket`, `updateDraft`, `approveDraft`, `handoff`, `sendReply`, `reconcile` llaman al `row()` filtrado. `listTickets` ya filtra por `actor.tenantId`.
- **Q2.3 — `tenantId` provisto:** se ignora para autorización; si está presente en un webhook debe coincidir con el tenant del ticket o se rechaza (400/404). Un tenant provisto por el navegador nunca otorga acceso.
- **Q2.4 — Mensajes/auditoría/intentos:** se leen vía `ticketView` solo después de que `row()` valida la pertenencia; nunca se consultan por id crudo sin chequeo de tenant.
- **Q2.5 — Tests cross-tenant:** alpha → ticket 202 y beta → ticket 101 deben devolver 403/404 en GET, draft, approve, send, automation, handoff, reconcile y acceso a auditoría.

---

## 3. Aprobación exacta

**Resumen de decisiones:** draft versionado + `approved_version`; editar incrementa versión y limpia aprobación; enviar requiere `approved_version === version`; el envío repetido/solapado se deduplica por el unique `(ticket_id, version)` en attempts.

- **Q3.1 — Modelo:** `draft TEXT`, `version INTEGER`, `approved_version INTEGER NULL`. `updateDraft` setea `draft`, `version = version + 1`, `approved_version = NULL`, `send_state = 'DRAFT'`. `approveDraft` setea `approved_version = version` solo si hay un draft no vacío.
- **Q3.2 — Guarda de envío:** `sendReply` requiere `approved_version IS NOT NULL AND approved_version === version`. El body enviado es el `draft` actual (que no pudo cambiar sin incrementar versión y limpiar aprobación). Si no está aprobado → 409.
- **Q3.3 — Dedup de envío:** attempts tiene `UNIQUE(ticket_id, version)`. Antes de enviar, verificar si ya existe un attempt para `(ticket, version)`; si existe, devolver su estado actual sin llamar al provider ni crear un nuevo attempt. Clicks repetidos/requests solapadas reusan el mismo attempt.
- **Q3.4 — Estado post-envío:** tras entrega confirmada → `send_state = 'SENT'`. Se mantiene `approved_version` (registra lo que se aprobó/envió).
- **Q3.5 — Re-edición tras envío:** `updateDraft` resetea `send_state = 'DRAFT'` y limpia `approved_version`, iniciando un nuevo ciclo.

---

## 4. Entrega honesta y recuperación

**Resumen de decisiones:** persistir un attempt (con clientRef estable) antes de llamar al provider; clasificar 503 como falla segura, 504/red como UNKNOWN; nunca reintentar automáticamente; reconciliar vía lookup sin reenviar; seguro ante restart por el attempt persistido.

- **Q4.1 — Attempt primero:** `sendReply` crea un attempt (`state = 'PENDING'`, `clientRef = randomUUID()` nuevo) en una transacción *antes* de llamar a `provider.send`. Es el registro duradero de intención.
- **Q4.2 — 503 (not_accepted):** marcar attempt `FAILED` (falla segura), `send_state = 'FAILED'`, audit `delivery_failed`. Sin retry. Devolver ticket.
- **Q4.3 — 504 / red (unknown):** marcar attempt `UNKNOWN`, guardar `clientRef` (y `providerMessageId` si vino), `send_state = 'UNKNOWN'`, audit `delivery_unknown`. No reenviar. Devolver ticket.
- **Q4.4 — 200 (aceptado):** marcar attempt `DELIVERED` con `providerMessageId`, `send_state = 'SENT'`, audit `sent`.
- **Q4.5 — Seguridad ante restart:** el attempt persiste con su clientRef. `sendReply` verifica primero si hay un attempt existente para `(ticket, version)`; si existe, devuelve el estado actual sin crear un nuevo attempt ni llamar al provider. Un restart tras registrar un attempt no causa un segundo envío.
- **Q4.6 — `reconcile`:** cargar el último attempt. Si `state === 'UNKNOWN'` (o PENDING): llamar a `provider.lookup(clientRef)`.
  - `delivered` → setear attempt `DELIVERED` + `providerMessageId`, `send_state = 'SENT'`, audit `reconciled_delivered`.
  - `not_found` → inconcluso: mantener `UNKNOWN`, audit `reconcile_inconclusive`. No autorizar retry.
  - lookup lanza → audit `reconcile_failed`, devolver error; estado sin cambios.
  - Si no hay attempt incierto → 409/400 "nothing to reconcile".
- **Q4.7 — `accept_then_delay` (10s):** permite kill/restart durante el envío; el attempt ya está persistido (PENDING/UNKNOWN según resultado), por lo que el restart lo deja recuperable; reconciliar después.
- **Q4.8 — Reconcile idempotente:** llamadas repetidas solo consultan al provider; nunca reenvían. Si ya está DELIVERED, devuelve el estado actual.
- **Q4.9 — Estabilidad de clientRef:** un clientRef por attempt, persistido. Un nuevo attempt (nueva versión aprobada) obtiene un clientRef nuevo. Sin reutilización ciega entre versiones.

---

## 5. Toma de control humana

**Resumen de decisiones:** `handoff` setea owner a `human` y audita; el dispatch de automatización se rechaza server-side tras la toma de control; el envío manual aprobado sigue permitido.

- **Q5.1 — `handoff`:** `owner = 'human'`, audit `human_handoff`. No invalida draft/aprobación (el operador puede enviar una respuesta aprobada).
- **Q5.2 — Automatización rechazada:** `sendReply(..., {automatic:true})` chequea `owner === 'human'` → `DeskError(409, 'Automation refused after human takeover')`. Aplicado en código server-side, no en UI.
- **Q5.3 — Envío manual tras toma de control:** permitido si hay aprobación válida (`approved_version === version`).
- **Q5.4 — Automatización en vuelo:** si la toma de control se comprometió antes del dispatch, se rechaza el dispatch; un mensaje ya despachado antes de la toma no se recuerda (fuera de alcance). Concurrencia: el chequeo de owner ocurre en el momento del envío real dentro de la transacción.

---

## 6. Handoff usable (UI)

- **Q6.1 — Mostrar:** conversación, owner, draft/aprobación actual, estado de entrega, audit trail, attempts. Ya parcialmente presente; extender para mostrar UNKNOWN y próxima acción segura.
- **Q6.2 — Renderizado seguro:** texto del cliente vía `textContent` (ya). Nunca `innerHTML`. Auditoría/mensajes como texto.
- **Q6.3 — Estado UNKNOWN + próxima acción:** mostrar estado de entrega `UNKNOWN` y habilitar "Check delivery" (reconcile). Deshabilitar Send si no está aprobado o si existe un attempt UNKNOWN.
- **Q6.4 — Refresh/errores:** refrescar ticket tras cada acción; mostrar errores en `#notice`.
- **Q6.5 — XSS:** mantener todo texto no confiable como nodos de texto; sin inyección HTML en el render de auditoría.

---

## 7. Arquitectura / concurrencia / persistencia

- **Q7.1 — Transacciones:** `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK` manuales vía `db.exec` alrededor de escrituras multi-sentencia (webhook, send, reconcile). Sentencias únicas quedan en autocommit.
- **Q7.2 — Concurrencia:** SQLite `busy_timeout = 3000ms` + transacciones cortas + `BEGIN IMMEDIATE` serializa escritores. El bloqueo lógico por ticket se aproxima con la transacción; aceptable para el alcance de un solo proceso.
- **Q7.3 — Migración de esquema:** `CREATE TABLE IF NOT EXISTS` idempotente + `ALTER TABLE` guardado (try/catch) para columnas nuevas (`approved_version` ya existe; agregar `processed_events`, asegurar columnas de `attempts`). Mantener seed con `INSERT OR IGNORE`.
- **Q7.4 — `close()`:** cierra la db; los tests usan `:memory:`.
- **Q7.5 — `DeskError`:** mantener errores con status; el server los mapea a HTTP.

### Adiciones al esquema

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

`attempts` ya tiene `UNIQUE(ticket_id, version)` y `client_ref TEXT NOT NULL UNIQUE`. Valores de `state`: `PENDING`, `DELIVERED`, `FAILED`, `UNKNOWN`. Columna `created_at` opcional (no requerida).

---

## 8. Tests a agregar

- Replay de webhook dos veces (mismo evento) → un mensaje, una auditoría; el segundo devuelve duplicado.
- Replay de webhook tras restart (nuevo DeskService sobre la misma db) → sigue un mensaje.
- Requests de webhook solapadas → un mensaje.
- Cross-tenant alpha/beta en todas las rutas → 403/404.
- `tenantId` en el body no puede otorgar acceso.
- Editar draft invalida aprobación (`approved_version` pasa a null).
- Enviar sin aprobación → 409.
- Envío doble (click repetido / solapado) → una sola llamada al provider.
- Provider 503 → FAILED, sin retry.
- Provider 504 → UNKNOWN + clientRef; reconcile delivered → SENT.
- Provider `not_found` en reconcile → sigue UNKNOWN.
- Restart tras registrar attempt → sin segundo envío.
- Automatización tras handoff → rechazada; envío manual sigue funcionando.
- UI renderiza texto del cliente como texto (sin ejecución HTML) — manual/opcional.

El provider fake soporta modos: normal, 503, 504, delay, lookup not_found.

---

## 9. HANDOFF.md / nota de IA / tiempo (a completar en la entrega)

- **Q9.1 — Tiempo aproximado invertido:** _Por definir._
- **Q9.2 — Herramientas IA usadas + sugerencia aceptada/cambiada + verificación:** _Por definir._
- **Q9.3 — Limitaciones restantes:** _Por definir (un solo proceso, sin DB distribuida, sin OAuth real, sin LLM real, sin recall de mensajes despachados, sin scheduler sofisticado de retries)._

---

## Orden de ejecución

1. Esquema + helpers del store (processed_events, row filtrado por tenant, helpers de transacción).
2. `receiveWebhook` transacción idempotente.
3. Aislamiento por tenant en `row()` + todos los métodos.
4. Aprobación exacta (versión + invalidación de aprobación).
5. `sendReply` con attempt primero, clasificación, dedup, chequeo de takeover.
6. `reconcile`.
7. `handoff` + rechazo de automatización.
8. Actualizaciones de UI para estado UNKNOWN + renderizado seguro.
9. Tests.
10. HANDOFF.md + nota de IA.

Una implementación honesta y más pequeña es preferible a afirmaciones no sustentadas de producción.

## Estado de implementación

Implementado en `src/store.mjs` y `src/service.mjs` (server/UI sin cambios salvo SIGINT). Verificación: `npm test` → 19/19 pasando (2 baseline + 17 nuevos). Integración manual verificada: dedup de replay de webhook, accept_then_timeout → UNKNOWN + reconcile → SENT, reject_before_accept → FAILED, handoff bloquea automatización, envío manual tras takeover funciona, cross-tenant 404, restart durante accept_then_delay deja el attempt en PENDING sin segundo envío.