/**
 * Iterate with Gemini: Generate a plan, visually review, log issues.
 * Usage: npx tsx scripts/iterateWithGemini.ts
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const BASE = 'http://localhost:3001';
const SELF_REVIEW = '\n\nAfter generating your response, please review your response, acting as a technical peer reviewer with constructive criticism, identify where your response may have flaws or uncertainty, and include corrections to rectify those issues.';

// SH-21 mountain road test
const TEST = {
  startCoords: { lat: 43.90697, lng: -115.70111 },
  endCoords: { lat: 43.98450, lng: -115.66850 },
  operationType: 'Single Lane Closure',
  normalSpeed: 45, workZoneSpeed: 40, laneWidth: 11,
  duration: 'Short-term (<= 3 days)',
};

async function main() {
  const dlDir = 'C:\\Users\\mcopelan\\Downloads\\GeminiIteration';
  if (!fs.existsSync(dlDir)) fs.mkdirSync(dlDir, { recursive: true });

  console.log('=== GEMINI ITERATION: SH-21 Mountain Road ===\n');

  // Step 1: Generate
  console.log('Step 1: Fetching site context...');
  const ctxRes = await fetch(`${BASE}/api/site-context`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ startCoords: TEST.startCoords, endCoords: TEST.endCoords, normalSpeed: TEST.normalSpeed }),
  });
  const ctx = await ctxRes.json() as any;
  console.log(`  Road: ${ctx.roadName} | AADT: ${ctx.itdAADT} | Terrain: ${ctx.itdTerrain}`);

  console.log('Step 2: Generating plan...');
  const genRes = await fetch(`${BASE}/api/generate-plan`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      blueprint: {
        primary_approach: [
          { sign_code: 'W20-1', distance_ft: 1500, label: 'ROAD WORK AHEAD' },
          { sign_code: 'W20-4', distance_ft: 1000, label: 'ONE LANE ROAD AHEAD' },
          { sign_code: 'W20-7a', distance_ft: 500, label: 'FLAGGER AHEAD' },
        ],
        opposing_approach: [
          { sign_code: 'W20-1', distance_ft: 1500, label: 'ROAD WORK AHEAD' },
          { sign_code: 'W20-4', distance_ft: 1000, label: 'ONE LANE ROAD AHEAD' },
          { sign_code: 'W20-7a', distance_ft: 500, label: 'FLAGGER AHEAD' },
        ],
        taper: { length_ft: 100, device_type: 'Cones' },
        downstream_taper: { length_ft: 100 },
        engineering_notes: 'SH-21 mountain road test for Gemini iteration',
      },
      staticMapBase64: ctx.staticMapBase64 || '',
      startCoords: TEST.startCoords, endCoords: TEST.endCoords,
      normalSpeed: TEST.normalSpeed, workZoneSpeed: TEST.workZoneSpeed,
      laneWidth: TEST.laneWidth, duration: TEST.duration,
      routeDistanceFt: ctx.routeDistanceFt || 0,
      roadName: ctx.roadName || 'SH-21',
      positionedCrossStreets: ctx.positionedCrossStreets || [],
      itdTerrain: ctx.itdTerrain || '', itdFuncClass: ctx.itdFuncClass || '',
      itdTotalLanes: ctx.itdTotalLanes || 0, itdAADT: ctx.itdAADT || 0,
      itdTruckPct: ctx.itdTruckPct || 0, itdCrashCount: ctx.itdCrashCount || 0,
      itdBridges: ctx.itdBridges || [], maxGradePercent: ctx.maxGradePercent || 0,
      routePolyline: ctx.routePolyline || '', operationTypes: [TEST.operationType],
    }),
  });
  const blob = await genRes.arrayBuffer();
  const zipPath = path.join(dlDir, 'SH21_MountainRoad.zip');
  fs.writeFileSync(zipPath, Buffer.from(blob));
  console.log(`  ZIP: ${Math.round(blob.byteLength / 1024)} KB`);

  // Step 3: Send PDF to Gemini for visual review
  console.log('\nStep 3: Gemini 3.1 Pro visual review...');
  const { GoogleGenAI } = await import('@google/genai');
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY });

  // Extract PDF from ZIP for Gemini (can't send ZIP directly)
  const extractDir = path.join(dlDir, 'extracted');
  if (!fs.existsSync(extractDir)) fs.mkdirSync(extractDir, { recursive: true });
  // Use PowerShell to extract
  const { execSync } = await import('child_process');
  try { execSync(`powershell.exe -ExecutionPolicy Bypass -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force"`, { timeout: 10000 }); } catch {}
  const pdfFile = path.join(extractDir, 'output_plan.pdf');
  const pdfBase64 = fs.existsSync(pdfFile) ? fs.readFileSync(pdfFile).toString('base64') : '';
  if (!pdfBase64) { console.error('Could not extract PDF'); process.exit(1); }

  const result = await ai.models.generateContent({
    model: 'gemini-3.1-pro-preview',
    contents: { parts: [
      { inlineData: { data: pdfBase64, mimeType: 'application/pdf' } },
      { text: `You are a Senior PE reviewing the Geometry Plan sheets in this TCP plan set PDF. Focus ONLY on the Geometry Plan sheets (the ones showing actual road curvature from GPS polyline data).

INSPECT EACH GEOMETRY PLAN SHEET and report:
1. Are the black road EDGE LINES visible? Or just hollow gray fills?
2. Is the yellow dashed CENTERLINE visible?
3. Are START and END pin markers visible and correctly positioned?
4. Does the INDEX sheet have numbered grid rectangles? Do the numbers match the actual page numbers?
5. Are there any BLANK pages or phantom sheets?
6. Is the road shape (curves, switchbacks) accurately rendered?
7. Are the station ticks readable?
8. Is the scale bar present and correct?
9. Are annotations (road names, signs) readable and not overlapping road lines?
10. Count the total number of Geometry Plan pages. Is this reasonable for the route length?

Output JSON:
{
  "geometry_sheets_count": 0,
  "edge_lines_visible": true/false,
  "centerline_visible": true/false,
  "start_end_pins_visible": true/false,
  "index_sheet_present": true/false,
  "grid_labels_match_pages": true/false,
  "blank_pages": 0,
  "road_shape_accurate": true/false,
  "station_ticks_readable": true/false,
  "annotations_clean": true/false,
  "overall_grade": "A-F",
  "issues": [{"page": 0, "issue": "...", "fix": "..."}],
  "praise": ["..."]
}` + SELF_REVIEW },
    ]},
    config: { temperature: 1.0, topP: 0.95, responseMimeType: 'application/json', thinkingConfig: { thinkingBudget: 24576 } },
  });

  const reviewText = result?.text || '{}';
  fs.writeFileSync(path.join(dlDir, 'gemini_visual_review.json'), reviewText, 'utf8');

  try {
    const review = JSON.parse(reviewText);
    console.log(`\n=== GEMINI VISUAL REVIEW ===`);
    console.log(`  Grade: ${review.overall_grade}`);
    console.log(`  Geometry sheets: ${review.geometry_sheets_count}`);
    console.log(`  Edge lines: ${review.edge_lines_visible}`);
    console.log(`  Centerline: ${review.centerline_visible}`);
    console.log(`  Start/End pins: ${review.start_end_pins_visible}`);
    console.log(`  Index: ${review.index_sheet_present}`);
    console.log(`  Grid labels match: ${review.grid_labels_match_pages}`);
    console.log(`  Blank pages: ${review.blank_pages}`);
    console.log(`  Road shape: ${review.road_shape_accurate}`);
    console.log(`  Annotations clean: ${review.annotations_clean}`);
    if (review.issues?.length) {
      console.log(`  Issues (${review.issues.length}):`);
      review.issues.forEach((i: any) => console.log(`    Page ${i.page}: ${i.issue}`));
    }
    if (review.praise?.length) {
      console.log(`  Praise:`);
      review.praise.forEach((p: string) => console.log(`    + ${p}`));
    }
  } catch {
    console.log('  Raw review saved (JSON parse issue)');
  }

  console.log(`\n=== FILES: ${dlDir} ===`);
}

main().catch(e => { console.error(e); process.exit(1); });
