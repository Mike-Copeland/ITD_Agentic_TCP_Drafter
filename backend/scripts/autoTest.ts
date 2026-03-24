/**
 * Automated Test Suite v2: Geocode-snapped coordinates, server log parsing.
 * Usage: npx tsx scripts/autoTest.ts
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const BASE = 'http://localhost:3001';

interface TestCase {
  id: number;
  name: string;
  category: string;
  start: { lat: number; lng: number };
  end: { lat: number; lng: number };
  operationType: string;
}

// Known-good coordinates ON the target roads (verified via Google Maps)
const TESTS: TestCase[] = [
  // === INTERSTATE / FREEWAY ===
  { id: 1,  name: 'I-84 Meridian', category: 'interstate',
    start: { lat: 43.6088, lng: -116.3924 }, end: { lat: 43.6088, lng: -116.3824 }, operationType: 'Single Lane Closure' },
  { id: 2,  name: 'I-86 American Falls', category: 'interstate',
    start: { lat: 42.7735, lng: -112.8752 }, end: { lat: 42.7735, lng: -112.8552 }, operationType: 'Single Lane Closure' },
  { id: 3,  name: 'I-90 Coeur d\'Alene', category: 'interstate',
    start: { lat: 47.6770, lng: -116.7950 }, end: { lat: 47.6770, lng: -116.7750 }, operationType: 'Double Lane Closure' },

  // === URBAN HIGH SPEED ===
  { id: 4,  name: 'US-20/26 Eagle (State St)', category: 'urban_high',
    start: { lat: 43.6625, lng: -116.3535 }, end: { lat: 43.6625, lng: -116.3385 }, operationType: 'Single Lane Closure' },
  { id: 5,  name: 'US-93 Twin Falls (Blue Lakes)', category: 'urban_high',
    start: { lat: 42.5705, lng: -114.4640 }, end: { lat: 42.5780, lng: -114.4640 }, operationType: 'Single Lane Closure' },
  { id: 6,  name: 'US-20 Idaho Falls (Broadway)', category: 'urban_high',
    start: { lat: 43.4665, lng: -112.0430 }, end: { lat: 43.4665, lng: -112.0280 }, operationType: 'Double Lane Closure' },

  // === URBAN LOW SPEED ===
  { id: 7,  name: 'SH-75 Ketchum (Main St)', category: 'urban_low',
    start: { lat: 43.6808, lng: -114.3637 }, end: { lat: 43.6840, lng: -114.3637 }, operationType: 'Single Lane Closure' },
  { id: 8,  name: 'US-30 Pocatello (5th Ave)', category: 'urban_low',
    start: { lat: 42.8713, lng: -112.4455 }, end: { lat: 42.8713, lng: -112.4355 }, operationType: 'Full Road Closure' },
  { id: 9,  name: 'SH-44 Middleton', category: 'urban_low',
    start: { lat: 43.7068, lng: -116.6205 }, end: { lat: 43.7068, lng: -116.6105 }, operationType: 'Shoulder Work' },

  // === RURAL ===
  { id: 10, name: 'US-95 S of Moscow', category: 'rural',
    start: { lat: 46.6900, lng: -116.9850 }, end: { lat: 46.6975, lng: -116.9850 }, operationType: 'Single Lane Closure' },
  { id: 11, name: 'SH-8 near Troy', category: 'rural',
    start: { lat: 46.7370, lng: -116.7700 }, end: { lat: 46.7370, lng: -116.7500 }, operationType: 'Mobile Operations' },
  { id: 12, name: 'SH-33 near Driggs', category: 'rural',
    start: { lat: 43.7240, lng: -111.1110 }, end: { lat: 43.7290, lng: -111.1110 }, operationType: 'Shoulder Work' },

  // === MOUNTAIN / CANYON ===
  { id: 13, name: 'SH-55 Banks-Lowman', category: 'mountain',
    start: { lat: 44.0810, lng: -115.9800 }, end: { lat: 44.0880, lng: -115.9800 }, operationType: 'Single Lane Closure' },
  { id: 14, name: 'US-95 Riggins Canyon', category: 'mountain',
    start: { lat: 45.4180, lng: -116.3190 }, end: { lat: 45.4250, lng: -116.3190 }, operationType: 'Single Lane Closure' },
  { id: 15, name: 'SH-21 Idaho City', category: 'mountain',
    start: { lat: 43.8280, lng: -115.8350 }, end: { lat: 43.8350, lng: -115.8350 }, operationType: 'Mobile Operations' },
];

interface TestResult {
  id: number; name: string; category: string; operationType: string;
  status: 'pass' | 'fail' | 'error';
  timeMs: number;
  startCoords?: { lat: number; lng: number };
  road?: string; speed?: number; aadt?: number; terrain?: string;
  funcClass?: string; lanes?: number; crossStreets?: number;
  taCode?: string; taDescription?: string;
  compliancePass?: number; complianceTotal?: number;
  complianceFailures?: string[];
  corrections?: string[];
  sheets?: number; pdfKB?: number;
  error?: string;
}

// Collect server logs between test runs
let serverLogBuffer = '';
function captureServerLog(text: string) { serverLogBuffer += text; }

async function runTest(test: TestCase): Promise<TestResult> {
  const t0 = Date.now();
  try {
    const startCoords = test.start;
    const endCoords = test.end;

    // Step 1: Site context
    const ctxRes = await fetch(`${BASE}/api/site-context`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ startCoords, endCoords, operationType: test.operationType }),
    });
    if (!ctxRes.ok) throw new Error(`Site context: ${ctxRes.status}`);
    const ctx = await ctxRes.json() as any;

    const speed = ctx.itdSpeedLimit || 55;
    const wzSpeed = speed >= 55 ? speed - 10 : speed - 5;

    // Step 2: Generate plan
    const genRes = await fetch(`${BASE}/api/generate-plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        blueprint: {
          primary_approach: [
            { sign_code: 'W20-1', distance_ft: 500, label: 'ROAD WORK AHEAD' },
            { sign_code: 'W20-4', distance_ft: 350, label: 'ONE LANE ROAD AHEAD' },
            { sign_code: 'W20-7a', distance_ft: 200, label: 'FLAGGER AHEAD' },
          ],
          opposing_approach: [
            { sign_code: 'W20-1', distance_ft: 500, label: 'ROAD WORK AHEAD' },
          ],
          taper: { length_ft: 50, device_type: 'Cones' },
          downstream_taper: { length_ft: 50 },
          engineering_notes: `Auto-test #${test.id}: ${test.name}`,
        },
        startCoords, endCoords,
        staticMapBase64: ctx.staticMapBase64 || '',
        normalSpeed: speed, workZoneSpeed: wzSpeed,
        laneWidth: ctx.itdLaneWidth || 12,
        operationType: test.operationType,
        operationTypes: [test.operationType],
        duration: 'Short-term (<= 3 days)',
        routeDistanceFt: ctx.routeDistanceFt || 0,
        roadName: ctx.roadName || '',
        positionedCrossStreets: ctx.positionedCrossStreets || [],
        itdTerrain: ctx.itdTerrain || '',
        itdFuncClass: ctx.itdFuncClass || '',
        itdTotalLanes: ctx.itdTotalLanes || 0,
        itdAADT: ctx.itdAADT || 0,
        itdTruckPct: ctx.itdTruckPct || 0,
        itdCrashCount: ctx.itdCrashCount || 0,
        itdBridges: ctx.itdBridges || [],
        maxGradePercent: ctx.maxGradePercent || 0,
      }),
    });

    if (!genRes.ok) throw new Error(`Generate: ${genRes.status} ${(await genRes.text()).substring(0, 200)}`);

    const blob = await genRes.arrayBuffer();
    const zipBuf = Buffer.from(blob);

    // Extract audit log from ZIP — find the text content between known markers
    const raw = zipBuf.toString('latin1'); // Use latin1 to avoid UTF-8 mangling of binary
    const auditStart = raw.indexOf('Engineering Generation Log');
    const auditEnd = raw.indexOf('PE Agent Engineering Notes:');
    const auditSection = auditStart >= 0 && auditEnd >= 0 ? raw.substring(auditStart, auditEnd + 500) : '';

    // Parse compliance
    const compMatch = auditSection.match(/Result: (\d+)\/(\d+) checks passed/);
    const failures: string[] = [];
    const failRx = /\[FAIL\] ([^\n\r]+)/g;
    let m; while ((m = failRx.exec(auditSection)) !== null) failures.push(m[1]!.trim());
    const corrLines: string[] = [];
    const corrRx = /  (\w[^:]+): PE="([^"]+)"[^C]*Corrected="([^"]+)"/g;
    while ((m = corrRx.exec(auditSection)) !== null) corrLines.push(`${m[1]}: ${m[2]} → ${m[3]}`);
    const taMatch = auditSection.match(/Typical Application: (TA-\d+) . ([^\n\r]+)/);
    const sheetsMatch = auditSection.match(/Total Sheets: (\d+)/);

    return {
      id: test.id, name: test.name, category: test.category, operationType: test.operationType,
      status: failures.length === 0 ? 'pass' : 'fail',
      timeMs: Date.now() - t0,
      startCoords,
      road: ctx.roadName || '?', speed, aadt: ctx.itdAADT || 0,
      terrain: ctx.itdTerrain || '', funcClass: ctx.itdFuncClass || '',
      lanes: ctx.itdTotalLanes || 0,
      crossStreets: ctx.positionedCrossStreets?.length || 0,
      taCode: taMatch?.[1] || '?', taDescription: taMatch?.[2]?.trim() || '?',
      compliancePass: compMatch ? parseInt(compMatch[1]!) : undefined,
      complianceTotal: compMatch ? parseInt(compMatch[2]!) : undefined,
      complianceFailures: failures, corrections: corrLines,
      sheets: sheetsMatch ? parseInt(sheetsMatch[1]!) : undefined,
      pdfKB: Math.round(blob.byteLength / 1024),
    };
  } catch (err: any) {
    return {
      id: test.id, name: test.name, category: test.category, operationType: test.operationType,
      status: 'error', timeMs: Date.now() - t0, error: err.message,
    };
  }
}

async function main() {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`ITD TCP DRAFTER — AUTOMATED TEST SUITE v2`);
  console.log(`${TESTS.length} tests | Fixed coordinates | Compliance extraction`);
  console.log(`${'='.repeat(70)}\n`);

  // Run in batches of 3 (geocoding + site-context + generate = heavy per test)
  const BATCH = 3;
  const results: TestResult[] = [];

  for (let i = 0; i < TESTS.length; i += BATCH) {
    const batch = TESTS.slice(i, i + BATCH);
    const batchNum = Math.floor(i / BATCH) + 1;
    console.log(`--- Batch ${batchNum}/${Math.ceil(TESTS.length / BATCH)}: ${batch.map(t => t.name).join(' | ')} ---`);

    const batchResults = await Promise.all(batch.map(t => runTest(t)));
    results.push(...batchResults);

    for (const r of batchResults) {
      const icon = r.status === 'pass' ? 'PASS' : r.status === 'fail' ? 'FAIL' : 'ERR!';
      const comp = r.complianceTotal ? `${r.compliancePass}/${r.complianceTotal}` : '?/?';
      const details = [
        r.road || '?',
        `${r.speed || '?'}mph`,
        r.aadt ? `AADT:${r.aadt}` : '',
        r.lanes ? `${r.lanes}ln` : '',
        r.terrain || '',
        r.taCode || '?',
      ].filter(Boolean).join(' | ');
      console.log(`  [${icon}] #${r.id} ${r.name} | ${comp} | ${(r.timeMs / 1000).toFixed(0)}s | ${details}`);
      if (r.complianceFailures?.length) r.complianceFailures.forEach(f => console.log(`        FAIL: ${f}`));
      if (r.corrections?.length) r.corrections.forEach(c => console.log(`        CORR: ${c}`));
      if (r.error) console.log(`        ERROR: ${r.error}`);
    }
    console.log();
  }

  // === SUMMARY ===
  const passed = results.filter(r => r.status === 'pass').length;
  const failed = results.filter(r => r.status === 'fail').length;
  const errors = results.filter(r => r.status === 'error').length;
  const avgTime = Math.round(results.reduce((s, r) => s + r.timeMs, 0) / results.length / 1000);

  console.log(`${'='.repeat(70)}`);
  console.log(`RESULTS: ${passed} PASS | ${failed} FAIL | ${errors} ERROR | Avg: ${avgTime}s/test`);
  console.log(`${'='.repeat(70)}\n`);

  // Correction frequency
  const corrTypes: Record<string, number> = {};
  for (const r of results) {
    for (const c of r.corrections || []) {
      const type = c.split(':')[0]!.trim();
      corrTypes[type] = (corrTypes[type] || 0) + 1;
    }
  }
  if (Object.keys(corrTypes).length > 0) {
    console.log('CORRECTION FREQUENCY:');
    for (const [type, count] of Object.entries(corrTypes).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${type}: ${count}/${results.length} tests (${Math.round(count / results.length * 100)}%)`);
    }
    console.log();
  }

  // TA distribution
  const taDist: Record<string, number> = {};
  for (const r of results) if (r.taCode) taDist[r.taCode] = (taDist[r.taCode] || 0) + 1;
  console.log('TA DISTRIBUTION:');
  for (const [ta, count] of Object.entries(taDist).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${ta}: ${count}x`);
  }

  // Save
  const outPath = path.join(__dirname, '..', '..', 'data', 'autotest_results.json');
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2), 'utf8');
  console.log(`\nFull results saved to ${outPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
