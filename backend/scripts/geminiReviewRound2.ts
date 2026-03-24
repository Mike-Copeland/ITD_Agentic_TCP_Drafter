/**
 * Gemini Review Round 2: Send fixed code for validation.
 * Usage: npx tsx scripts/geminiReviewRound2.ts
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '..', '.env') });

async function main() {
  const { GoogleGenAI } = await import('@google/genai');
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) { console.error('No API key'); process.exit(1); }
  const ai = new GoogleGenAI({ apiKey });

  const prevReview = fs.readFileSync(path.join(__dirname, '..', '..', 'data', 'gemini_peer_review.json'), 'utf8');
  const mutcdModule = fs.readFileSync(path.join(__dirname, '..', 'engineering', 'mutcdPart6.ts'), 'utf8');

  // Get the sign enforcement section of cadGenerator
  const cadGen = fs.readFileSync(path.join(__dirname, '..', 'generators', 'cadGenerator.ts'), 'utf8');
  const signEnforcementStart = cadGen.indexOf('MUTCD-AUTHORITATIVE SIGN ENFORCEMENT');
  const signEnforcementEnd = cadGen.indexOf('Sanitize cross-streets', signEnforcementStart);
  const signSection = cadGen.substring(signEnforcementStart - 50, signEnforcementEnd + 100);

  const prompt = `You are the same PE reviewer from Round 1. Here are your previous findings and the fixes that were applied. Validate that each fix correctly addresses the issue.

## YOUR PREVIOUS REVIEW
\`\`\`json
${prevReview}
\`\`\`

## FIXES APPLIED

### Fix 1: classifyRoad now uses AADT and cross-street count as urban indicators
- AADT >= 3000 OR crossStreetCount >= 4 OR FC >= 5 → Urban context
- Only true Rural: mountainous/rolling terrain with AADT < 1500 and few cross-streets
- Result: US-95 at 45 MPH with AADT 11,500 and 6 cross-streets → now correctly classifies as Urban (High Speed)

### Fix 2: W3-5 added to BOTH approaches when speed reduction active
- Was only added to primary. Now uses a shared function that adds to opposing too.

### Fix 3: Long work zone repeater signs added to sign schedule
- For routes > 1 mile, adds W20-1 repeater sets at 1-mile intervals to the sign quantities

### Fix 4: High crash location enhanced measures note on cover sheet
- When crashCount >= 10, adds a general note requiring PCMS, speed feedback signs, and/or law enforcement

### Fix 5: Compliance checker now passes AADT and crossStreetCount to classifyRoad
- Prevents false negatives from incorrect Rural classification

## UPDATED CODE

### classifyRoad (mutcdPart6.ts)
\`\`\`typescript
${mutcdModule.substring(mutcdModule.indexOf('export function classifyRoad'), mutcdModule.indexOf('export function getSignSpacing'))}
\`\`\`

### Sign Enforcement Section (cadGenerator.ts)
\`\`\`typescript
${signSection}
\`\`\`

## QUESTIONS FOR YOU
1. Are these fixes correct? Do they properly address each of your findings?
2. The sign spacing distance override logic checks if PE's first sign distance >= 0.9 * A. Is this the right threshold, or should we check ALL inter-sign spacings against B and C too?
3. For the classifyRoad AADT threshold of 3000: is this a reasonable cutoff for urban vs rural context?
4. Are there any remaining issues that weren't addressed?

Output JSON: { "fixes_validated": [{"fix": "...", "status": "correct/needs_work", "notes": "..."}], "remaining_issues": [...], "sign_spacing_override_recommendation": "...", "aadt_threshold_opinion": "..." }`;

  console.log('Sending Round 2 to Gemini...');
  const result = await ai.models.generateContent({
    model: 'gemini-2.5-pro',
    contents: { parts: [{ text: prompt }] },
    config: { temperature: 1.0, topP: 0.95, thinkingConfig: { thinkingBudget: 8000 } },
  });

  const text = result?.text || '';
  console.log(`Response: ${text.length} chars`);
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    const outPath = path.join(__dirname, '..', '..', 'data', 'gemini_review_round2.json');
    fs.writeFileSync(outPath, jsonMatch[0], 'utf8');
    console.log(`Round 2 review saved to ${outPath}`);
  } else {
    console.log(text);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
