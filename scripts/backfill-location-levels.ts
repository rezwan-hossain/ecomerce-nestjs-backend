/**
 * Fills in StorageLocation.levelNumber (shelves) and slotIndex (bins) for
 * locations created before the rack map existed.
 *
 *   npm run backfill:location-levels -- [--dry-run]
 *
 * - SHELF children of a RACK get levelNumber 1..n
 * - BIN children of a SHELF (or of a RACK with no shelves) get slotIndex 0..n
 * Rows that already have a value keep it; the rest are numbered in walk
 * order (pickSequence, then code) into the unused numbers — the same rule
 * the rack map uses to display them. Idempotent: a second run changes
 * nothing.
 */
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import { numbered } from '../src/modules/inventory/floor-plan/rack-layout';

const dryRun = process.argv.includes('--dry-run');
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

type Row = Awaited<ReturnType<typeof loadLocations>>[number];
type Change = {
  id: string;
  code: string;
  field: 'levelNumber' | 'slotIndex';
  value: number;
};

function loadLocations() {
  return prisma.storageLocation.findMany({
    select: {
      id: true,
      code: true,
      type: true,
      parentId: true,
      pickSequence: true,
      levelNumber: true,
      slotIndex: true,
      warehouse: { select: { code: true } },
    },
  });
}

function plan(rows: Row[]): Change[] {
  const children = new Map<string, Row[]>();
  for (const row of rows) {
    if (!row.parentId) continue;
    children.set(row.parentId, [...(children.get(row.parentId) ?? []), row]);
  }
  const changes: Change[] = [];
  const number = (siblings: Row[], field: Change['field'], first: number) => {
    for (const { node, number: value } of numbered(
      siblings,
      (n) => n[field],
      first,
    )) {
      if (node[field] === null) {
        changes.push({
          id: node.id,
          code: `${node.warehouse.code}/${node.code}`,
          field,
          value,
        });
      }
    }
  };

  for (const row of rows) {
    const kids = children.get(row.id) ?? [];
    if (row.type === 'RACK') {
      const shelves = kids.filter((k) => k.type === 'SHELF');
      if (shelves.length) number(shelves, 'levelNumber', 1);
      else
        number(
          kids.filter((k) => k.type === 'BIN'),
          'slotIndex',
          0,
        );
    } else if (row.type === 'SHELF') {
      number(
        kids.filter((k) => k.type === 'BIN'),
        'slotIndex',
        0,
      );
    }
  }
  return changes;
}

async function main() {
  const changes = plan(await loadLocations());
  if (!changes.length) {
    console.log('Nothing to backfill: every shelf and bin is numbered.');
    return;
  }
  for (const c of changes) {
    console.log(`  ${c.code.padEnd(28)} ${c.field} → ${c.value}`);
  }
  if (dryRun) {
    console.log(`Dry run: ${changes.length} change(s) not written.`);
    return;
  }
  await prisma.$transaction(
    changes.map((c) =>
      prisma.storageLocation.update({
        where: { id: c.id },
        data: { [c.field]: c.value },
      }),
    ),
  );
  console.log(`${changes.length} location(s) updated.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
