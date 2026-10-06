import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { Prisma } from 'src/generated/prisma/client';

import {
  boundingBox,
  boxCenter,
  Box,
  CLEARANCE,
  findFreeSpot,
  Floor,
  fitsFloor,
  isFree,
  nudgeToFree,
  overlaps,
  pickFace,
  Placement,
  Point,
  rotate,
  RotateDirection,
  round2,
  stopPoint,
} from './geometry';
import { planPick } from './pick-plan';
import { INBOUND_TYPES, PutAwayLocation, suggestPutAway } from './put-away';
import {
  BIN_LENGTH,
  buildRackPlan,
  DEFAULT_RACK_DEPTH,
  nextPickBlock,
  rackCodeConflict,
} from './rack-layout';
import {
  AREA_TYPES,
  floorOf,
  LOCATION_ROW_SELECT,
  LocationRow,
  MovementPair,
  placementOf,
  shapeKind,
  StockIndex,
  StockRow,
  WarehouseLayout,
} from './floor-plan.layout';
import {
  CreateRackDto,
  FloorSizeDto,
  PlacementBodyDto,
} from '../dto/floor-plan.dto';

type Db = Prisma.TransactionClient | PrismaService;

const ROTATE_NUDGE_LIMIT = 4;

/**
 * The rack map: floor plan, rack structure, put-away suggestions, pick
 * routes and layout edits. Layout edits (floor size, placement, rotation,
 * creating racks) never touch stock or write movements; stock changes go
 * through InventoryService.
 */
@Injectable()
export class FloorPlanService {
  constructor(private readonly prisma: PrismaService) {}

  // ═════════════════════════════════════════════════
  //   READS
  // ═════════════════════════════════════════════════

  /** GET /inventory/warehouses/:warehouseId/floor-plan */
  async floorPlan(warehouseId: string, activityDays: number) {
    const [warehouse, layout, stock] = await Promise.all([
      this.loadWarehouse(this.prisma, warehouseId),
      this.loadLayout(this.prisma, warehouseId),
      this.loadStock(this.prisma, warehouseId, activityDays),
    ]);

    const items: ReturnType<FloorPlanService['toFloorItem']>[] = [];
    const unplaced: {
      id: string;
      code: string;
      name: string | null;
      type: LocationRow['type'];
    }[] = [];
    for (const loc of layout.floorItems()) {
      if (placementOf(loc)) items.push(this.toFloorItem(loc, layout, stock));
      else
        unplaced.push({
          id: loc.id,
          code: loc.code,
          name: loc.name,
          type: loc.type,
        });
    }

    // Totals and colour-scale maxima over every rack, placed or not.
    let unitsOnRacks = 0;
    let unitsToPutAway = 0;
    for (const loc of layout.locations) {
      const units = stock.unitsAt(loc.id);
      if (loc.type === 'RACK' || loc.type === 'SHELF' || loc.type === 'BIN')
        unitsOnRacks += units;
      if (INBOUND_TYPES.includes(loc.type)) unitsToPutAway += units;
    }
    let binsTotal = 0;
    let binsUsed = 0;
    const max = { units: 0, value: new Decimal(0), movements: 0 };
    for (const rack of layout.locations.filter((l) => l.type === 'RACK')) {
      const { levels, slotCount } = layout.rackStructure(rack);
      for (const level of levels) {
        for (const bin of level.bins) {
          binsTotal++;
          if (stock.unitsAt(bin.id) > 0) binsUsed++;
        }
      }
      for (let slot = 0; slot < slotCount; slot++) {
        const column = levels.flatMap((l) =>
          l.bins.filter((b) => b.slotIndex === slot).map((b) => b.id),
        );
        if (!column.length) continue;
        const cell = stock.stats(column);
        max.units = Math.max(max.units, cell.units);
        max.movements = Math.max(max.movements, cell.movements);
        if (max.value.lessThan(cell.value)) max.value = new Decimal(cell.value);
      }
    }

    return {
      warehouse: {
        id: warehouse.id,
        name: warehouse.name,
        code: warehouse.code,
        type: warehouse.type,
        floorWidth: warehouse.floor?.width ?? null,
        floorDepth: warehouse.floor?.depth ?? null,
      },
      items,
      unplaced,
      totals: { unitsOnRacks, binsTotal, binsUsed, unitsToPutAway },
      maxCell: {
        units: max.units,
        value: max.value.toFixed(2),
        movements: max.movements,
      },
      activityDays,
      generatedAt: new Date().toISOString(),
    };
  }

  /** GET /inventory/locations/:locationId/contents */
  async contents(locationId: string) {
    const location = await this.prisma.storageLocation.findUnique({
      where: { id: locationId },
      select: LOCATION_ROW_SELECT,
    });
    if (!location) throw new NotFoundException('Location not found');
    const layout = await this.loadLayout(this.prisma, location.warehouseId);
    const ids = layout.subtree(locationId);

    const [stocks, movements] = await Promise.all([
      this.prisma.locationStock.findMany({
        where: { locationId: { in: ids }, quantity: { gt: 0 } },
        select: {
          quantity: true,
          inventoryLevelId: true,
          inventoryLevel: {
            select: {
              variantId: true,
              unitCost: true,
              defaultLocationId: true,
              variant: {
                select: {
                  sku: true,
                  product: { select: { name: true } },
                  optionValues: {
                    select: {
                      optionValue: {
                        select: {
                          value: true,
                          option: { select: { name: true } },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      }),
      this.prisma.inventoryMovement.findMany({
        where: {
          OR: [{ fromLocationId: { in: ids } }, { toLocationId: { in: ids } }],
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 10,
        select: {
          id: true,
          type: true,
          quantity: true,
          createdAt: true,
          fromLocation: { select: { code: true } },
          toLocation: { select: { code: true } },
          inventoryLevel: { select: { variant: { select: { sku: true } } } },
          performedByUser: {
            select: { firstName: true, lastName: true, email: true },
          },
        },
      }),
    ]);

    // One row per inventory level, summed over the subtree.
    const inSubtree = new Set(ids);
    const rows = new Map<string, (typeof stocks)[number] & { total: number }>();
    for (const s of stocks) {
      const row = rows.get(s.inventoryLevelId);
      if (row) row.total += s.quantity;
      else rows.set(s.inventoryLevelId, { ...s, total: s.quantity });
    }

    return {
      location: {
        id: location.id,
        code: location.code,
        name: location.name,
        type: location.type,
        isActive: location.isActive,
        isPickable: location.isPickable,
        pickSequence: location.pickSequence,
        rackId:
          layout.ancestor(location.id, (l) => l.type === 'RACK')?.id ?? null,
      },
      rows: [...rows.values()]
        .map((r) => {
          const { variant, unitCost, variantId, defaultLocationId } =
            r.inventoryLevel;
          return {
            inventoryLevelId: r.inventoryLevelId,
            variantId,
            sku: variant.sku,
            productName: variant.product.name,
            variantLabel: variantLabel(variant.optionValues),
            quantity: r.total,
            unitCost: new Decimal(unitCost).toFixed(2),
            value: new Decimal(unitCost).mul(r.total).toFixed(2),
            isDefault: !!defaultLocationId && inSubtree.has(defaultLocationId),
          };
        })
        .sort((a, b) => b.quantity - a.quantity || a.sku.localeCompare(b.sku)),
      recentMovements: movements.map((m) => ({
        id: m.id,
        type: m.type,
        quantity: m.quantity,
        sku: m.inventoryLevel.variant.sku,
        fromLocationCode: m.fromLocation?.code ?? null,
        toLocationCode: m.toLocation?.code ?? null,
        createdAt: m.createdAt.toISOString(),
        performedBy: personName(m.performedByUser),
      })),
    };
  }

  /** GET /inventory/warehouses/:warehouseId/put-away */
  async putAway(warehouseId: string) {
    const [, layout, stock] = await Promise.all([
      this.loadWarehouse(this.prisma, warehouseId),
      this.loadLayout(this.prisma, warehouseId),
      this.loadStockRows(this.prisma, warehouseId),
    ]);

    const locations = new Map<string, PutAwayLocation>(
      layout.locations.map((l) => [
        l.id,
        {
          id: l.id,
          code: l.code,
          type: l.type,
          isActive: l.isActive,
          isPickable: l.isPickable,
          pickSequence: l.pickSequence,
          isLeaf: layout.isLeaf(l.id),
          zoneId:
            layout.ancestor(l.id, (a) => a.type === 'ZONE' && a.id !== l.id)
              ?.id ?? null,
        },
      ]),
    );
    const occupied = new Set(stock.map((s) => s.locationId));
    const heldAt = new Map<string, string[]>();
    for (const s of stock) {
      heldAt.set(s.inventoryLevelId, [
        ...(heldAt.get(s.inventoryLevelId) ?? []),
        s.locationId,
      ]);
    }

    const waiting = stock
      .filter((s) =>
        INBOUND_TYPES.includes(layout.byId.get(s.locationId)!.type),
      )
      .sort((a, b) => {
        const la = layout.byId.get(a.locationId)!;
        const lb = layout.byId.get(b.locationId)!;
        return (
          la.pickSequence - lb.pickSequence ||
          la.code.localeCompare(lb.code) ||
          a.sku.localeCompare(b.sku)
        );
      });

    const lines = waiting.map((s) => {
      const suggestion = suggestPutAway(
        {
          sourceLocationId: s.locationId,
          defaultLocationId: s.defaultLocationId,
          heldAt: heldAt.get(s.inventoryLevelId) ?? [],
        },
        { locations, occupied },
      );
      if (suggestion) {
        // Don't hand the same empty bin to two SKUs, and send the same SKU
        // waiting at another dock to the same place.
        occupied.add(suggestion);
        heldAt.set(s.inventoryLevelId, [
          ...(heldAt.get(s.inventoryLevelId) ?? []),
          suggestion,
        ]);
      }
      return {
        locationId: s.locationId,
        locationCode: layout.byId.get(s.locationId)!.code,
        inventoryLevelId: s.inventoryLevelId,
        sku: s.sku,
        productName: s.productName,
        quantity: s.quantity,
        suggestedLocationId: suggestion,
        suggestedLocationCode: suggestion
          ? layout.byId.get(suggestion)!.code
          : null,
      };
    });
    return { lines };
  }

  /**
   * GET /inventory/warehouses/:warehouseId/pick-route[?orderId=]
   * Without orderId: orders with ACTIVE reservations here. With it: the
   * walk, planned exactly like commitOrderReservations will pick it.
   */
  async pickRoute(warehouseId: string, orderId?: string) {
    await this.loadWarehouse(this.prisma, warehouseId);
    if (!orderId) {
      const groups = await this.prisma.stockReservation.groupBy({
        by: ['orderId'],
        where: { warehouseId, status: 'ACTIVE', orderId: { not: null } },
        _count: { _all: true },
        orderBy: { orderId: 'asc' },
      });
      return {
        orders: groups.map((g) => ({
          orderId: g.orderId!,
          lines: g._count._all,
        })),
      };
    }
    return this.orderRoute(warehouseId, orderId);
  }

  private async orderRoute(warehouseId: string, orderId: string) {
    const reservations = await this.prisma.stockReservation.findMany({
      where: { orderId, warehouseId, status: 'ACTIVE' },
      // Same order as InventoryService.commitOrderReservations.
      orderBy: [{ inventoryLevelId: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        inventoryLevelId: true,
        quantity: true,
        variant: { select: { sku: true, product: { select: { name: true } } } },
      },
    });
    if (!reservations.length) {
      throw new NotFoundException(
        `Order ${orderId} has no active reservations at this warehouse`,
      );
    }

    const levelIds = [...new Set(reservations.map((r) => r.inventoryLevelId))];
    const [warehouse, layout, levels, stocks] = await Promise.all([
      this.loadWarehouse(this.prisma, warehouseId),
      this.loadLayout(this.prisma, warehouseId),
      this.prisma.inventoryLevel.findMany({
        where: { id: { in: levelIds } },
        select: { id: true, defaultLocationId: true },
      }),
      this.prisma.locationStock.findMany({
        where: { inventoryLevelId: { in: levelIds }, quantity: { gt: 0 } },
        select: { inventoryLevelId: true, locationId: true, quantity: true },
      }),
    ]);
    const defaults = new Map(levels.map((l) => [l.id, l.defaultLocationId]));
    // Rack quantities as the picker will find them, drawn down as we go.
    const left = new Map(
      stocks.map((s) => [`${s.inventoryLevelId}:${s.locationId}`, s]),
    );

    type Stop = {
      locationId: string;
      locationCode: string;
      rackId: string | null;
      inventoryLevelId: string;
      sku: string;
      productName: string;
      quantity: number;
      point: Point | null;
    };
    const stops: Stop[] = [];
    const shortages: {
      inventoryLevelId: string;
      sku: string;
      quantity: number;
    }[] = [];
    const binSlots = layout.binSlots();

    for (const r of reservations) {
      const rackStocks = [...left.values()]
        .filter((s) => s.inventoryLevelId === r.inventoryLevelId)
        .map((s) => {
          const loc = layout.byId.get(s.locationId)!;
          return {
            locationId: s.locationId,
            quantity: s.quantity,
            code: loc.code,
            isPickable: loc.isPickable,
            pickSequence: loc.pickSequence,
          };
        });
      const plan = planPick(
        { defaultLocationId: defaults.get(r.inventoryLevelId) ?? null },
        r.quantity,
        rackStocks,
      );
      for (const leg of plan.legs) {
        left.get(`${r.inventoryLevelId}:${leg.locationId}`)!.quantity -=
          leg.quantity;
        const loc = layout.byId.get(leg.locationId)!;
        stops.push({
          locationId: loc.id,
          locationCode: loc.code,
          rackId: layout.ancestor(loc.id, (l) => l.type === 'RACK')?.id ?? null,
          inventoryLevelId: r.inventoryLevelId,
          sku: r.variant.sku,
          productName: r.variant.product.name,
          quantity: leg.quantity,
          point: this.stopPointFor(loc.id, layout, binSlots, warehouse.floor),
        });
      }
      if (plan.shortfall > 0) {
        shortages.push({
          inventoryLevelId: r.inventoryLevelId,
          sku: r.variant.sku,
          quantity: plan.shortfall,
        });
      }
    }

    const seq = (id: string) => layout.byId.get(id)!;
    stops.sort(
      (a, b) =>
        seq(a.locationId).pickSequence - seq(b.locationId).pickSequence ||
        a.locationCode.localeCompare(b.locationCode) ||
        a.sku.localeCompare(b.sku),
    );

    const base = this.routeBase(layout);
    return {
      orderId,
      start: base?.point ?? null,
      end: base?.point ?? null,
      startLocationCode: base?.code ?? null,
      stops: stops.map((s, i) => ({ sequence: i + 1, ...s })),
      shortages,
    };
  }

  // ═════════════════════════════════════════════════
  //   LAYOUT WRITES (never write movements)
  // ═════════════════════════════════════════════════

  /** PUT /inventory/warehouses/:warehouseId/floor-size */
  async setFloorSize(warehouseId: string, dto: FloorSizeDto) {
    const floor: Floor = {
      width: round2(dto.floorWidth),
      depth: round2(dto.floorDepth),
    };
    return this.prisma.$transaction(async (tx) => {
      await this.lockFloor(tx, warehouseId);
      await this.loadWarehouse(tx, warehouseId);
      const layout = await this.loadLayout(tx, warehouseId);
      const outside = layout
        .floorItems()
        .filter((l) => {
          const p = placementOf(l);
          return p && !fitsFloor(boundingBox(p, shapeKind(l.type)), floor);
        })
        .map((l) => l.code);
      if (outside.length) {
        throw new ConflictException(
          `${listCodes(outside)} would fall outside a ${floor.width} × ${floor.depth} m floor. Move ${outside.length === 1 ? 'it' : 'them'} first.`,
        );
      }
      await tx.warehouse.update({
        where: { id: warehouseId },
        data: { floorWidth: floor.width, floorDepth: floor.depth },
      });
      return { floorWidth: floor.width, floorDepth: floor.depth };
    });
  }

  /** PATCH /inventory/locations/:locationId/placement */
  async setPlacement(locationId: string, body: PlacementBodyDto) {
    const warehouseId = await this.warehouseOf(locationId);
    return this.prisma.$transaction(async (tx) => {
      await this.lockFloor(tx, warehouseId);
      const { layout, location, floor } = await this.loadFloorItem(
        tx,
        locationId,
      );

      if (body.remove) {
        await tx.storageLocation.update({
          where: { id: locationId },
          data: {
            mapCenterX: null,
            mapCenterY: null,
            mapLength: null,
            mapDepth: null,
          },
        });
        return { placement: null, box: null };
      }

      // The DTO guarantees every field is present without `remove`.
      const placement = normalizePlacement(body as Placement);
      this.assertPlaceable(location, placement, layout, floor);
      await this.savePlacement(tx, locationId, placement);
      return {
        placement,
        box: boundingBox(placement, shapeKind(location.type)),
      };
    });
  }

  /** POST /inventory/locations/:locationId/rotate */
  async rotate(locationId: string, direction: RotateDirection) {
    const warehouseId = await this.warehouseOf(locationId);
    return this.prisma.$transaction(async (tx) => {
      await this.lockFloor(tx, warehouseId);
      const { layout, location, floor } = await this.loadFloorItem(
        tx,
        locationId,
      );
      if (AREA_TYPES.includes(location.type)) {
        throw new BadRequestException(
          `${location.code} is a ${location.type.toLowerCase()}; zones and aisles always face north and can't be rotated`,
        );
      }
      const current = placementOf(location);
      if (!current) {
        throw new ConflictException(
          `Place ${location.code} on the floor plan before rotating it`,
        );
      }
      const area = this.requireFloor(floor);

      const turned = rotate(current, direction);
      const obstacles = layout.obstacles(location.id).map((o) => o.box);
      let placement = turned;
      let shifted = false;
      if (!isFree(turned, area, obstacles)) {
        const nudged = nudgeToFree(turned, area, obstacles, ROTATE_NUDGE_LIMIT);
        if (!nudged) {
          throw new ConflictException(
            `${location.code} has no room to turn: ${this.blockReason(location, turned, layout, area)}, and there's no free spot within ${ROTATE_NUDGE_LIMIT} m.`,
          );
        }
        placement = nudged;
        shifted = true;
      }

      await this.savePlacement(tx, location.id, placement);
      return {
        placement,
        box: boundingBox(placement),
        pickFace:
          location.type === 'RACK' ? pickFace(placement.rotation) : null,
        shifted,
      };
    });
  }

  /** POST /inventory/warehouses/:warehouseId/racks */
  async createRack(warehouseId: string, dto: CreateRackDto) {
    return this.prisma.$transaction(async (tx) => {
      await this.lockFloor(tx, warehouseId);
      const warehouse = await this.loadWarehouse(tx, warehouseId);
      const layout = await this.loadLayout(tx, warehouseId);

      const zone = dto.zoneId ? layout.byId.get(dto.zoneId) : undefined;
      if (dto.zoneId && !zone) {
        throw new NotFoundException('Zone not found in this warehouse');
      }
      if (zone && zone.type !== 'ZONE') {
        throw new BadRequestException(`${zone.code} is not a zone`);
      }

      const conflict = rackCodeConflict(
        dto.code,
        layout.locations.map((l) => l.code),
      );
      if (conflict) {
        throw new ConflictException(
          conflict === dto.code
            ? `Code ${dto.code} is already used in this warehouse`
            : `Code ${dto.code} is taken: ${conflict} already exists and would clash with this rack's bins`,
        );
      }

      const placement = dto.placement
        ? normalizePlacement(dto.placement)
        : this.autoPlace(dto, warehouse.floor, layout, zone);
      this.assertPlaceable(
        draftRow(warehouseId, dto.code, 'RACK'),
        placement,
        layout,
        warehouse.floor,
      );

      const plan = buildRackPlan(
        dto.code,
        dto.levels,
        dto.binsPerLevel,
        nextPickBlock(layout.locations.map((l) => l.pickSequence)),
      );
      const rack = await tx.storageLocation.create({
        data: {
          warehouseId,
          code: plan.code,
          name: dto.name ?? null,
          type: 'RACK',
          parentId: zone?.id ?? null,
          isPickable: false,
          pickSequence: plan.pickSequence,
          ...placementData(placement),
        },
        select: { id: true },
      });
      for (const shelf of plan.shelves) {
        await tx.storageLocation.create({
          data: {
            warehouseId,
            code: shelf.code,
            type: 'SHELF',
            parentId: rack.id,
            isPickable: false,
            pickSequence: shelf.pickSequence,
            levelNumber: shelf.levelNumber,
            children: {
              create: shelf.bins.map((bin) => ({
                warehouseId,
                code: bin.code,
                type: 'BIN' as const,
                isPickable: true,
                pickSequence: bin.pickSequence,
                slotIndex: bin.slotIndex,
              })),
            },
          },
        });
      }

      const fresh = await this.loadLayout(tx, warehouseId);
      return this.toFloorItem(
        fresh.byId.get(rack.id)!,
        fresh,
        new StockIndex([], []),
      );
    });
  }

  // ═════════════════════════════════════════════════
  //   HELPERS
  // ═════════════════════════════════════════════════

  private toFloorItem(
    loc: LocationRow,
    layout: WarehouseLayout,
    stock: StockIndex,
  ) {
    const placement = placementOf(loc)!;
    const isRack = loc.type === 'RACK';
    const structure = isRack ? layout.rackStructure(loc) : null;
    return {
      id: loc.id,
      code: loc.code,
      name: loc.name,
      type: loc.type,
      parentId: loc.parentId,
      isActive: loc.isActive,
      isPickable: loc.isPickable,
      pickSequence: loc.pickSequence,
      placement,
      box: boundingBox(placement, shapeKind(loc.type)),
      pickFace: isRack ? pickFace(placement.rotation) : null,
      slotCount: structure?.slotCount ?? null,
      levels:
        structure?.levels.map((level) => ({
          id: level.id,
          levelNumber: level.levelNumber,
          bins: level.bins.map((bin) => ({
            ...bin,
            stock: stock.stats([bin.id]),
            topSkus: stock.topSkus(bin.id),
          })),
        })) ?? null,
      stock: stock.stats(layout.subtree(loc.id)),
    };
  }

  /** Floor fit + 0.5 m clearance from other racks, docks and staging areas. */
  private assertPlaceable(
    location: LocationRow,
    placement: Placement,
    layout: WarehouseLayout,
    floor: Floor | null,
  ) {
    const area = this.requireFloor(floor);
    const kind = shapeKind(location.type);
    if (kind === 'area' && placement.rotation !== 0) {
      throw new BadRequestException(
        'Zones and aisles always use rotation 0 (length runs west to east)',
      );
    }
    const box = boundingBox(placement, kind);
    if (!fitsFloor(box, area)) {
      throw new ConflictException(
        `${location.code} doesn't fit on the ${area.width} × ${area.depth} m floor`,
      );
    }
    if (kind === 'area') return;
    const hit = layout.obstacles(location.id).find((o) => overlaps(box, o.box));
    if (hit) {
      throw new ConflictException(
        `${location.code} would touch ${hit.code}. Leave at least ${CLEARANCE} m between racks.`,
      );
    }
  }

  private blockReason(
    location: LocationRow,
    placement: Placement,
    layout: WarehouseLayout,
    floor: Floor,
  ) {
    const box = boundingBox(placement);
    const hits = layout
      .obstacles(location.id)
      .filter((o) => overlaps(box, o.box))
      .map((o) => o.code);
    if (hits.length) return `turned, it would touch ${listCodes(hits)}`;
    return fitsFloor(box, floor)
      ? 'turned, it would be blocked'
      : 'turned, it would stick out past the wall';
  }

  private autoPlace(
    dto: CreateRackDto,
    floor: Floor | null,
    layout: WarehouseLayout,
    zone?: LocationRow,
  ): Placement {
    const area = this.requireFloor(floor);
    const size = {
      length: round2(dto.length ?? dto.binsPerLevel * BIN_LENGTH),
      depth: round2(dto.depth ?? DEFAULT_RACK_DEPTH),
      rotation: dto.rotation,
    };
    const obstacles = layout.obstacles().map((o) => o.box);
    const zonePlacement = zone ? placementOf(zone) : null;
    const zoneBox: Box | undefined = zonePlacement
      ? boundingBox(zonePlacement, 'area')
      : undefined;
    const spot =
      (zoneBox && findFreeSpot(size, area, obstacles, zoneBox)) ||
      findFreeSpot(size, area, obstacles);
    if (!spot) {
      throw new ConflictException(
        `No free space for a ${size.length} × ${size.depth} m rack. Make the floor bigger or move other racks.`,
      );
    }
    return spot;
  }

  private stopPointFor(
    locationId: string,
    layout: WarehouseLayout,
    binSlots: Map<string, { rackId: string; slotIndex: number }>,
    floor: Floor | null,
  ): Point | null {
    const slot = binSlots.get(locationId);
    const item = slot
      ? layout.byId.get(slot.rackId)
      : layout.floorItemOf(locationId);
    const placement = item ? placementOf(item) : null;
    if (!item || !placement) return null;
    if (item.type !== 'RACK') {
      return boxCenter(boundingBox(placement, shapeKind(item.type)));
    }
    const { slotCount } = layout.rackStructure(item);
    // Stock on a rack or shelf that has bins: stand at the middle slot.
    const index = slot?.slotIndex ?? Math.floor((slotCount - 1) / 2);
    return stopPoint(placement, index, slotCount, floor);
  }

  /** Where a pick walk starts and ends: packing, else receiving. */
  private routeBase(layout: WarehouseLayout) {
    for (const type of ['PACKING', 'RECEIVING'] as const) {
      const loc = layout
        .floorItems()
        .find((l) => l.type === type && placementOf(l));
      if (loc) {
        return {
          code: loc.code,
          point: boxCenter(boundingBox(placementOf(loc)!, shapeKind(loc.type))),
        };
      }
    }
    return null;
  }

  private requireFloor(floor: Floor | null): Floor {
    if (!floor) {
      throw new ConflictException(
        "Set the warehouse's floor size before placing anything on the map",
      );
    }
    return floor;
  }

  private async loadFloorItem(tx: Db, locationId: string) {
    const location = await tx.storageLocation.findUnique({
      where: { id: locationId },
      select: {
        ...LOCATION_ROW_SELECT,
        warehouse: { select: { floorWidth: true, floorDepth: true } },
      },
    });
    if (!location) throw new NotFoundException('Location not found');
    const layout = await this.loadLayout(tx, location.warehouseId);
    const row = layout.byId.get(locationId)!;
    if (!layout.isFloorLevel(row)) {
      throw new BadRequestException(
        row.type === 'SHELF' || row.type === 'BIN'
          ? `${row.code} is a ${row.type.toLowerCase()}; it moves with its rack`
          : `${row.code} isn't a floor-level location (it sits inside another ${layout.byId.get(row.parentId!)?.type.toLowerCase() ?? 'location'})`,
      );
    }
    return { layout, location: row, floor: floorOf(location.warehouse) };
  }

  private async warehouseOf(locationId: string) {
    const loc = await this.prisma.storageLocation.findUnique({
      where: { id: locationId },
      select: { warehouseId: true },
    });
    if (!loc) throw new NotFoundException('Location not found');
    return loc.warehouseId;
  }

  private async savePlacement(tx: Db, id: string, placement: Placement) {
    await tx.storageLocation.update({
      where: { id },
      data: placementData(placement),
    });
  }

  /** Serialises layout edits per warehouse (collision checks race otherwise). */
  private async lockFloor(tx: Prisma.TransactionClient, warehouseId: string) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`floor-plan:${warehouseId}`}))`;
  }

  private async loadWarehouse(db: Db, warehouseId: string) {
    const w = await db.warehouse.findUnique({
      where: { id: warehouseId },
      select: {
        id: true,
        name: true,
        code: true,
        type: true,
        floorWidth: true,
        floorDepth: true,
      },
    });
    if (!w) throw new NotFoundException('Warehouse not found');
    return { ...w, floor: floorOf(w) };
  }

  private async loadLayout(db: Db, warehouseId: string) {
    const locations = await db.storageLocation.findMany({
      where: { warehouseId },
      select: LOCATION_ROW_SELECT,
    });
    return new WarehouseLayout(locations);
  }

  private async loadStockRows(
    db: Db,
    warehouseId: string,
  ): Promise<StockRow[]> {
    const rows = await db.locationStock.findMany({
      where: { warehouseId, quantity: { gt: 0 } },
      select: {
        locationId: true,
        quantity: true,
        inventoryLevelId: true,
        inventoryLevel: {
          select: {
            variantId: true,
            unitCost: true,
            defaultLocationId: true,
            variant: {
              select: { sku: true, product: { select: { name: true } } },
            },
          },
        },
      },
    });
    return rows.map((r) => ({
      locationId: r.locationId,
      inventoryLevelId: r.inventoryLevelId,
      variantId: r.inventoryLevel.variantId,
      sku: r.inventoryLevel.variant.sku,
      productName: r.inventoryLevel.variant.product.name,
      defaultLocationId: r.inventoryLevel.defaultLocationId,
      quantity: r.quantity,
      unitCost: r.inventoryLevel.unitCost,
    }));
  }

  /** Stock rows plus movement counts per (from, to) over the last N days. */
  private async loadStock(db: Db, warehouseId: string, activityDays: number) {
    const since = new Date(Date.now() - activityDays * 24 * 60 * 60 * 1000);
    const [rows, groups] = await Promise.all([
      this.loadStockRows(db, warehouseId),
      db.inventoryMovement.groupBy({
        by: ['fromLocationId', 'toLocationId'],
        where: {
          createdAt: { gte: since },
          OR: [
            { fromLocation: { warehouseId } },
            { toLocation: { warehouseId } },
          ],
        },
        _count: { _all: true },
      }),
    ]);
    const pairs: MovementPair[] = groups.map((g) => ({
      fromLocationId: g.fromLocationId,
      toLocationId: g.toLocationId,
      count: g._count._all,
    }));
    return new StockIndex(rows, pairs);
  }
}

// ─── Module helpers ───────────────────────────────────────────

function normalizePlacement(p: Placement): Placement {
  return {
    centerX: round2(p.centerX),
    centerY: round2(p.centerY),
    length: round2(p.length),
    depth: round2(p.depth),
    rotation: p.rotation,
  };
}

function placementData(p: Placement) {
  return {
    mapCenterX: p.centerX,
    mapCenterY: p.centerY,
    mapLength: p.length,
    mapDepth: p.depth,
    mapRotation: p.rotation,
  };
}

/** A not-yet-saved location, for running placement checks before create. */
function draftRow(
  warehouseId: string,
  code: string,
  type: LocationRow['type'],
): LocationRow {
  return {
    id: '',
    warehouseId,
    code,
    name: null,
    type,
    parentId: null,
    isActive: true,
    isPickable: false,
    pickSequence: 0,
    levelNumber: null,
    slotIndex: null,
    mapCenterX: null,
    mapCenterY: null,
    mapLength: null,
    mapDepth: null,
    mapRotation: 0,
  };
}

function listCodes(codes: string[]) {
  if (codes.length <= 3) return codes.join(', ');
  return `${codes.slice(0, 3).join(', ')} and ${codes.length - 3} more`;
}

function variantLabel(
  optionValues: { optionValue: { value: string; option: { name: string } } }[],
) {
  if (!optionValues.length) return 'Standard';
  return [...optionValues]
    .sort((a, b) =>
      a.optionValue.option.name.localeCompare(b.optionValue.option.name),
    )
    .map((ov) => ov.optionValue.value)
    .join(', ');
}

function personName(
  user: {
    firstName: string | null;
    lastName: string | null;
    email: string;
  } | null,
) {
  if (!user) return null;
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ');
  return name || user.email;
}
