/**
 * MULTI-AGENT CI PIPELINE — "GOD MODE"
 * ======================================
 * Claude Opus 4.6 + Gemini 3.1 Pro via Vertex AI
 * Native PDF ingestion of MUTCD Part 6 + ITD Supplement
 * Strict JSON enforcement, thinking extraction, self-review
 *
 * Usage: npx tsx scripts/ciPipeline.ts
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import dotenv from 'dotenv';
import * as readline from 'readline';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '..', '.env') });

// === VERTEX AI CONFIG ===
const VERTEX_ENDPOINT = 'aiplatform.googleapis.com';
const PROJECT_ID = 'gen-lang-client-0758301220';
const LOCATION = 'global';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';

// === LOGGING & HELPERS ===
const LOG_DIR = path.join(__dirname, '..', '..', 'data', 'ci_logs');
const runId = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
const logFile = path.join(LOG_DIR, `ci_run_${runId}.md`);

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function log(msg: string) {
  console.log(msg);
  fs.appendFileSync(logFile, msg + '\n');
}

function logSection(title: string) {
  const line = '='.repeat(70);
  log(`\n${line}\n## ${title}\n${line}\n`);
}

function extractJSON(text: string): any {
  // Try code-fenced JSON first
  const match = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const rawJson = match ? match[1]! : text;
  // Try parsing directly
  try { return JSON.parse(rawJson); }
  catch {
    // Try extracting the outermost JSON object
    const objMatch = rawJson.match(/\{[\s\S]*\}/);
    if (objMatch) {
      try { return JSON.parse(objMatch[0]); }
      catch { /* fall through */ }
    }
    throw new Error(`JSON Parse Error. Raw: ${text.substring(0, 200)}...`);
  }
}

// === LOAD REFERENCE PDFs & CODEBASE ===
const mutcdPdfPath = path.join(__dirname, '..', '..', 'data', 'reference', 'mutcd_part6.pdf');
const itdPdfPath = path.join(__dirname, '..', '..', 'data', 'reference', 'itd_supplement.pdf');

const getBase64Safe = (p: string): string | null => {
  if (!fs.existsSync(p)) return null;
  const stat = fs.statSync(p);
  if (stat.size < 100) return null; // Skip empty placeholder files
  return fs.readFileSync(p).toString('base64');
};
const mutcdPdfBase64 = getBase64Safe(mutcdPdfPath);
const itdPdfBase64 = getBase64Safe(itdPdfPath);

const mutcdCode = fs.readFileSync(path.join(__dirname, '..', 'engineering', 'mutcdPart6.ts'), 'utf8');
const cadGenCode = fs.readFileSync(path.join(__dirname, '..', 'generators', 'cadGenerator.ts'), 'utf8');

const SELF_REVIEW = '\n\nIMPORTANT: After generating your response, please review your response, acting as a technical peer reviewer with constructive criticism, identify where your response may have flaws or uncertainty, and include corrections to rectify those issues.';

// === VERTEX AI: CLAUDE OPUS 4.6 ===
async function callClaudeOpus(systemPrompt: string, userMessage: string): Promise<string> {
  const token = execSync('gcloud.cmd auth print-access-token', { encoding: 'utf8' }).trim();
  const url = `https://${VERTEX_ENDPOINT}/v1/projects/${PROJECT_ID}/locations/${LOCATION}/publishers/anthropic/models/claude-opus-4-6:rawPredict`;

  const userContent: any[] = [];

  // Attach reference PDFs as documents
  if (mutcdPdfBase64) userContent.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: mutcdPdfBase64 } });
  if (itdPdfBase64) userContent.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: itdPdfBase64 } });

  userContent.push({ type: 'text', text: userMessage });

  const body = {
    anthropic_version: 'vertex-2023-10-16',
    max_tokens: 8192,
    temperature: 0.1,
    system: systemPrompt,
    messages: [
      { role: 'user', content: userContent },
      { role: 'assistant', content: '{' }, // Force JSON start
    ],
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new Error(`Claude Opus error ${res.status}: ${(await res.text()).substring(0, 500)}`);
  const data = await res.json() as any;
  const rawText = data.content?.[0]?.text || '';
  return rawText.trim().startsWith('{') ? rawText : '{' + rawText;
}

// === VERTEX AI: GEMINI 3.1 PRO PREVIEW ===
async function callGemini(prompt: string, testPdfPaths: string[] = []): Promise<{ text: string; thoughts: string }> {
  const { GoogleGenAI } = await import('@google/genai');
  const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

  const parts: any[] = [];

  // 1. Inject Official Rulebooks
  if (mutcdPdfBase64) parts.push({ inlineData: { data: mutcdPdfBase64, mimeType: 'application/pdf' } });
  if (itdPdfBase64) parts.push({ inlineData: { data: itdPdfBase64, mimeType: 'application/pdf' } });

  // 2. Inject Test Generated PDFs (up to 5 to stay within limits)
  for (const pdfPath of testPdfPaths.slice(0, 5)) {
    if (fs.existsSync(pdfPath)) {
      parts.push({ inlineData: { data: fs.readFileSync(pdfPath).toString('base64'), mimeType: 'application/pdf' } });
    }
  }

  parts.push({ text: prompt + SELF_REVIEW });

  const result = await ai.models.generateContent({
    model: 'gemini-3.1-pro-preview',
    contents: { parts },
    config: {
      temperature: 0.1,
      topP: 0.95,
      responseMimeType: 'application/json',
      thinkingConfig: { thinkingBudget: 24576 },
    },
  });

  const thoughts = (result as any)?.candidates?.[0]?.content?.parts?.find((p: any) => p.thought)?.text || '';
  return { text: result?.text || '{}', thoughts };
}

// === HUMAN OVERSIGHT ===
async function askHuman(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(`\n>> HUMAN INPUT: ${question}\n> `, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// === RUN TESTS ===
async function runTests(): Promise<any[]> {
  log('Running 15 automated tests...');
  try {
    execSync('npx.cmd tsx scripts/autoTest.ts', { cwd: path.join(__dirname, '..'), timeout: 600000, encoding: 'utf8' });
  } catch (e: any) {
    log(`Test runner output: ${(e.stdout || '').substring(0, 2000)}`);
  }
  const resultsPath = path.join(__dirname, '..', '..', 'data', 'autotest_results.json');
  return JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
}

// === MAIN PIPELINE ===
async function main() {
  ensureDir(LOG_DIR);

  logSection(`CI PIPELINE "GOD MODE": ${runId}`);
  log(`Started: ${new Date().toISOString()}`);
  log(`Models: Claude Opus 4.6 (Vertex AI) + Gemini 3.1 Pro Preview`);
  log(`MUTCD PDF: ${mutcdPdfBase64 ? 'LOADED (' + Math.round(mutcdPdfBase64.length / 1024) + 'KB)' : 'NOT FOUND'}`);
  log(`ITD Supplement: ${itdPdfBase64 ? 'LOADED' : 'Not available (placeholder)'}`);
  log(`Human Oversight: ENABLED`);

  let iteration = 0;
  const MAX_ITERATIONS = 3;

  while (iteration < MAX_ITERATIONS) {
    iteration++;
    logSection(`ITERATION ${iteration}/${MAX_ITERATIONS}`);

    // === STEP 1: RUN TESTS ===
    logSection('STEP 1: AUTOMATED TESTS');
    const testResults = await runTests();
    const passed = testResults.filter((r: any) => r.status === 'pass').length;
    const failed = testResults.filter((r: any) => r.status === 'fail').length;
    const errors = testResults.filter((r: any) => r.status === 'error').length;
    log(`Results: ${passed} PASS | ${failed} FAIL | ${errors} ERROR`);

    const testSummary = testResults.map((r: any) =>
      `#${r.id} ${r.name} [${r.status}] Road:${r.road || '?'} Speed:${r.speed || '?'} AADT:${r.aadt || '?'} FC:${r.funcClass || '?'} Lanes:${r.lanes || '?'} Terrain:${r.terrain || '?'} TA:${r.taCode || '?'} Compliance:${r.compliancePass || '?'}/${r.complianceTotal || '?'}${r.complianceFailures?.length ? ' FAILURES: ' + r.complianceFailures.join('; ') : ''}${r.corrections?.length ? ' CORRECTIONS: ' + r.corrections.join('; ') : ''}`
    ).join('\n');
    log('\nTest Summary:\n' + testSummary);

    // Gather test PDF paths from Downloads
    const testPdfDir = 'C:\\Users\\mcopelan\\Downloads\\AutoTest_Plans';
    const testPdfs: string[] = [];
    if (fs.existsSync(testPdfDir)) {
      // Extract PDFs from ZIPs for visual review (first 5)
      for (const r of testResults.slice(0, 5)) {
        const safeName = r.name.replace(/[^a-zA-Z0-9-]/g, '_');
        const zipPath = path.join(testPdfDir, `${r.id.toString().padStart(2, '0')}_${safeName}.zip`);
        if (fs.existsSync(zipPath)) {
          // We can't easily extract PDFs from ZIPs in Node without a library,
          // so pass the ZIP paths — Gemini can't read them, but the audit logs are parsed
          testPdfs.push(zipPath);
        }
      }
    }

    // === STEP 2: GEMINI INDEPENDENT REVIEW ===
    logSection('STEP 2: GEMINI INDEPENDENT REVIEW');
    log('Sending test results, full codebase, and MUTCD PDF to Gemini 3.1 Pro...');

    const geminiPrompt = `You are a Senior Professional Engineer (PE) reviewing 15 automated TCP plans for ITD.
I have attached the Official MUTCD Part 6 PDF. Use it as absolute ground truth.

<ENGINEERING_CODEBASE>
// mutcdPart6.ts (first 8000 chars)
${mutcdCode.substring(0, 8000)}

// cadGenerator.ts (first 8000 chars)
${cadGenCode.substring(0, 8000)}
</ENGINEERING_CODEBASE>

<TEST_RESULTS>
${testSummary}
</TEST_RESULTS>

TASK:
1. Verify test results against the attached MUTCD PDF. Are taper lengths, sign spacing, and device types correct?
2. Find logic flaws in the ENGINEERING_CODEBASE.
3. For each issue, cite the EXACT MUTCD section and table.

Output JSON:
{
  "grade": "A-F",
  "issues": [{ "test_id": 0, "issue": "...", "severity": "CRITICAL/MAJOR/MINOR", "mutcd_citation": "..." }],
  "code_recommendations": [{ "file": "...", "function": "...", "current_flaw": "...", "proposed_fix": "..." }],
  "praise": ["..."]
}`;

    const { text: geminiJsonStr, thoughts: geminiThoughts } = await callGemini(geminiPrompt);
    let geminiReview: any;
    try {
      geminiReview = extractJSON(geminiJsonStr);
      log('\nGemini Review Parsed Successfully.');
      log(`Grade: ${geminiReview.grade}`);
      log(`Issues: ${geminiReview.issues?.length || 0}`);
      log(`Code Recommendations: ${geminiReview.code_recommendations?.length || 0}`);
    } catch (e: any) {
      log(`Gemini JSON parse error: ${e.message}`);
      log(`Raw response (first 500): ${geminiJsonStr.substring(0, 500)}`);
      geminiReview = { grade: '?', issues: [], code_recommendations: [], praise: [] };
    }

    if (geminiThoughts) {
      log(`\nGemini Thinking (${geminiThoughts.length} chars): ${geminiThoughts.substring(0, 500)}...`);
    }
    log('\nGemini Full Review:\n' + JSON.stringify(geminiReview, null, 2));

    // === STEP 3: CLAUDE OPUS ANALYSIS ===
    logSection('STEP 3: CLAUDE OPUS ANALYSIS');
    log('Sending Gemini\'s findings + codebase + MUTCD PDF to Claude Opus 4.6...');

    const opusSystemPrompt = `You are the Principal Software Engineer and Traffic Engineer. You are reviewing an automated QA audit performed by Gemini 3.1 Pro. You have been provided with the official MUTCD Part 6 PDF. Use it as ground truth. Output ONLY valid JSON.`;

    const opusUserPrompt = `<ENGINEERING_CODEBASE>
// mutcdPart6.ts (first 8000 chars)
${mutcdCode.substring(0, 8000)}
// cadGenerator.ts (first 8000 chars)
${cadGenCode.substring(0, 8000)}
</ENGINEERING_CODEBASE>

<GEMINI_THOUGHT_PROCESS>
${geminiThoughts.substring(0, 3000)}
</GEMINI_THOUGHT_PROCESS>

<GEMINI_FINAL_AUDIT>
${JSON.stringify(geminiReview, null, 2)}
</GEMINI_FINAL_AUDIT>

TASK:
1. Evaluate Gemini's audit. Did Gemini hallucinate any MUTCD rules? Cite sections.
2. Formulate final code patches.

Output JSON:
{
  "agreements": [{ "gemini_point": "...", "opus_verdict": "AGREE/DISAGREE", "reasoning": "...", "mutcd_ref": "..." }],
  "additional_issues": [{ "issue": "...", "fix": "..." }],
  "final_code_patches": [{ "file": "...", "function": "...", "description": "..." }],
  "consensus_actions": ["..."]
}`;

    let opusAnalysis: any;
    try {
      const opusResponseStr = await callClaudeOpus(opusSystemPrompt, opusUserPrompt);
      opusAnalysis = extractJSON(opusResponseStr);
      log('\nClaude Opus Analysis Parsed Successfully.');
      log(`Agreements: ${opusAnalysis.agreements?.length || 0}`);
      log(`Additional Issues: ${opusAnalysis.additional_issues?.length || 0}`);
      log(`Code Patches: ${opusAnalysis.final_code_patches?.length || 0}`);
    } catch (e: any) {
      log(`Opus JSON parse error: ${e.message}`);
      opusAnalysis = { agreements: [], additional_issues: [], final_code_patches: [], consensus_actions: [] };
    }
    log('\nOpus Full Analysis:\n' + JSON.stringify(opusAnalysis, null, 2));

    // === STEP 4: GEMINI VALIDATES OPUS PROPOSALS ===
    logSection('STEP 4: GEMINI VALIDATES OPUS PROPOSALS');
    log('Sending Opus patches back to Gemini for final consensus...');

    const geminiValidationPrompt = `Claude Opus has analyzed your review and proposed code patches. Validate each against the attached MUTCD PDF.

<YOUR_ORIGINAL_AUDIT>
${JSON.stringify(geminiReview, null, 2)}
</YOUR_ORIGINAL_AUDIT>

<CLAUDE_OPUS_RESPONSE>
${JSON.stringify(opusAnalysis, null, 2)}
</CLAUDE_OPUS_RESPONSE>

Output JSON:
{
  "validated_actions": [{ "action": "...", "gemini_approval": true, "notes": "..." }],
  "remaining_disagreements": [{ "point": "...", "gemini_position": "...", "recommendation": "..." }],
  "final_consensus": ["List of agreed-upon actions"],
  "convergence_grade": "A-F"
}`;

    let geminiValidation: any;
    try {
      const { text: geminiValStr } = await callGemini(geminiValidationPrompt);
      geminiValidation = extractJSON(geminiValStr);
      log('\nGemini Validation Parsed Successfully.');
      log(`Convergence Grade: ${geminiValidation.convergence_grade}`);
      log(`Validated: ${geminiValidation.validated_actions?.length || 0}`);
      log(`Disagreements: ${geminiValidation.remaining_disagreements?.length || 0}`);
    } catch (e: any) {
      log(`Validation JSON parse error: ${e.message}`);
      geminiValidation = { validated_actions: [], remaining_disagreements: [], final_consensus: [], convergence_grade: '?' };
    }
    log('\nGemini Validation:\n' + JSON.stringify(geminiValidation, null, 2));

    // === STEP 5: HUMAN OVERSIGHT ===
    logSection('STEP 5: HUMAN OVERSIGHT');
    log('Pipeline paused for human review.');
    log(`\nFull log: ${logFile}`);

    console.log('\n' + '='.repeat(70));
    console.log(`ITERATION ${iteration} COMPLETE`);
    console.log(`Gemini Grade: ${geminiReview.grade} | Convergence: ${geminiValidation.convergence_grade}`);
    console.log(`Issues: ${geminiReview.issues?.length || 0} | Patches: ${opusAnalysis.final_code_patches?.length || 0}`);
    console.log(`Consensus Actions: ${geminiValidation.final_consensus?.length || 0}`);
    console.log('='.repeat(70));

    if (geminiValidation.final_consensus?.length > 0) {
      console.log('\nConsensus Actions:');
      geminiValidation.final_consensus.forEach((a: string, i: number) => console.log(`  ${i + 1}. ${a}`));
    }

    const humanDecision = await askHuman(
      `[a] Apply consensus & re-run | [s] Skip, re-run only | [d] Done | [r] Reject:`
    );

    log(`Human decision: ${humanDecision}`);

    if (humanDecision === 'd' || humanDecision === 'r') {
      log(`Pipeline ${humanDecision === 'd' ? 'accepted' : 'rejected'} by human at iteration ${iteration}`);
      break;
    }
  }

  logSection('PIPELINE COMPLETE');
  log(`Iterations: ${iteration}`);
  log(`Finished: ${new Date().toISOString()}`);
  log(`Full log: ${logFile}`);
  console.log(`\nCI Pipeline complete. Log: ${logFile}`);
}

main().catch(e => { console.error('Pipeline error:', e); process.exit(1); });
