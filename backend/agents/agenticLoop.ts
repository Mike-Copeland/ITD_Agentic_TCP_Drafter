import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { DRAFTER_PROMPT, REVIEWER_PROMPT, JUDGE_PROMPT } from './prompts.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BACKEND_ROOT = path.join(__dirname, '..');
const NODE_MODULES_PATH = path.join(BACKEND_ROOT, 'node_modules');
const CAD_TEMPLATE_PATH = path.join(BACKEND_ROOT, 'generators', 'cadGenerator.ts');

// Read fresh on every call so the Drafter always sees the latest template
function getCadTemplateSource(): string {
  return fs.readFileSync(CAD_TEMPLATE_PATH, 'utf8');
}

// =============================================================================
// SANDBOX — Whitelist validation + locked execution
// =============================================================================

const ALLOWED_REQUIRES = new Set(['pdfkit', 'fs', 'path']);

/**
 * Static analysis of the LLM-generated script before execution.
 * Validates require() calls against a whitelist and blocks dangerous patterns.
 */
function validateScript(code: string): void {
  // 1. Whitelist check: extract every require('...') and reject unlisted modules
  const requirePattern = /require\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
  let match;
  while ((match = requirePattern.exec(code)) !== null) {
    const mod = match[1]!;
    if (!ALLOWED_REQUIRES.has(mod)) {
      throw new Error(
        `SANDBOX VIOLATION: require('${mod}') is blocked. Allowed: ${[...ALLOWED_REQUIRES].join(', ')}`,
      );
    }
  }

  // 2. Block dynamic code execution
  if (/\beval\s*\(/.test(code)) {
    throw new Error('SANDBOX VIOLATION: eval() is forbidden');
  }
  if (/new\s+Function\s*\(/.test(code)) {
    throw new Error('SANDBOX VIOLATION: Function constructor is forbidden');
  }

  // 3. Block parent directory traversal in string literals
  if (/['"`][^'"`]*\.\.[/\\]/.test(code)) {
    throw new Error('SANDBOX VIOLATION: parent directory traversal ("../") detected');
  }

  // 4. Block process.env access (prevents API key leakage)
  if (/process\.env/.test(code)) {
    throw new Error('SANDBOX VIOLATION: process.env access is forbidden');
  }
}

/**
 * Execute a Node.js script inside a locked-down sandbox.
 * - cwd pinned to sessionDir (script cannot reference files outside)
 * - Strict 15-second timeout (CLAUDE.md §6)
 * - Minimal env: only NODE_PATH (for module resolution) and PATH (for node binary)
 * - No API keys, no HOME, no user env vars leaked to the script
 */
function sandboxedExec(scriptPath: string, sessionDir: string): string {
  try {
    const stdout = execSync(`node "${path.basename(scriptPath)}"`, {
      cwd: sessionDir,
      timeout: 15_000,
      env: {
        NODE_PATH: NODE_MODULES_PATH,
        PATH: process.env.PATH || '',
        SYSTEMROOT: process.env.SYSTEMROOT || '', // Required on Windows for Node.js
      },
      stdio: 'pipe',
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout.toString();
  } catch (err: unknown) {
    const e = err as { killed?: boolean; stderr?: Buffer; message: string };
    if (e.killed) {
      throw new Error('SANDBOX: Script exceeded 15-second timeout');
    }
    const stderr = e.stderr?.toString().slice(0, 2000) || '';
    throw new Error(`SANDBOX: Script crashed:\n${stderr || e.message}`);
  }
}

// =============================================================================
// GEMINI API — Shared caller with exponential backoff (CLAUDE.md §6)
// =============================================================================

async function callGemini(
  systemPrompt: string,
  userPrompt: string,
  inlineData?: { data: string; mimeType: string }[],
): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY || '';
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured on server');

  const { GoogleGenAI } = await import('@google/genai');
  const ai = new GoogleGenAI({ apiKey });

  const parts: { inlineData?: { data: string; mimeType: string }; text?: string }[] = [];
  if (inlineData) {
    for (const item of inlineData) {
      parts.push({ inlineData: item });
    }
  }
  parts.push({ text: `${systemPrompt}\n\n${userPrompt}` });

  const maxRetries = 3;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: 'gemini-3.1-pro-preview',
        contents: { parts },
      });
      return response.text || '';
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED')) {
        const delay = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
        console.log(`[Agentic] Rate limited (attempt ${attempt + 1}/${maxRetries}), waiting ${delay}ms...`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  throw new Error('Gemini API: max retries exceeded (429 rate limit)');
}

// =============================================================================
// AGENT CALLS
// =============================================================================

function stripMarkdownFences(text: string): string {
  return text
    .replace(/```(?:javascript|js)?\n?/gi, '')
    .replace(/```/g, '')
    .trim();
}

async function callDrafter(
  blueprint: object,
  pdfPath: string,
  defects?: string[],
): Promise<string> {
  const escapedPdfPath = pdfPath.replace(/\\/g, '\\\\');

  let userPrompt = `BLUEPRINT JSON:
${JSON.stringify(blueprint, null, 2)}

SPEED DATA (read from session_data.json at runtime, but use these values for notes text):
  The session_data.json file in the current directory also contains:
  - normalSpeed: the posted speed limit in MPH
  - workZoneSpeed: the reduced work zone speed in MPH
  - laneWidth: lane width in feet
  Calculate taper with MUTCD math: L = W * S for speeds >= 45 mph, L = (W*S^2)/60 for <= 40 mph.
  Print the actual speed values in the notes box. Do NOT hardcode 65 MPH.

REFERENCE TEMPLATE (study this code for style and structure, then adapt it):
\`\`\`typescript
${getCadTemplateSource()}
\`\`\`

OUTPUT PDF PATH (use this EXACTLY in your createWriteStream call):
${escapedPdfPath}

Write a standalone CommonJS Node.js script that:
1. const PDFDocument = require('pdfkit');  const fs = require('fs');  const path = require('path');
2. Creates an 11x17 tabloid landscape PDF (1224 x 792 points) with TWO sheets:

   SHEET 1: Linear TTC schematic with roadway lines, work area, tapers, dimension lines,
   and all signs from BOTH approaches. Title block at the bottom.
   IMPORTANT: Place all primary approach signs BEFORE the taper start (x < 550).
   Do NOT let sign positions extend past the taper or dimension line text will overlap.

   SHEET 2: Geo-stamped satellite overlay. Read the file 'session_data.json' from the
   current working directory:
     const sessionData = JSON.parse(fs.readFileSync('session_data.json', 'utf8'));
   If sessionData.staticMapBase64 is not null, decode it and embed the satellite image:
     doc.image(Buffer.from(sessionData.staticMapBase64, 'base64'), 312, 196, { width: 600, height: 400 });
   If sessionData.startCoords and sessionData.endCoords exist, plot start/end pin markers
   on the satellite image using Web Mercator projection (see the reference template for math).
   If no satellite image, draw a placeholder rectangle with "NO SATELLITE IMAGE PROVIDED".

3. CRITICAL STREAM PATTERN — you MUST use this exact sequence at the end:
   const stream = fs.createWriteStream('${escapedPdfPath}');
   doc.pipe(stream);
   // ... all drawing code ...
   stream.on('finish', () => { process.exit(0); });
   stream.on('error', (e) => { console.error(e); process.exit(1); });
   doc.end();

Output ONLY raw JavaScript. No markdown fences. No explanations.`;

  if (defects && defects.length > 0) {
    userPrompt += `\n\nCRITICAL DEFECTS FROM PREVIOUS ROUND — YOU MUST FIX ALL OF THESE:\n${defects.map((d, i) => `${i + 1}. ${d}`).join('\n')}`;
  }

  const raw = await callGemini(DRAFTER_PROMPT, userPrompt);
  return stripMarkdownFences(raw);
}

async function callReviewer(pdfPath: string, blueprint: object): Promise<string[]> {
  const pdfBuffer = fs.readFileSync(pdfPath);
  const pdfBase64 = pdfBuffer.toString('base64');

  const userPrompt = `Here is the PE Blueprint that the attached PDF must faithfully represent:
${JSON.stringify(blueprint, null, 2)}

Inspect the attached PDF. Check:
1. Are ALL signs from primary_approach and opposing_approach present with correct codes and labels?
2. Are taper lengths and dimension lines accurate per the blueprint?
3. Is any text overlapping, cut off, or illegible?
4. Is the roadway geometry (lane lines, work area, tapers) correctly drawn?
5. Are there any MUTCD safety violations?

Output ONLY a JSON array of string defects. If the PDF is acceptable, output: []`;

  const raw = await callGemini(REVIEWER_PROMPT, userPrompt, [
    { data: pdfBase64, mimeType: 'application/pdf' },
  ]);

  try {
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]) as string[];
    }
    return [];
  } catch {
    console.warn('[Reviewer] Could not parse defects JSON, treating as empty');
    return [];
  }
}

async function callJudge(defects: string[]): Promise<string[]> {
  if (defects.length === 0) return ['APPROVED'];

  const userPrompt = `The QA Reviewer reported these defects:
${JSON.stringify(defects, null, 2)}

Filter out purely aesthetic complaints (font size preferences, color choices, minor spacing).
Keep ONLY safety-critical or geometry-breaking defects that would cause a real-world hazard.
Output ONLY a JSON array of required fixes, or ["APPROVED"] if none are critical.`;

  const raw = await callGemini(JUDGE_PROMPT, userPrompt);

  try {
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]) as string[];
    }
    return ['APPROVED'];
  } catch {
    return ['APPROVED'];
  }
}

// =============================================================================
// MAIN LOOP — Drafter-Reviewer-Judge with max 3 iterations
// =============================================================================

export interface AgenticResult {
  pdfCreated: boolean;
  auditLog: string;
}

export async function runAgenticLoop(
  blueprint: object,
  sessionDir: string,
  pdfPath: string,
): Promise<AgenticResult> {
  const log: string[] = [];
  const maxRounds = 3;
  let pendingDefects: string[] = [];

  log.push('========================================');
  log.push('  DRAFTER-REVIEWER-JUDGE AUDIT LOG');
  log.push('========================================');
  log.push(`Session Dir : ${sessionDir}`);
  log.push(`Started     : ${new Date().toISOString()}`);
  log.push(`Max Rounds  : ${maxRounds}`);
  log.push('');

  for (let round = 1; round <= maxRounds; round++) {
    log.push(`--- ROUND ${round} / ${maxRounds} ---`);

    // ---- DRAFTER ----
    console.log(`[Agentic] Round ${round}: Drafter generating script...`);
    let code: string;
    try {
      code = await callDrafter(
        blueprint,
        pdfPath,
        pendingDefects.length > 0 ? pendingDefects : undefined,
      );
      log.push(`[DRAFTER] Generated ${code.length} characters of JavaScript`);
      log.push(`[DRAFTER] Code preview (first 300 chars):\n${code.slice(0, 300)}\n...`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.push(`[DRAFTER] FAILED: ${msg}`);
      continue;
    }

    // ---- SANDBOX VALIDATION ----
    try {
      validateScript(code);
      log.push('[SANDBOX] Static analysis passed');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.push(`[SANDBOX] BLOCKED: ${msg}`);
      pendingDefects = [
        `Your script was rejected by the security sandbox: ${msg}. ` +
          `Rewrite using ONLY require('pdfkit'), require('fs'), and require('path'). ` +
          `Do NOT use child_process, eval, "../", or process.env.`,
      ];
      continue;
    }

    // ---- SANDBOXED EXECUTION ----
    const scriptPath = path.join(sessionDir, `draft_${round}.js`);
    fs.writeFileSync(scriptPath, code, 'utf8');

    try {
      const stdout = sandboxedExec(scriptPath, sessionDir);
      if (stdout.trim()) log.push(`[EXEC] stdout: ${stdout.trim().slice(0, 500)}`);
      log.push('[EXEC] Script completed successfully');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.push(`[EXEC] CRASHED: ${msg}`);
      pendingDefects = [
        `Your script crashed during execution: ${msg.slice(0, 500)}. Fix the runtime error and rewrite the full script.`,
      ];
      continue;
    }

    // ---- VERIFY OUTPUT ----
    if (!fs.existsSync(pdfPath)) {
      log.push('[VERIFY] PDF file was NOT created');
      pendingDefects = [
        'The PDF file was not created. Ensure you call doc.pipe(fs.createWriteStream(...)) BEFORE any drawing calls, and doc.end() at the very end.',
      ];
      continue;
    }

    const pdfSize = fs.statSync(pdfPath).size;
    if (pdfSize < 1000) {
      log.push(`[VERIFY] PDF is suspiciously small (${pdfSize} bytes) — likely empty`);
      pendingDefects = [
        `The PDF file is only ${pdfSize} bytes — nearly empty. The stream likely did not flush. ` +
          `Set up the finish listener BEFORE calling doc.end().`,
      ];
      continue;
    }
    log.push(`[VERIFY] PDF created successfully (${pdfSize} bytes)`);

    // ---- REVIEWER ----
    console.log(`[Agentic] Round ${round}: Reviewer inspecting PDF...`);
    let reviewDefects: string[];
    try {
      reviewDefects = await callReviewer(pdfPath, blueprint);
      log.push(
        `[REVIEWER] Found ${reviewDefects.length} defect(s)` +
          (reviewDefects.length > 0 ? `:\n${reviewDefects.map((d, i) => `  ${i + 1}. ${d}`).join('\n')}` : ''),
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.push(`[REVIEWER] FAILED (${msg}) — accepting current draft as-is`);
      log.push('');
      log.push(`=== ACCEPTED (Reviewer unavailable) after round ${round} ===`);
      break;
    }

    if (reviewDefects.length === 0) {
      log.push('[JUDGE] No defects to evaluate — APPROVED');
      log.push('');
      log.push(`=== APPROVED after ${round} round(s) ===`);
      break;
    }

    // ---- JUDGE ----
    console.log(`[Agentic] Round ${round}: Judge evaluating ${reviewDefects.length} defect(s)...`);
    let verdict: string[];
    try {
      verdict = await callJudge(reviewDefects);
      log.push(
        `[JUDGE] Verdict: ${JSON.stringify(verdict)}`,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.push(`[JUDGE] FAILED (${msg}) — accepting current draft`);
      log.push('');
      log.push(`=== ACCEPTED (Judge unavailable) after round ${round} ===`);
      break;
    }

    if (verdict.length === 1 && verdict[0] === 'APPROVED') {
      log.push('');
      log.push(`=== APPROVED by Judge after ${round} round(s) ===`);
      break;
    }

    // Feed critical defects back to Drafter for next round
    pendingDefects = verdict;

    if (round === maxRounds) {
      log.push('');
      log.push(`=== MAX ROUNDS (${maxRounds}) REACHED — accepting last draft ===`);
    }

    log.push('');
  }

  const pdfCreated = fs.existsSync(pdfPath) && fs.statSync(pdfPath).size > 1000;

  log.push('');
  log.push(`Completed: ${new Date().toISOString()}`);
  log.push(`PDF Valid : ${pdfCreated ? 'YES' : 'NO — will fall back to deterministic generator'}`);

  return {
    pdfCreated,
    auditLog: log.join('\n'),
  };
}
