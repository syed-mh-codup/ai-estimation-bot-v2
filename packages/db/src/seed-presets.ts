/**
 * Preset library seed (WS1-10) — imports the 45 presets (P01–P45) from
 * `docs/Estimate Presets (ISM).xlsx` (`📋 Master Database` sheet) into
 * Preset + PresetVersion(version=1, active=true).
 *
 * Run: pnpm --filter @repo/db db:seed:presets   (idempotent — upserts by id)
 *
 * NOT part of the fast bootstrap seed or the e2e global-setup (45 rows nobody's
 * test needs). Taxonomy linking (`taxonomyKey`) is a follow-up step
 * (`db:seed:taxonomy`).
 *
 * Embeddings are NOT written here — they're a paid OpenRouter call. Run
 * `pnpm db:embed:presets` afterwards. Until you do, the Archivist cannot see
 * these presets at all: `queryPresetsByVector` filters on
 * `embedding IS NOT NULL`, so an un-embedded preset silently never matches.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { PrismaClient } from './generated/client/index.js';

// tsx doesn't auto-load .env and Prisma Client doesn't read it at runtime.
if (!process.env['DATABASE_URL']) {
  try {
    const envFile = readFileSync(path.resolve(__dirname, '../.env'), 'utf8');
    for (const line of envFile.split('\n')) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && m[1] && !process.env[m[1]]) {
        process.env[m[1]] = m[2]!.replace(/^["']|["']$/g, '');
      }
    }
  } catch {
    // Prisma will report a clear error if the URL is missing.
  }
}

const XLSX_PATH =
  process.argv[2] ??
  path.resolve(__dirname, '../../../docs/Estimate Presets (ISM).xlsx');
const SHEET_NAME = '📋 Master Database';
const HEADER_ROWS = 3; // title, group super-headers, column headers

// ─── Column indices (see header row in the sheet) ────────────────────────────
const COL = {
  id: 0,
  category: 1,
  name: 2,
  description: 3,
  beHours: 4,
  feHours: 5,
  // total: 6 (derived — not stored)
  platforms: 7,
  reqType: 8,
  keywords: 9,
  userStoryTags: 10,
  projectSizeFit: 11,
  integrationCount: 12,
  dataVolume: 13,
  phase: 14,
  requires: 15,
  blocks: 16,
  canParallel: 17,
  aiAssist: 18,
  risk: 19,
  spikeNeeded: 20,
  notes: 21,
} as const;

type Cell = string | number | null | undefined;

const str = (v: Cell): string => (v == null ? '' : String(v).trim());
const toInt = (v: Cell): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : 0;
};
const splitList = (v: Cell): string[] =>
  str(v)
    .split(/[|,]/)
    .map((s) => s.trim())
    .filter(Boolean);
const yesNo = (v: Cell): boolean => str(v).toLowerCase() === 'yes';

// Sheet uses None/Medium/High; the DataVolume enum is NONE/LOW/HIGH (no MEDIUM).
// Ordinal mapping preserves three distinct buckets; overridable in the UI later.
const DATA_VOLUME: Record<string, 'NONE' | 'LOW' | 'HIGH'> = {
  none: 'NONE',
  low: 'LOW',
  medium: 'LOW',
  high: 'HIGH',
};
const LEVEL: Record<string, 'LOW' | 'MEDIUM' | 'HIGH'> = {
  low: 'LOW',
  medium: 'MEDIUM',
  high: 'HIGH',
};
const PHASE: Record<string, 'FOUNDATION' | 'CORE' | 'ENHANCEMENT'> = {
  foundation: 'FOUNDATION',
  core: 'CORE',
  enhancement: 'ENHANCEMENT',
};

async function main() {
  const wb = XLSX.readFile(XLSX_PATH);
  const ws = wb.Sheets[SHEET_NAME];
  if (!ws) {
    throw new Error(`Sheet "${SHEET_NAME}" not found. Sheets: ${wb.SheetNames.join(', ')}`);
  }
  const aoa = XLSX.utils.sheet_to_json<Cell[]>(ws, { header: 1, defval: null, blankrows: false });
  const rows = aoa.slice(HEADER_ROWS).filter((r) => /^P\d+$/.test(str(r[COL.id])));

  const prisma = new PrismaClient();
  let count = 0;
  try {
    for (const r of rows) {
      const id = str(r[COL.id]);
      const data = {
        category: str(r[COL.category]),
        name: str(r[COL.name]),
        description: str(r[COL.description]),
        beHours: toInt(r[COL.beHours]),
        feHours: toInt(r[COL.feHours]),
        platforms: splitList(r[COL.platforms]),
        reqType: str(r[COL.reqType]),
        keywords: splitList(r[COL.keywords]),
        userStoryTags: splitList(r[COL.userStoryTags]),
        projectSizeFit: splitList(r[COL.projectSizeFit]),
        integrationCount: toInt(r[COL.integrationCount]),
        dataVolume: DATA_VOLUME[str(r[COL.dataVolume]).toLowerCase()] ?? 'NONE',
        phase: PHASE[str(r[COL.phase]).toLowerCase()] ?? 'CORE',
        requires: splitList(r[COL.requires]),
        blocks: splitList(r[COL.blocks]),
        canParallel: yesNo(r[COL.canParallel]),
        aiAssist: LEVEL[str(r[COL.aiAssist]).toLowerCase()] ?? 'LOW',
        risk: LEVEL[str(r[COL.risk]).toLowerCase()] ?? 'LOW',
        spikeNeeded: yesNo(r[COL.spikeNeeded]),
        notes: str(r[COL.notes]),
      };

      await prisma.preset.upsert({ where: { id }, update: {}, create: { id } });
      await prisma.presetVersion.upsert({
        where: { presetId_version: { presetId: id, version: 1 } },
        update: { ...data, active: true },
        create: {
          presetId: id,
          version: 1,
          active: true,
          ...data,
          changeReason: 'xlsx import v2',
        },
      });
      count += 1;
    }
    // eslint-disable-next-line no-console
    console.log(`Preset seed complete: ${count} presets imported (P01–P${String(count).padStart(2, '0')}).`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
