/**
 * Roundabout Test: Hill Rd dogbone — automated test + Claude Opus peer review
 * Usage: npx tsx scripts/testRoundabout.ts
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import dotenv from 'dotenv';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const BASE = 'http://localhost:3001';
const VERTEX_ENDPOINT = 'aiplatform.googleapis.com';
const PROJECT_ID = 'gen-lang-client-0758301220';
const LOCATION = 'global';

const TEST = {
  name: 'Hill Rd Dogbone Roundabout',
  startCoords: { lat: 43.65657, lng: -116.23507 },
  endCoords: { lat: 43.65434, lng: -116.23159 },
  operationType: 'Single Lane Closure',
  normalSpeed: 45,
  workZoneSpeed: 40,
  laneWidth: 12,
  duration: 'Short-term (<= 3 days)',
};

async function main() {
  const dlDir = 'C:\\Users\\mcopelan\\Downloads\\RoundaboutTest';
  if (!fs.existsSync(dlDir)) fs.mkdirSync(dlDir, { recursive: true });

  console.log('=== ROUNDABOUT TEST: Hill Rd Dogbone ===\n');

  // Step 1: Site Context
  console.log('Step 1: Fetching site context...');
  const ctxRes = await fetch(`${BASE}/api/site-context`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ startCoords: TEST.startCoords, endCoords: TEST.endCoords, normalSpeed: TEST.normalSpeed }),
  });
  if (!ctxRes.ok) throw new Error(`Site context failed: ${ctxRes.status}`);
  const ctx = await ctxRes.json() as any;
  console.log(`  Road: ${ctx.roadName} | AADT: ${ctx.itdAADT} | FC: ${ctx.itdFuncClass} | Roundabouts: ${ctx.roundaboutCount || 0}`);
  console.log(`  Vision road type: ${ctx.visionRoadType || 'N/A'}`);
  console.log(`  Cross-streets: ${ctx.positionedCrossStreets?.length || 0}`);

  // Save context
  fs.writeFileSync(path.join(dlDir, 'site_context.json'), JSON.stringify(ctx, null, 2).substring(0, 5000), 'utf8');

  // Step 2: Generate Plan
  console.log('\nStep 2: Generating plan set...');
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
          { sign_code: 'W20-4', distance_ft: 350, label: 'ONE LANE ROAD AHEAD' },
          { sign_code: 'W20-7a', distance_ft: 200, label: 'FLAGGER AHEAD' },
        ],
        taper: { length_ft: 50, device_type: 'Cones' },
        downstream_taper: { length_ft: 50 },
        engineering_notes: 'Roundabout test: Hill Rd dogbone',
      },
      startCoords: TEST.startCoords,
      endCoords: TEST.endCoords,
      staticMapBase64: ctx.staticMapBase64 || '',
      normalSpeed: TEST.normalSpeed,
      workZoneSpeed: TEST.workZoneSpeed,
      laneWidth: TEST.laneWidth,
      operationType: TEST.operationType,
      operationTypes: [TEST.operationType],
      duration: TEST.duration,
      routeDistanceFt: ctx.routeDistanceFt || 0,
      roadName: ctx.roadName || 'Hill Rd',
      positionedCrossStreets: ctx.positionedCrossStreets || [],
      itdTerrain: ctx.itdTerrain || '',
      itdFuncClass: ctx.itdFuncClass || '',
      itdTotalLanes: ctx.itdTotalLanes || 0,
      itdAADT: ctx.itdAADT || 0,
      itdTruckPct: ctx.itdTruckPct || 0,
      itdCrashCount: ctx.itdCrashCount || 0,
      itdBridges: ctx.itdBridges || [],
      maxGradePercent: ctx.maxGradePercent || 0,
      routePolyline: ctx.routePolyline || '',
    }),
  });

  if (!genRes.ok) throw new Error(`Generate failed: ${genRes.status} ${await genRes.text()}`);

  const blob = await genRes.arrayBuffer();
  const zipBuf = Buffer.from(blob);
  const zipPath = path.join(dlDir, 'RoundaboutTest_PlanSet.zip');
  fs.writeFileSync(zipPath, zipBuf);
  console.log(`  ZIP saved: ${zipPath} (${Math.round(zipBuf.length / 1024)} KB)`);

  // Extract audit log from ZIP
  const raw = zipBuf.toString('latin1');
  const auditStart = raw.indexOf('Engineering Generation Log');
  const auditEnd = raw.indexOf('PE Agent Engineering Notes:');
  const auditSection = auditStart >= 0 ? raw.substring(auditStart, auditEnd > 0 ? auditEnd + 500 : auditStart + 3000) : '';
  fs.writeFileSync(path.join(dlDir, 'audit_log_extracted.txt'), auditSection, 'utf8');

  // Extract compliance
  const compMatch = auditSection.match(/Result: (\d+)\/(\d+) checks passed/);
  console.log(`  Compliance: ${compMatch ? compMatch[1] + '/' + compMatch[2] : 'N/A'}`);

  const failures: string[] = [];
  const failRx = /\[FAIL\] ([^\n\r]+)/g;
  let m; while ((m = failRx.exec(auditSection)) !== null) failures.push(m[1]!);
  if (failures.length > 0) {
    console.log('  FAILURES:');
    failures.forEach(f => console.log(`    - ${f}`));
  }

  // Step 3: Claude Opus Peer Review via Vertex AI
  console.log('\nStep 3: Claude Opus peer review...');

  const mutcdPdfPath = path.join(__dirname, '..', '..', 'data', 'reference', 'mutcd_part6.pdf');
  const mutcdBase64 = fs.existsSync(mutcdPdfPath) ? fs.readFileSync(mutcdPdfPath).toString('base64') : null;

  const token = execSync('gcloud.cmd auth print-access-token', { encoding: 'utf8' }).trim();
  const opusUrl = `https://${VERTEX_ENDPOINT}/v1/projects/${PROJECT_ID}/locations/${LOCATION}/publishers/anthropic/models/claude-opus-4-6:rawPredict`;

  const reviewPrompt = `You are a licensed Professional Engineer reviewing a Temporary Traffic Control plan for a DOGBONE ROUNDABOUT on Hill Rd, Boise ID.

AUDIT LOG:
${auditSection.substring(0, 2000)}

SITE DATA:
- Road: Hill Rd | AADT: ${ctx.itdAADT || 'unknown'} | FC: ${ctx.itdFuncClass || 'unknown'}
- Crash Count: ${ctx.itdCrashCount || 0} | Bridges: ${ctx.itdBridges?.length || 0}
- Roundabouts detected: ${ctx.roundaboutCount || 0}
- Vision road type: ${ctx.visionRoadType || 'N/A'}
- Cross-streets: ${ctx.positionedCrossStreets?.map((cs: any) => cs.name).join(', ') || 'none'}

TASK: Please review your response, acting as a technical peer reviewer with constructive criticism, identify where your response may have flaws or uncertainty, and include corrections to rectify those issues.

Review this plan for:
1. Did the system detect and correctly handle the roundabout geometry?
2. Is TA-10 appropriate for work near/within a roundabout?
3. Are roundabout-specific signs present (W2-6, R6-4, R1-2)?
4. Does the Geometry Plan sheet show the actual road network including the roundabout shape?
5. Are TCP devices plotted with professional leader lines?
6. What specific changes are needed for this plan to be stampable?

Output JSON:
{
  "roundabout_detected": true/false,
  "roundabout_handled_correctly": true/false,
  "overall_grade": "A-F",
  "critical_issues": [{"issue": "...", "fix": "..."}],
  "improvements_since_last_review": ["..."],
  "remaining_for_stamp": ["..."],
  "would_stamp": "yes/no/conditional"
}`;

  const userContent: any[] = [];
  if (mutcdBase64) userContent.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: mutcdBase64 } });
  userContent.push({ type: 'text', text: reviewPrompt });

  try {
    const opusRes = await fetch(opusUrl, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        anthropic_version: 'vertex-2023-10-16', max_tokens: 4096, temperature: 0.1,
        system: 'You are a Senior PE specializing in roundabout traffic control. Output valid JSON only.',
        messages: [{ role: 'user', content: userContent }],
      }),
    });

    if (opusRes.ok) {
      const opusData = await opusRes.json() as any;
      const opusText = opusData.content?.[0]?.text || '{}';
      fs.writeFileSync(path.join(dlDir, 'claude_peer_review.json'), opusText, 'utf8');

      try {
        const review = JSON.parse(opusText.match(/\{[\s\S]*\}/)?.[0] || opusText);
        console.log(`\n=== CLAUDE OPUS PEER REVIEW ===`);
        console.log(`  Roundabout detected: ${review.roundabout_detected}`);
        console.log(`  Handled correctly: ${review.roundabout_handled_correctly}`);
        console.log(`  Grade: ${review.overall_grade}`);
        console.log(`  Would stamp: ${review.would_stamp}`);
        if (review.critical_issues?.length) {
          console.log(`  Critical issues:`);
          review.critical_issues.forEach((i: any) => console.log(`    - ${i.issue}`));
        }
        if (review.improvements_since_last_review?.length) {
          console.log(`  Improvements:`);
          review.improvements_since_last_review.forEach((i: string) => console.log(`    + ${i}`));
        }
        if (review.remaining_for_stamp?.length) {
          console.log(`  Remaining for stamp:`);
          review.remaining_for_stamp.forEach((i: string) => console.log(`    * ${i}`));
        }
      } catch {
        console.log('  (Raw review saved — JSON parse failed)');
      }
    } else {
      console.log(`  Opus error: ${opusRes.status}`);
      const errText = await opusRes.text();
      fs.writeFileSync(path.join(dlDir, 'claude_error.txt'), errText, 'utf8');
    }
  } catch (err) {
    console.log(`  Opus call failed: ${err}`);
  }

  console.log(`\n=== FILES SAVED TO ${dlDir} ===`);
  console.log('  RoundaboutTest_PlanSet.zip');
  console.log('  site_context.json');
  console.log('  audit_log_extracted.txt');
  console.log('  claude_peer_review.json');
}

main().catch(e => { console.error('Test failed:', e); process.exit(1); });
