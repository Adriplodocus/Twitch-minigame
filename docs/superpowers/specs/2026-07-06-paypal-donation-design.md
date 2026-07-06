# Donación PayPal + sobre automático — Design

## Contexto

Se quiere un botón de donación en el header (izquierda del username) que enlace a `https://www.paypal.com/paypalme/MrKlypp`, y que una donación ≥ un umbral configurable (por defecto 2€) otorgue sobres automáticamente, escalando igual que el sistema de bits ya existente (`floor(importe / threshold) * quantity`).

La cuenta de PayPal es personal (no Business, sin acceso a developer.paypal.com). La automatización usa **IPN clásico** (Instant Payment Notifications), disponible en cuentas personales activándolo en Profile → Instant Payment Notifications, sin necesitar credenciales de API.

## Problema de identidad

paypal.me no lleva identidad de usuario de la app. Se pide al donante escribir su **usuario de Twitch en la nota** del pago (paypal.me soporta un campo "Add a note" opcional). El IPN handler intenta leer esa nota (el nombre exacto del campo varía según el flujo de pago de PayPal — candidatos: `memo`, `note`, `item_name`; se prueban en orden en la implementación) y la matchea contra `users.username` (case-insensitive).

Si no hay match (nota vacía, typo, usuario no registrado en la app) la donación no se pierde: queda en una cola de revisión manual en el panel admin, reutilizando el flujo de grant manual ya existente (`admin.post("/grant-packs")`).

## Alcance

- Frontend: botón donar en `page-header-user` de `collection.html`, `trade.html`, `offers.html`, `album.html`. No en `admin.html` (panel de trabajo, no touchpoint de donante).
- Backend: nuevo webhook `POST /webhook/paypal-ipn`, nueva tabla `paypal_donations`, columnas nuevas en `pack_grant_config`, endpoints admin para listar y resolver donaciones sin asignar.
- Migración D1, aplicada local y remoto.

## Botón donar

Elemento `<a class="donate-btn" href="https://www.paypal.com/paypalme/MrKlypp" target="_blank" rel="noopener" title="Incluye tu usuario de Twitch en la nota del pago para recibir tu sobre automáticamente">` con icono de corazón + texto "Donar", a la izquierda del avatar dentro de `page-header-user`.

Estilo: pill con gradiente pink→blue (marca), glow sutil, animación `pulse` (ya definida en el sistema de diseño global) para que llame la atención sin ser intrusivo.

## Modelo de datos

`migrations/0016_paypal_donations.sql`:

```sql
ALTER TABLE pack_grant_config ADD COLUMN paypal_threshold INTEGER NOT NULL DEFAULT 2;
ALTER TABLE pack_grant_config ADD COLUMN paypal_quantity INTEGER NOT NULL DEFAULT 1;

CREATE TABLE paypal_donations (
  txn_id TEXT PRIMARY KEY,
  amount REAL NOT NULL,
  currency TEXT NOT NULL,
  note_raw TEXT,
  matched_username TEXT,
  matched_user_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('granted', 'unmatched', 'ignored')),
  packs_granted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
```

`txn_id` como PK da idempotencia gratis: PayPal puede reenviar el mismo IPN, un `INSERT OR IGNORE` (o check previo) evita duplicar sobres.

## Backend

**`worker/lib/grants.ts`** (nuevo, extraído de `webhook.ts` para compartir con el handler de PayPal):
- `upsertUser(db, userId, username)`
- `grantPacks(db, userId, quantity, source, tier)`

`webhook.ts` pasa a importar desde aquí en vez de definir localmente.

**`worker/lib/paypal-ipn.ts`** (nuevo):
- `verifyIpn(rawBody: string): Promise<boolean>` — reenvía el body recibido a `https://ipnpb.paypal.com/cgi-bin/webscr` con `cmd=_notify-validate` antepuesto, comprueba que la respuesta sea `"VERIFIED"`.
- `parseIpnFields(rawBody: string)` — parsea `application/x-www-form-urlencoded`, extrae `txn_id`, `mc_gross`, `mc_currency`, `payment_status`, `receiver_email`, y el primer campo no vacío de `["memo", "note", "item_name"]` como nota.

**`worker/routes/webhook-paypal.ts`** (nuevo, montado en `worker/index.ts` junto a `/webhook/*`):
1. Lee body como texto, verifica con `verifyIpn`. Si falla → `200 OK` sin más acción (no se reintenta un ataque).
2. Verifica `receiver_email === env.PAYPAL_RECEIVER_EMAIL` (nueva var de entorno) — el handshake de PayPal confirma que el IPN es genuino, pero no que el pago fue a nuestra cuenta y no a otra transacción legítima de otro merchant. Si no coincide → descartar.
3. Si `payment_status !== "Completed"` → descartar (pending/refunded/etc no otorgan).
4. Si `txn_id` ya existe en `paypal_donations` → `200 OK`, no reprocesar.
5. Si `mc_currency !== "EUR"` o `mc_gross < paypal_threshold` → insertar fila `status: mc_currency !== "EUR" ? "unmatched" : "ignored"`.
6. Buscar `users` por username (nota parseada, trim + lowercase compare). Si no hay match → insertar fila `status: "unmatched"`.
7. Si hay match → `packs = floor(mc_gross / paypal_threshold) * paypal_quantity`, `grantPacks(db, userId, packs, "paypal", "apoyo")`, insertar fila `status: "granted"`, `packs_granted: packs`.

**Endpoints admin** (`worker/routes/admin.ts`):
- `GET /api/admin/paypal-donations?status=unmatched` — lista para la cola de revisión.
- `POST /api/admin/paypal-donations/:txnId/resolve` — body `{ twitchId, quantity }`, otorga `grantPacks(..., "paypal_manual", "apoyo")`, actualiza la fila a `granted` con `matched_user_id` y `packs_granted`.
- `pack-grant-config` GET/PUT existentes se extienden con `paypalThreshold`/`paypalQuantity`.

**Env nueva**: `PAYPAL_RECEIVER_EMAIL` en `worker/types.ts`, `.dev.vars.example`, y como secret en producción (`wrangler secret put`).

## Frontend admin

`admin.html`/`admin.ts`: sección "Donaciones sin asignar" (lista `unmatched`, cada fila con importe/nota/fecha + selector de usuario tipo el ya usado en grant manual + botón "Asignar"). Config de `paypalThreshold`/`paypalQuantity` junto a la de bits ya existente.

## Testing

`vitest.workers.config.ts` (nuevo `test/webhook-paypal.test.ts`):
- IPN válido + nota con username existente + importe ≥ umbral → sobres otorgados, fila `granted`.
- Importe escalado (6€, umbral 2€) → 3 sobres.
- Handshake de verificación falla → sin grant, sin fila.
- `receiver_email` no coincide → sin grant, sin fila.
- `txn_id` repetido → segunda llamada no duplica.
- Nota vacía o username inexistente → fila `unmatched`.
- Moneda ≠ EUR o importe < umbral → fila `ignored`/`unmatched` según corresponda.
- Admin resuelve donación `unmatched` → grant correcto, fila pasa a `granted`.

`vitest.config.ts`:
- Botón donar presente con href correcto en las 4 páginas viewer.

## Fuera de alcance

- Conversión de divisas.
- Reembolsos/chargebacks (si PayPal manda IPN de refund, no hay lógica de retirar sobres ya entregados — se trata como evento no reconocido y se ignora).
- Fuzzy-matching de username con typos (match exacto case-insensitive únicamente).
