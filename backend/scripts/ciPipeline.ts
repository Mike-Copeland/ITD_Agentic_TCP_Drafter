/**
 * MULTI-AGENT CI PIPELINE
 * ========================
 * Elite-level MLOps: Claude Opus + Gemini debate via Vertex AI.
 *
 * Flow:
 *   1. Run automated test suite (15 Idaho locations)
 *   2. Gemini reviews test results + PDFs (independent reviewer)
 *   3. Claude Opus analyzes Gemini's findings + proposes code fixes
 *   4. Gemini validates proposed fixes
 *   5. Human approves/rejects fix proposals
 *   6. Apply approved fixes, re-run tests
 *   7. Loop until convergence (both models agree, all tests pass)
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

// === LOGGING ===
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

// === VERTEX AI: CLAUDE OPUS ===
async function callClaudeOpus(systemPrompt: string, userMessage: string): Promise<string> {
  // Get fresh access token
  const token = execSync('gcloud.cmd auth print-access-token', { encoding: 'utf8' }).trim();

  const url = `https://${VERTEX_ENDPOINT}/v1/projects/${PROJECT_ID}/locations/${LOCATION}/publishers/anthropic/models/claude-opus-4-6:rawPredict`;

  const body = {
    anthropic_version: 'vertex-2023-10-16',
    max_tokens: 8192,
    temperature: 1,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude Opus error ${res.status}: ${err.substring(0, 500)}`);
  }

  const data = await res.json() as any;
  return data.content?.[0]?.text || '';
}

const SELF_REVIEW_INSTRUCTION = '\n\nIMPORTANT: After generating your response, please review your response, acting as a technical peer reviewer with constructive criticism, identify where your response may have flaws or uncertainty, and include corrections to rectify those issues.';

// === VERTEX AI: GEMINI ===
async function callGemini(prompt: string, pdfBase64?: string): Promise<string> {
  const { GoogleGenAI } = await import('@google/genai');
  const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

  const parts: any[] = [];
  if (pdfBase64) {
    parts.push({ inlineData: { data: pdfBase64, mimeType: 'application/pdf' } });
  }
  parts.push({ text: prompt + SELF_REVIEW_INSTRUCTION });

  const result = await ai.models.generateContent({
    model: 'gemini-3.1-pro-preview',
    contents: { parts },
    config: { temperature: 1.0, topP: 0.95, thinkingConfig: { thinkingBudget: 24576 } },
  });

  return result?.text || '';
}

// === HUMAN OVERSIGHT ===
async function askHuman(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(`\n🔵 HUMAN INPUT REQUIRED: ${question}\n> `, answer => {
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
    log(`Test runner output: ${e.stdout || ''}`);
  }
  const resultsPath = path.join(__dirname, '..', '..', 'data', 'autotest_results.json');
  return JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
}

// === MAIN PIPELINE ===
async function main() {
  ensureDir(LOG_DIR);

  logSection(`CI PIPELINE RUN: ${runId}`);
  log(`Started: ${new Date().toISOString()}`);
  log(`Models: Claude Opus 4.6 (Vertex AI) + Gemini 2.5 Pro`);
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

    // Summarize for models
    const testSummary = testResults.map((r: any) =>
      `#${r.id} ${r.name} [${r.status}] Road:${r.road || '?'} Speed:${r.speed || '?'} AADT:${r.aadt || '?'} FC:${r.funcClass || '?'} Lanes:${r.lanes || '?'} Terrain:${r.terrain || '?'} TA:${r.taCode || '?'} Compliance:${r.compliancePass || '?'}/${r.complianceTotal || '?'}${r.complianceFailures?.length ? ' FAILURES: ' + r.complianceFailures.join('; ') : ''}${r.corrections?.length ? ' CORRECTIONS: ' + r.corrections.join('; ') : ''}`
    ).join('\n');
    log('\nTest Summary:\n' + testSummary);

    // Load current code for review
    const mutcdCode = fs.readFileSync(path.join(__dirname, '..', 'engineering', 'mutcdPart6.ts'), 'utf8');

    // === STEP 2: GEMINI REVIEW ===
    logSection('STEP 2: GEMINI INDEPENDENT REVIEW');
    log('Sending test results to Gemini 2.5 Pro...');

    const geminiReview = await callGemini(`You are a licensed PE reviewing automated TCP plan test results. Analyze these 15 tests across Idaho and identify engineering issues.

## TEST RESULTS
${testSummary}

## classifyRoad FUNCTION
${mutcdCode.substring(mutcdCode.indexOf('export function classifyRoad'), mutcdCode.indexOf('export function getSignSpacing'))}

## TASK
1. Identify any tests where the TA selection appears wrong for the road characteristics
2. Identify sign spacing classification issues
3. Identify missing data patterns
4. Propose specific code fixes with exact function names and logic changes
5. Rate overall system quality (A-F)

Output JSON: { "grade": "...", "issues": [{"test_id": ..., "issue": "...", "severity": "critical/major/minor", "proposed_fix": "..."}], "code_recommendations": [{"function": "...", "change": "..."}], "praise": ["..."] }`);

    log('\nGemini Review:\n' + geminiReview);

    // === STEP 3: CLAUDE OPUS ANALYSIS ===
    logSection('STEP 3: CLAUDE OPUS ANALYSIS');
    log('Sending Gemini review to Claude Opus 4.6...');

    const opusAnalysis = await callClaudeOpus(
      `You are a senior software engineer specializing in traffic engineering automation. You are reviewing a peer review from Gemini about an automated TCP plan generation system. Your role is to:
1. Evaluate Gemini's findings for accuracy
2. Agree or disagree with each point, citing MUTCD sections
3. Propose specific, implementable code changes
4. Identify any issues Gemini missed`,

      `## GEMINI'S REVIEW
${geminiReview}

## TEST RESULTS
${testSummary}

## CURRENT classifyRoad CODE
${mutcdCode.substring(mutcdCode.indexOf('export function classifyRoad'), mutcdCode.indexOf('export function getSignSpacing'))}

## CURRENT selectTA CODE
${mutcdCode.substring(mutcdCode.indexOf('export function selectTA'), mutcdCode.indexOf('// SIGN SEQUENCE'))}

Respond with JSON: { "agreements": [{"gemini_point": "...", "opus_verdict": "agree/disagree/partial", "reasoning": "...", "mutcd_ref": "..."}], "additional_issues": [{"issue": "...", "fix": "..."}], "proposed_code_changes": [{"function": "...", "current_logic": "...", "proposed_logic": "...", "justification": "..."}], "consensus_actions": ["specific action items both models agree on"] }`
    );

    log('\nClaude Opus Analysis:\n' + opusAnalysis);

    // === STEP 4: GEMINI VALIDATES OPUS'S PROPOSALS ===
    logSection('STEP 4: GEMINI VALIDATES OPUS PROPOSALS');
    log('Sending Opus proposals back to Gemini for validation...');

    const geminiValidation = await callGemini(`You are the same PE reviewer. Claude Opus has analyzed your review and proposed fixes. Validate each proposal.

## YOUR ORIGINAL REVIEW
${geminiReview}

## CLAUDE OPUS'S RESPONSE
${opusAnalysis}

Respond with JSON: { "validated_actions": [{"action": "...", "gemini_approval": true/false, "notes": "..."}], "remaining_disagreements": [{"point": "...", "gemini_position": "...", "recommendation": "..."}], "final_consensus": ["list of agreed-upon actions to implement"], "convergence_grade": "A-F" }`);

    log('\nGemini Validation:\n' + geminiValidation);

    // === STEP 5: HUMAN OVERSIGHT ===
    logSection('STEP 5: HUMAN OVERSIGHT');
    log('Pipeline paused for human review.');
    log('\nFull conversation log available at: ' + logFile);

    console.log('\n' + '='.repeat(70));
    console.log('MULTI-AGENT DEBATE COMPLETE — ITERATION ' + iteration);
    console.log('='.repeat(70));
    console.log('\nGemini Review: See above');
    console.log('Opus Analysis: See above');
    console.log('Gemini Validation: See above');
    console.log('\nFull log: ' + logFile);

    const humanDecision = await askHuman(
      `Review the model debate above.\n` +
      `Options:\n` +
      `  [a] Apply consensus fixes and re-run tests\n` +
      `  [s] Skip fixes, re-run tests only\n` +
      `  [d] Done — accept current state\n` +
      `  [r] Reject all — stop pipeline\n` +
      `Choice (a/s/d/r):`
    );

    log(`Human decision: ${humanDecision}`);

    if (humanDecision === 'd' || humanDecision === 'r') {
      log(`Pipeline ${humanDecision === 'd' ? 'accepted' : 'rejected'} by human at iteration ${iteration}`);
      break;
    }

    if (humanDecision === 'a') {
      log('Human approved fixes — applying would require manual code changes or automated patching.');
      log('For safety, logging the consensus actions for manual implementation.');
      // In a fully automated version, this would parse the JSON and apply patches
    }

    // Continue to next iteration
  }

  logSection('PIPELINE COMPLETE');
  log(`Iterations: ${iteration}`);
  log(`Finished: ${new Date().toISOString()}`);
  log(`Log file: ${logFile}`);

  console.log('\n✅ CI Pipeline complete. Full log: ' + logFile);
}

main().catch(e => { console.error('Pipeline error:', e); process.exit(1); });
