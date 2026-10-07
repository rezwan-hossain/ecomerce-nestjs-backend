# Inventory workflows: warehouses, purchase orders, adjustments, transfers

Date: 2026-10-07 · Branch: `feat/inventory-workflows` (off `feat/rack-map`)

## Goal

Give the admin (`ecomerce-admin`) real backends for four inventory pages that
run on `DEMO_*` data today: Warehouses, Purchase orders, Adjustments and
Transfers. Every button those pages have must map to an endpoint. Stock
changes go through the existing `InventoryService` primitives, so the ledger,
racks, batches, weighted-average cost and storefront stock stay correct.

Out of scope: reorder rules, alerts, batch and reservation APIs (those pages
stay on demo data), batch tracking through transfers, and an auth module.

## Decisions

- **One service and one controller per workflow**, all inside
  `InventoryModule`: `WarehousesService`, `PurchaseOrdersService`,
  `StockAdjustmentsService`, `TransfersService`. They call `InventoryService`
  (`applyMovement`, `receiveStock`, `applyAdjustment`, `ensureLevel`,
  `getUnassignedLocationId`, `syncVariantStock`) inside their own
  `prisma.$transaction`. `inventory.service.ts` only gets the small
  extensions listed below.
- **No migration** except the optional revalue movement type (section 5).
- **Auth.** The codebase has no auth guard; "ADMIN+" routes such as
  `GET /reviews` are marked by a route comment only. The new approve, reject
  and apply routes follow that: open routes with an `(ADMIN+)` comment. There
  is no role check on `actedBy`. `?actedBy=<userId>` is optional and is only
  recorded (`createdByUserId`, `approvedByUserId`, `performedByUserId`, …);
  null when missing.
- **Response shapes for new endpoints:** `{ data }` for one record,
  `{ data, meta: { total, page, limit, totalPages } }` for lists.
  Errors use Nest's standard `{ statusCode, message, error }`.
- **Document state changes** lock the document row
  (`SELECT … FOR UPDATE`) then check its status; a wrong transition returns
  409 with the current status in the message.
- **Document numbers** (`PO-2026-00001`, `TRF-2026-00001`, existing
  `ADJ-2026-00001`) come from `nextDocumentNumber(tx, kind, date)`,
  generalised from `nextAdjustmentNumber` (per-kind advisory lock, per-year
  counter, 5 digits). `nextAdjustmentNumber` delegates to it.
- **Ledger rows** written by these workflows set `referenceType`
  (`PURCHASE_ORDER`, `TRANSFER`, `ADJUSTMENT`), `referenceId` = document id,
  and put the document number in `note` (e.g. `PO-2026-00001`), so the
  Movements page can show it.
- **Line display fields.** Every document line returns
  `variant: { id, sku, productName, label }` (`label` = option values joined
  with ` / `, e.g. `Red / XL`), `warehouse: { id, code, name }` and, where it
  applies, `location: { id, code } | null`. Users return as
  `{ id, name } | null`.
- **Route safety.** Static segments (`bulk`, `requests`) are declared before
  `:id`, and every `:id` param uses `ParseUUIDPipe` (its default accepts
  UUIDv7).
- **`InventoryLevel.incoming`** is written by nothing today. From now on it
  is the sum of outstanding units on submitted POs and shipped transfers
  for that level, maintained by the transitions below.

## Must keep working

Paths and response shapes stay exactly as they are for:
`GET /inventory`, `GET /inventory/summary`, `GET /inventory/variants/:id`,
`GET /inventory/movements`, `POST /inventory/adjustments`,
`POST /inventory/adjustments/bulk`, variant count / location-moves /
default-location / threshold, `/inventory/locations` CRUD, all floor-plan
endpoints (no `{ data }` wrapper), and `POST /products` with `supplierId`
(opening stock booked as `PURCHASE_RECEIVED` through `receiveStock`).

## Changes to `InventoryService`

1. `StockReceipt` gains optional `purchaseOrderItemId`, `referenceType`,
   `referenceId`. When given, the batch gets `purchaseOrderItemId` and the
   movement gets the reference. When omitted (products path, `/receive`),
   batch and movement are written exactly as today. A unit test pins the
   products path: same batch data, `referenceType`/`referenceId` null.
2. `applyAdjustment(tx, id, userId, opts?: { requireStatus?: 'APPROVED' })`:
   the status check runs after the row lock; with `requireStatus` only that
   status is accepted. The rack-map count path (`applyNow`) keeps calling it
   without options, so it still applies PENDING adjustments.
3. Stale-count re-check: CYCLE_COUNT items **without** a location are
   re-based on the level's current `onHand` at apply time (items with a
   location already re-base on the location's quantity). INCREASE and
   DECREASE deltas are applied as written.
4. `nextDocumentNumber` as above; `MOVEMENT_DIRECTION` gains `REVALUATION`
   (section 5).

## 1. Warehouses — `/inventory/warehouses`

Fields the UI edits: `name, code, type, addressLine1, addressLine2, city,
state, postalCode, priority, isDefault, isActive`.

| Route | Behaviour |
|---|---|
| `GET /` | All warehouses (not paginated; there are few), ordered default first, then priority desc, name. Each row adds `floorWidth`, `floorDepth` and `counts: { locations, variantsStocked, unitsOnHand, stockValue }`. `locations` excludes UNASSIGNED; `variantsStocked` = levels with `onHand > 0`; `stockValue` = Σ `totalCost`. Returns `{ data }`. |
| `GET /:id` | One warehouse with the same counts. |
| `POST /` | Creates it and its UNASSIGNED location. `isDefault: true` clears the old default in the same transaction. Duplicate name or code → 409. |
| `PATCH /:id` | Any field except `code`; sending `code` → 400 (racks and documents show it). |
| `DELETE /:id` | Only when nothing references it (levels, movements, locations other than an empty UNASSIGNED, batches, documents). Otherwise 409 "deactivate it instead". The default warehouse can't be deleted. |
| `GET /:id/stock` | That warehouse's inventory levels, paginated, `search` on SKU / product name: `onHand, reserved, available, incoming, damaged, unitCost, totalCost, variant, defaultLocation`. |

Rules:
- The default warehouse can't be deactivated, and `isDefault: false` on the
  current default → 400 ("make another warehouse the default"). A new default
  must be active.
- Deactivating, or changing `type` between sellable (`PHYSICAL`, `STORE`) and
  virtual, re-runs `syncVariantStock` for every variant stocked there, since
  storefront stock only counts active sellable warehouses.
- Deactivating is refused (409) while the warehouse has open documents:
  POs with lines there in SUBMITTED/CONFIRMED/PARTIAL, or transfers from or
  to it in PENDING/IN_TRANSIT/PARTIAL.

## 2. Purchase orders — `/purchase-orders`

UI-edited fields: `supplierId, expectedAt, note, taxAmount, shippingAmount,
items[] { variantId, warehouseId?, orderedQty, unitCost }`. A line's
`warehouseId` defaults to the default warehouse. One line per
(variant, warehouse) — duplicates → 400. Line `totalCost = orderedQty ×
unitCost`; `subtotalAmount = Σ totalCost`, `totalAmount = subtotal + tax +
shipping`, all computed on the server.

| Route | From → to | Behaviour |
|---|---|---|
| `POST /` | → DRAFT | Supplier must exist and be active; variants exist; warehouses active. Records `createdByUserId`. |
| `GET /` | | Paginated; filters `status`, `supplierId`, `search` (PO number), `dateFrom/dateTo` on `createdAt`. Rows include supplier `{ id, code, name }`, line count, totals, ordered/received unit counts. |
| `GET /:id` | | Full PO with lines (plus `outstandingQty` per line), supplier, users, `metadata`. |
| `PATCH /:id` | DRAFT only | Header fields; `items` given → lines replaced wholesale; totals recomputed. |
| `DELETE /:id` | DRAFT only | Hard delete (lines cascade). |
| `POST /:id/submit` | DRAFT → SUBMITTED | Needs ≥1 line and an active supplier. `orderedAt = now`. Each line's level gets `incoming += orderedQty` (level created via `ensureLevel` if missing). |
| `POST /:id/confirm` | SUBMITTED → CONFIRMED | `approvedByUserId = actedBy`. |
| `POST /:id/receive` | SUBMITTED / CONFIRMED / PARTIAL | Body `{ lines: [{ itemId, quantity, damagedQty, batchNumber?, expiresAt?, manufacturedAt?, locationId? }], reference?, note? }` — see below. |
| `POST /:id/cancel` | DRAFT / SUBMITTED / CONFIRMED, nothing received | → CANCELLED, `cancelledAt`; submitted lines release `incoming`; lines → CANCELLED. A PO with receipts → 409 "close it instead". |
| `POST /:id/close` | PARTIAL / RECEIVED → CLOSED | Lines with outstanding units → CANCELLED and release their `incoming`. Serves the UI's "Cancel the rest" and "Close short". |
| `GET /suppliers/:supplierId/purchase-orders` | | Same as the list, fixed to that supplier. |

Receive, per line (all lines in one transaction, all or nothing):
- `quantity ≥ 0`, `damagedQty ≥ 0`, `quantity + damagedQty ≥ 1` and
  `≤ outstanding` (`orderedQty − receivedQty − damagedQty`), else 400.
  Each `itemId` once, and it must belong to this PO.
- `quantity > 0` → `receiveStock` with the line's `warehouseId`,
  `unitCost` (**required**: this updates the level's weighted-average cost),
  `supplierId`, `purchaseOrderItemId`, `referenceType: PURCHASE_ORDER`,
  `referenceId: po.id`, `note: po.poNumber` (+ request note), and the
  optional batch fields.
- Damaged units are only counted on the line (refused at the dock, never
  in stock).
- Level `incoming −= quantity + damagedQty`.
- Line status: PARTIAL while outstanding > 0, else RECEIVED. PO status:
  RECEIVED (and `receivedAt = now`) when every line has outstanding 0, else
  PARTIAL.

`metadata` is returned as stored. A PO drafted by a reorder rule will carry
`metadata.source = "REORDER_RULE"`; nothing writes that yet.

## 3. Stock adjustments — `/inventory/adjustments`

The existing direct `POST /inventory/adjustments` and `POST
/inventory/adjustments/bulk` stay unchanged on `InventoryController`. The
new `StockAdjustmentsController` (`inventory/adjustments`) declares
`requests` before `:id`.

Line input: `{ variantId, warehouseId, locationId?, actualQty?,
adjustmentQty? }`. `locationId` omitted = whole warehouse; if given it must
be a stock-holding location in that warehouse. Lines are unique per
(variant, warehouse, location), checked in code because NULL locations don't
collide in Postgres.
- `expectedQty` is always snapshotted by the server (location quantity, or
  the level's `onHand` for whole-warehouse lines); client values are ignored.
- INCREASE: `adjustmentQty > 0`. DECREASE: `adjustmentQty < 0` (signed, as
  the schema stores it). CYCLE_COUNT: `actualQty ≥ 0` required, server sets
  `adjustmentQty = actualQty − expectedQty`.
- `unitCost` is copied from the level's current `unitCost`.

| Route | From → to | Behaviour |
|---|---|---|
| `GET /` | | Paginated; filters `status`, `type`, `reason`, `warehouseId`, `dateFrom/dateTo`. Rows include line count, created/approved by. |
| `GET /:id` | | Adjustment with lines (variant, warehouse code, location code, `expectedQty, actualQty, adjustmentQty, unitCost`), users, `approvedAt`, `appliedAt`. |
| `POST /requests` | → PENDING | `{ type, reason, note?, items[] }`. Records `createdByUserId`. |
| `PATCH /:id` | PENDING only | `{ reason?, note?, items? }`; `items` replaces the lines and re-snapshots `expectedQty`. `type` is fixed after create. |
| `POST /:id/approve` (ADMIN+) | PENDING → APPROVED | `approvedByUserId = actedBy`, `approvedAt = now`. No stock change. |
| `POST /:id/apply` (ADMIN+) | APPROVED → APPLIED | `applyAdjustment(tx, id, actedBy, { requireStatus: 'APPROVED' })`, including the stale-count re-check. If a decrease no longer has enough available stock → 400 and nothing changes (stays APPROVED). |
| `POST /:id/reject` (ADMIN+) | PENDING → REJECTED | |
| `POST /:id/cancel` | PENDING / APPROVED → CANCELLED | |

Adjustments created by rack-map bin counts appear here and follow the same
flow.

## 4. Transfers — `/inventory/transfers`

Create/update body: `{ fromWarehouseId, toWarehouseId, note?, items[]
{ variantId, quantity } }`; warehouses distinct and active, one line per
variant. `quantity` is stored in `sentQty` (no schema change). Lines are
returned as `requestedQty` (= `sentQty`), `shippedQty` (= `sentQty` once
shipped, else 0), `receivedQty`, `damagedQty`, `outstandingQty`, plus
`unitCost`.

| Route | From → to | Behaviour |
|---|---|---|
| `GET /` | | Paginated; filters `status`, `fromWarehouseId`, `toWarehouseId`, `search` (number). |
| `GET /:id` | | Transfer with lines, both warehouses, users. |
| `POST /` | → DRAFT | `initiatedByUserId = actedBy`. |
| `PATCH /:id` | DRAFT only | Lines replaced when `items` given. |
| `DELETE /:id` | DRAFT only | Hard delete. |
| `POST /:id/approve` | DRAFT → PENDING | |
| `POST /:id/ship` | PENDING → IN_TRANSIT | See below. |
| `POST /:id/receive` | IN_TRANSIT / PARTIAL | See below. |
| `POST /:id/cancel` | DRAFT / PENDING → CANCELLED | Nothing has moved yet. Shipped transfers → 409 (they have to be received). |

Ship (one transaction):
- First locks every source level and checks `available ≥ quantity`. If any
  line is short → 409 with body
  `{ statusCode: 409, message, shortLines: [{ variantId, sku, wanted, available }] }`
  and nothing is written.
- Per line: `unitCost` = source level's `unitCost`, saved on the line;
  `applyMovement` `TRANSFER_OUT` at the source (auto-picked from racks),
  `sourceWarehouseId/destWarehouseId`, reference TRANSFER, note = transfer
  number; destination level `incoming += quantity` (`ensureLevel` first).
- `shippedAt = now`.

Receive: body `{ lines: [{ itemId, receivedQty, damagedQty, locationId? }] }`,
same quantity rules as PO receive against `outstanding = sentQty −
receivedQty − damagedQty`.
- `receivedQty > 0` → `TRANSFER_IN` at the destination with the line's
  `unitCost` (keeps the destination's weighted average right), put away to
  `locationId` or the default rack rules.
- `damagedQty > 0` → `TRANSFER_IN` then `DAMAGED` for those units, the
  `DAMAGED` taken from the same location the `TRANSFER_IN` put them, so they
  end in the destination's damaged bucket and stay on the ledger.
- Destination `incoming −= receivedQty + damagedQty`.
- Status COMPLETED (`receivedAt`, `receivedByUserId`) when every line's
  outstanding is 0, else PARTIAL.

## 5. Revalue — `POST /inventory/levels/:id/revalue`

Body `{ unitCost ≥ 0, note? }`. Fixes stock that sits at ৳0 value.
- Migration: add `REVALUATION` to `MovementType` (direction INTERNAL);
  also added to `movementTypeEnum` so `GET /inventory/movements?type=` accepts it.
- Locks the level; `onHand = 0` → 400 (nothing to revalue; the next receipt
  sets the cost).
- Sets `unitCost`, `totalCost = unitCost × onHand`, bumps `version`.
- Writes one ledger row: `REVALUATION`, INTERNAL, `quantity = onHand`,
  `onHandBefore = onHandAfter = onHand`, the new `unitCost`/`totalCost`,
  `metadata: { previousUnitCost }`, note, `performedByUserId`.
- Returns `{ data }` with the updated level.

## Testing

- **Unit** (mocked Prisma, the existing `inventory.service.spec.ts` style):
  status transitions (each wrong transition → 409), receive and ship
  quantity rules, PO totals, the products-path `receiveStock` regression,
  `applyAdjustment` `requireStatus` and whole-warehouse re-base,
  `nextDocumentNumber`.
- **E2E** (`test/*.e2e-spec.ts` against the `_test` database), one file per
  workflow, checking after each step: `onHand`, `available`, `incoming`,
  `damaged`, `unitCost`, `ProductVariant.stock`, ledger rows (type,
  reference, note) and document status. Includes: PO partial receive then
  close; transfer short ship → 409 with `shortLines`; damaged transfer units
  land in `damaged`; warehouse deactivation re-syncs storefront stock;
  `GET /inventory/adjustments/bulk` doesn't hit `:id` (400 from
  `ParseUUIDPipe`, not a lookup).
- Existing unit and e2e suites keep passing.

## Deliverables

1. Code: four services + controllers + Zod DTOs under
   `src/modules/inventory/` (POs: `purchase-orders.*`), the `InventoryService`
   extensions, the revalue migration.
2. `docs/api/inventory-workflows.md`: every new route with request and
   response examples, status diagrams, the `{ data }` / `{ data, meta }`
   convention, and the `incoming` rules.
3. `docs/frontend/inventory-workflows-prompt.md`: a prompt for
   `ecomerce-admin` that replaces `DEMO_*` data on the Warehouses, Purchase
   orders, Adjustments and Transfers pages only (batches, reservations,
   alerts and reorder rules stay demo), following `app/actions/*.actions.ts`
   and `types/*.type.ts` conventions, maps every button to its endpoint,
   handles the 409 `shortLines` body, and adds a `REVALUATION` label to the
   Movements page.
