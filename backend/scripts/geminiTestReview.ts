/**
 * Gemini Test Review: Analyze 15 automated test results.
 * Usage: npx tsx scripts/geminiTestReview.ts
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

  const results = fs.readFileSync(path.join(__dirname, '..', '..', 'data', 'autotest_results.json'), 'utf8');
  const mutcdModule = fs.readFileSync(path.join(__dirname, '..', 'engineering', 'mutcdPart6.ts'), 'utf8');

  // Read backend logs for compliance details
  const serverLog = (() => {
    try {
      // Find the most recent task output
      const tmpDir = 'C:\\Users\\mcopelan\\AppData\\Local\\Temp\\claude';
      const files = fs.readdirSync(tmpDir, { recursive: true }) as string[];
      return 'Log parsing skipped — using test results JSON';
    } catch { return 'Could not read server logs'; }
  })();

  const prompt = `You are a senior traffic engineer reviewing the results of 15 automated TCP plan generation tests across diverse Idaho road conditions. Analyze the test results and identify systemic issues.

## TEST RESULTS
\`\`\`json
${results}
\`\`\`

## MUTCD MODULE (classifyRoad function)
\`\`\`typescript
${mutcdModule.substring(mutcdModule.indexOf('export function classifyRoad'), mutcdModule.indexOf('export function getSignSpacing'))}
\`\`\`

## ANALYSIS REQUIRED

1. **Road Name Issues**: Several tests show wrong road names (e.g., Test #1 "I-84 Meridian" resolved to "N Main St"). This means the GPS coordinates didn't land on the intended road. Identify all mismatches.

2. **Classification Analysis**: For each test, what SHOULD the road classification be? Check if AADT + FC + terrain would produce the correct Table 6B-1 classification.

3. **TA Selection Analysis**: Based on the road data returned (lanes, FC, operation type), what TA should each test have selected? Flag any that seem wrong.

4. **Missing Data**: Which tests returned no terrain, no FC, or no lane data? This is an ITD ArcGIS coverage gap.

5. **Coordinate Accuracy**: Some coordinates clearly missed the target road (e.g., I-84 → N Main St). Suggest which tests need coordinate adjustments.

6. **Systemic Issues**: Are there patterns in the failures that suggest code fixes?

Output JSON:
{
  "road_name_mismatches": [{"test_id": ..., "expected": "...", "got": "...", "coords_need_fix": true/false}],
  "classification_analysis": [{"test_id": ..., "expected_class": "...", "actual_class_would_be": "...", "correct": true/false}],
  "ta_selection_issues": [{"test_id": ..., "expected_ta": "...", "reason": "..."}],
  "missing_data_tests": [{"test_id": ..., "missing": ["terrain", "fc", "lanes"]}],
  "coordinate_fixes": [{"test_id": ..., "better_lat": ..., "better_lng": ..., "reason": "..."}],
  "systemic_issues": [{"issue": "...", "affected_tests": [...], "fix": "..."}],
  "overall_assessment": "..."
}`;

  console.log('Sending test results to Gemini for analysis...');
  const result = await ai.models.generateContent({
    model: 'gemini-2.5-pro',
    contents: { parts: [{ text: prompt }] },
    config: { temperature: 0.8, topP: 0.95, thinkingConfig: { thinkingBudget: 10000 } },
  });

  const text = result?.text || '';
  console.log(`Response: ${text.length} chars`);
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    const outPath = path.join(__dirname, '..', '..', 'data', 'gemini_test_review.json');
    fs.writeFileSync(outPath, jsonMatch[0], 'utf8');
    console.log(`Test review saved to ${outPath}`);

    // Print summary
    const review = JSON.parse(jsonMatch[0]);
    console.log('\n=== GEMINI TEST REVIEW SUMMARY ===');
    console.log(`Road name mismatches: ${review.road_name_mismatches?.length || 0}`);
    console.log(`Classification issues: ${review.classification_analysis?.filter((c: any) => !c.correct)?.length || 0}`);
    console.log(`TA selection issues: ${review.ta_selection_issues?.length || 0}`);
    console.log(`Missing data tests: ${review.missing_data_tests?.length || 0}`);
    console.log(`Coordinate fixes needed: ${review.coordinate_fixes?.length || 0}`);
    console.log(`Systemic issues: ${review.systemic_issues?.length || 0}`);
    console.log(`\nOverall: ${review.overall_assessment}`);
  } else {
    console.log(text);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
