/**
 * Dual-Model Review: Dog-bone roundabout edge case
 * Sends PDF to both Gemini 3.1 Pro and Claude Opus 4.6 for independent review
 * Usage: npx tsx scripts/roundaboutReview.ts
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import dotenv from 'dotenv';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const VERTEX_ENDPOINT = 'aiplatform.googleapis.com';
const PROJECT_ID = 'gen-lang-client-0758301220';
const LOCATION = 'global';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';

const SELF_REVIEW = '\n\nAfter generating your response, please review your response, acting as a technical peer reviewer with constructive criticism, identify where your response may have flaws or uncertainty, and include corrections to rectify those issues.';

function extractJSON(text: string): any {
  const match = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const raw = match ? match[1]! : text;
  try { return JSON.parse(raw); } catch {
    const obj = raw.match(/\{[\s\S]*\}/);
    if (obj) try { return JSON.parse(obj[0]); } catch {}
    throw new Error('JSON parse failed');
  }
}

async function main() {
  const pdfBase64 = fs.readFileSync('C:\\Users\\mcopelan\\Downloads\\ITD_Plan_Set_56_inspect\\output_plan.pdf').toString('base64');
  const auditLog = fs.readFileSync('C:\\Users\\mcopelan\\Downloads\\ITD_Plan_Set_56_inspect\\engineering_audit_log.txt', 'utf8');
  const mutcdPdf = fs.existsSync(path.join(__dirname, '..', '..', 'data', 'reference', 'mutcd_part6.pdf'))
    ? fs.readFileSync(path.join(__dirname, '..', '..', 'data', 'reference', 'mutcd_part6.pdf')).toString('base64') : null;

  const prompt = `You are a Senior PE reviewing a TCP plan set for a DOG-BONE ROUNDABOUT interchange on Hill Rd, Boise area.

A dog-bone roundabout has TWO roundabouts connected by a short bridge or overpass segment. This is an unconventional intersection type requiring special traffic control considerations.

## AUDIT LOG
\`\`\`
${auditLog}
\`\`\`

## TASK — Review this plan for roundabout-specific issues:

1. **Roundabout Detection**: Did the system correctly identify this as a roundabout or dog-bone interchange? Does the intersection geometry show "roundabout" type?
2. **TA Appropriateness**: Is TA-10 (flagger control) appropriate for work near/within a roundabout? What MUTCD guidance exists for roundabout work zones?
3. **Signing**: Roundabouts require specific signs (W2-6 ROUNDABOUT AHEAD, R6-4 YIELD). Are these accounted for?
4. **Geometry**: Does the plan account for the circular geometry of roundabouts, or does it treat everything as straight-line intersections?
5. **Approach Considerations**: Each roundabout leg is a separate approach requiring its own advance warning. Is this handled?
6. **72 Crashes**: This is a high-crash location. What enhanced measures are appropriate for roundabout work zones?
7. **Missing Elements**: What roundabout-specific TCP elements are missing that a PE would require?

## CRITICAL QUESTION
What changes would need to be made to the software to properly handle roundabout and interchange work zones programmatically? Propose specific code additions.

Output JSON:
{
  "roundabout_detected": true/false,
  "ta_appropriate": true/false,
  "roundabout_specific_issues": [{"issue": "...", "severity": "CRITICAL/MAJOR/MINOR", "fix": "..."}],
  "missing_roundabout_signs": [{"code": "...", "label": "...", "where": "..."}],
  "code_recommendations": [{"description": "...", "implementation": "..."}],
  "overall_assessment": "..."
}` + SELF_REVIEW;

  // === GEMINI REVIEW ===
  console.log('Sending to Gemini 3.1 Pro...');
  const { GoogleGenAI } = await import('@google/genai');
  const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  const geminiParts: any[] = [];
  if (mutcdPdf) geminiParts.push({ inlineData: { data: mutcdPdf, mimeType: 'application/pdf' } });
  geminiParts.push({ inlineData: { data: pdfBase64, mimeType: 'application/pdf' } });
  geminiParts.push({ text: prompt });

  const geminiResult = await ai.models.generateContent({
    model: 'gemini-3.1-pro-preview',
    contents: { parts: geminiParts },
    config: { temperature: 0.1, topP: 0.95, responseMimeType: 'application/json', thinkingConfig: { thinkingBudget: 24576 } },
  });
  const geminiText = geminiResult?.text || '{}';
  console.log(`Gemini: ${geminiText.length} chars`);

  // === CLAUDE OPUS REVIEW ===
  console.log('Sending to Claude Opus 4.6...');
  const token = execSync('gcloud.cmd auth print-access-token', { encoding: 'utf8' }).trim();
  const opusUrl = `https://${VERTEX_ENDPOINT}/v1/projects/${PROJECT_ID}/locations/${LOCATION}/publishers/anthropic/models/claude-opus-4-6:rawPredict`;

  const opusContent: any[] = [];
  if (mutcdPdf) opusContent.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: mutcdPdf } });
  opusContent.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } });
  opusContent.push({ type: 'text', text: prompt });

  const opusRes = await fetch(opusUrl, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      anthropic_version: 'vertex-2023-10-16', max_tokens: 8192, temperature: 0.1,
      system: 'You are a Senior PE specializing in roundabout and interchange traffic control. Output valid JSON only.',
      messages: [{ role: 'user', content: opusContent }],
    }),
  });

  let opusText = '{}';
  if (opusRes.ok) {
    const opusData = await opusRes.json() as any;
    opusText = opusData.content?.[0]?.text || '{}';
    console.log(`Opus: ${opusText.length} chars`);
  } else {
    console.error(`Opus error: ${opusRes.status} ${(await opusRes.text()).substring(0, 300)}`);
  }

  // === SAVE RESULTS ===
  const outDir = path.join(__dirname, '..', '..', 'data');
  let geminiReview: any, opusReview: any;
  try { geminiReview = extractJSON(geminiText); } catch { geminiReview = { raw: geminiText.substring(0, 2000) }; }
  try { opusReview = extractJSON(opusText); } catch { opusReview = { raw: opusText.substring(0, 2000) }; }

  const combined = { gemini: geminiReview, opus: opusReview };
  fs.writeFileSync(path.join(outDir, 'roundabout_review.json'), JSON.stringify(combined, null, 2), 'utf8');
  console.log('\n=== GEMINI ASSESSMENT ===');
  console.log(JSON.stringify(geminiReview, null, 2).substring(0, 3000));
  console.log('\n=== OPUS ASSESSMENT ===');
  console.log(JSON.stringify(opusReview, null, 2).substring(0, 3000));

  console.log(`\nSaved to data/roundabout_review.json`);
}

main().catch(e => { console.error(e); process.exit(1); });
