# Rack map API

Floor plan, rack front views, bin-to-bin moves, put-away suggestions and pick
routes. Routes have no global prefix. Coordinates are JSON numbers in metres
(stored as `Decimal(8,2)`); money is a decimal string with 2 places.

Origin is the north-west corner of the floor; x grows east, y grows south,
rotation is clockwise.

| rotation | box width × height | pick face | slot A at |
|---|---|---|---|
| 0   | depth × length | east  | north end |
| 90  | length × depth | south | east end  |
| 180 | depth × length | west  | south end |
| 270 | length × depth | north | west end  |

Zones and aisles are always rotation 0 with `length` west-east and `depth`
north-south, have no pick face, and may overlap anything. Racks, docks,
staging and packing areas must fit on the floor and keep 0.5 m from each
other.

**Floor-level items** (the only things that can be placed): `ZONE`, `AISLE`,
`RACK`, `RECEIVING`, `STAGING`, `PACKING` with no parent or a `ZONE` parent.
Shelves and bins move with their rack.

**Layout changes never write inventory movements.** Moving stock between
bins writes one `LOCATION_MOVE` (direction `INTERNAL`, onHand unchanged).

## Shared types

```ts
type Rotation = 0 | 90 | 180 | 270;
type Face = 'north' | 'east' | 'south' | 'west';
type LocationType = 'ZONE' | 'AISLE' | 'RACK' | 'SHELF' | 'BIN' | 'RECEIVING' | 'STAGING' | 'PACKING';
interface Point { x: number; y: number }
interface Box { x: number; y: number; width: number; height: number } // top-left corner
interface Placement { centerX: number; centerY: number; length: number; depth: number; rotation: Rotation }
interface CellStats { units: number; value: string; skuCount: number; movements: number }
interface TopSku { inventoryLevelId: string; variantId: string; sku: string; quantity: number }
interface Bin { id: string; code: string; slotIndex: number; isActive: boolean; isPickable: boolean; stock: CellStats; topSkus: TopSku[] }
interface Level { id: string; levelNumber: number; bins: Bin[] } // ground level first
interface FloorItem {
  id: string; code: string; name: string | null; type: LocationType; parentId: string | null;
  isActive: boolean; isPickable: boolean; pickSequence: number;
  placement: Placement; box: Box;
  pickFace: Face | null;    // racks only
  slotCount: number | null; // racks only
  levels: Level[] | null;   // racks only
  stock: CellStats;         // whole subtree
}
```

`CellStats.movements` counts ledger rows from or to the location(s) in the
last `activityDays` days; a move between two locations of the same set
counts once.

**Rack structure:** a rack's SHELF children are its levels (by
`levelNumber`, else walk order) and each shelf's children its bins (by
`slotIndex`, else walk order); a shelf with no bins is a one-bin level using
the shelf itself. A rack with only BIN children has one level; a rack with
no children is one level whose only bin is the rack itself. `slotCount` is
the number of slot columns: the most bins on a level, or the highest
`slotIndex` + 1 when indexes have gaps.

## Reads

### `GET /inventory/warehouses/:warehouseId/floor-plan?activityDays=30`

`activityDays` 1–365, default 30. Runs a fixed number of queries whatever
the warehouse size.

```ts
{
  warehouse: { id; name; code; type; floorWidth: number | null; floorDepth: number | null };
  items: FloorItem[];                                                 // placed floor-level items, walk order
  unplaced: { id; code; name: string | null; type: LocationType }[]; // floor-level, not placed yet
  totals: { unitsOnRacks; binsTotal; binsUsed; unitsToPutAway };      // put-away = RECEIVING + STAGING
  maxCell: { units: number; value: string; movements: number };      // max over rack slot columns
  activityDays: number;
  generatedAt: string;
}
```

### `GET /inventory/locations/:locationId/contents`

Rows are summed per inventory level over the location and everything under
it; `isDefault` means the level's default location is in that subtree.
`variantLabel` is the option values joined with ", " (ordered by option
name), or `"Standard"` when the variant has none.

```ts
{
  location: { id; code; name; type; isActive; isPickable; pickSequence; rackId: string | null };
  rows: { inventoryLevelId; variantId; sku; productName; variantLabel; quantity; unitCost: string; value: string; isDefault: boolean }[];
  recentMovements: { id; type; quantity; sku; fromLocationCode: string | null; toLocationCode: string | null; createdAt: string; performedBy: string | null }[]; // last 10
}
```

### `GET /inventory/warehouses/:warehouseId/put-away`

Stock sitting at RECEIVING / STAGING locations (including `UNASSIGNED`).
Suggestion: the level's default location → a location already holding the
variant → the first empty location in walk order (preferring the variant's
zones) → `null`. Only active, pickable leaf RACK / SHELF / BIN locations are
suggested; within one response an empty bin is suggested to one SKU only.

```ts
{ lines: { locationId; locationCode; inventoryLevelId; sku; productName; quantity; suggestedLocationId: string | null; suggestedLocationCode: string | null }[] }
```

### `GET /inventory/warehouses/:warehouseId/pick-route`

Without `orderId`: `{ orders: { orderId: string; lines: number }[] }`, the
orders with ACTIVE reservations at this warehouse.

With `?orderId=`:

```ts
{
  orderId: string;
  start: Point | null; end: Point | null; startLocationCode: string | null; // PACKING, else RECEIVING, else null
  stops: { sequence; locationId; locationCode; rackId: string | null; inventoryLevelId; sku; productName; quantity; point: Point | null }[];
  shortages: { inventoryLevelId; sku; quantity }[];
}
```

Stops come from the same `planPick()` the shipping commit uses, in the same
reservation order, so the route is what actually gets picked. They're
sorted by the location's `pickSequence`. `point` is 0.75 m outside the
rack's pick face level with the slot, or the centre of a non-rack location;
it's `null` when the location (or its rack) isn't on the map. 404 when the
order has no active reservations here.

## Layout writes

### `PUT /inventory/warehouses/:warehouseId/floor-size`
Body `{ floorWidth, floorDepth }` → `{ floorWidth, floorDepth }`. 409 if a
placed item would fall outside.

### `PATCH /inventory/locations/:locationId/placement`
Body: a `Placement`, or `{ remove: true }` → `{ placement: Placement | null; box: Box | null }`.
400 for shelves / bins / nested locations and for zones with rotation ≠ 0;
409 if the floor size isn't set, the item doesn't fit, or it would touch
another rack ("B-04 would touch B-03. Leave at least 0.5 m between racks.").

### `POST /inventory/locations/:locationId/rotate`
Body `{ direction: 'cw' | 'ccw' | '180' }` →
`{ placement; box; pickFace: Face | null; shifted: boolean }`. Turns about the
centre (four `cw` turns are a no-op). If the turned rack collides it moves
to the nearest free spot within 4 m (`shifted: true`); otherwise 409.
Zones and aisles can't be rotated (400).

### `POST /inventory/warehouses/:warehouseId/racks`
Body `{ code; name?; zoneId?; levels: 1-8; binsPerLevel: 1-6; rotation; length?; depth?; placement? }` → 201 `FloorItem`.

- `code` is upper-cased and must match `^[A-Z0-9][A-Z0-9-]{0,9}$`; 409 if any
  location in the warehouse equals it or starts with `code-`.
- Defaults: `depth` 1.2 m, `length` = `binsPerLevel × 1.4` m.
- Creates RACK `code` (not pickable), SHELF `code-L{n}` (`levelNumber` n, not
  pickable) and BIN `code-{n}-{A..F}` (`slotIndex` 0.., pickable).
  `pickSequence`: rack = next block (highest sequence below 9000 rounded up
  to the next 100), shelf = block + n×10, bin = block + n×10 + i + 1.
- Placement: `placement` if given, else the first free spot inside the
  zone, else anywhere on the floor; 409 if nothing fits or no floor size.

### `DELETE /inventory/locations/:locationId`
Applies to the location and its whole subtree →
`{ message; result: 'deleted' | 'deactivated' }`.
409 "Move the N units out first" while anything in it holds stock. If any
of it has history (movements from/to it, adjustment lines, or a level's
default location) it's deactivated instead: `isActive = false` on the
subtree, those defaults cleared, placement kept. Otherwise it's deleted.

### `PATCH /inventory/locations/:locationId`
`isPickable`, `isActive`, `name` (and the older fields this endpoint
already accepted). `isActive: false` is refused (409) while the subtree
holds stock.

## Stock writes

### `POST /inventory/locations/:fromLocationId/moves?actedBy=`
Body `{ inventoryLevelId; toLocationId; quantity; makeDefault? }` →
201 `{ movementId; from: { locationId; quantity }; to: { locationId; quantity } }` (quantities after the move).
The destination must be in the same warehouse, active, a leaf and not a
zone / aisle; 1 ≤ quantity ≤ what the source holds (400 otherwise).
`makeDefault` sets the level's default location when the destination is
pickable (ignored otherwise).

### `POST /inventory/locations/:locationId/counts?actedBy=`
Body `{ lines: { inventoryLevelId; countedQty }[]; applyNow: boolean }` →
201 `{ adjustment: { id; adjustmentNumber; status } | null }`.
Creates a `CYCLE_COUNT` adjustment (`ADJ-YYYY-NNNNN`) with one item per line
that differs from the location's quantity (`expectedQty`, `actualQty`,
`adjustmentQty = actual − expected`); `null` when nothing differs. With
`applyNow` and an approver as `actedBy` (an active ADMIN / SUPER_ADMIN), it's
applied at once (one `ADJUSTMENT_INCREASE` / `ADJUSTMENT_DECREASE` per item at
the bin, status `APPLIED`); otherwise it stays `PENDING`. The location must
be a leaf.

## Errors

400 validation, 404 missing records, 409 conflicts (collision, stock
present, code taken, no floor size). Every error has a `message` meant to be
shown as-is.

## Permissions

The project has no auth module yet. Intended rules, to enforce once one
exists:

- View floor plan, contents, routes, put-away: staff (ADMIN, SUPER_ADMIN).
- Layout (floor size, placement, rotate, create / remove rack, location
  flags): ADMIN, SUPER_ADMIN.
- Stock moves and counts: same as other inventory writes.

Until then, stock writes take `?actedBy=<userId>` like the rest of the
inventory API; it's recorded on movements and decides whether a count may
be applied right away.
