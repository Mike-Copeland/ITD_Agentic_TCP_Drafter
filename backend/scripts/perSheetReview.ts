/**
 * Per-Sheet Visual Review via Gemini 3.1 Pro
 * Sends the PDF + code + user comments for targeted per-page analysis.
 * Usage: npx.cmd tsx scripts/perSheetReview.ts [path-to-pdf]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const USER_COMMENTS: Record<number, string> = {
  1: `Boxes overflow and overwritten text. The Project Info box text overlaps with General Notes.`,
  2: `The white box under "WORK AREA" needs to be a little bigger — the W and A are in the crosshatching. There are some overwritten words on the sheet. The zone label row (advance warning area/transition/buffer/activity area/buffer/trans/term/advance warning area) needs to be placed ABOVE the top signs. The END ROAD WORK sign is the right color now but the WRONG SHAPE — it was the right shape before (rectangle) but the wrong color. It should be an orange RECTANGLE, not a diamond.`,
  3: `The "INTERSECTIONS WITHIN WORK ZONE" text listing conflicts with the "Route polyline and markers provided by Google Maps Platform. Verify on-site before construction" disclaimer. The disclaimer text should move out of that box or below it.`,
  4: `It's showing a signal but not showing crosswalks or stop bars on SH-44. There should be stop bars at minimum. Also it is only showing W20-1 "ROAD WORK AHEAD" signs — wouldn't there be the whole series of signs for a flagging station here (W20-1, W20-4, W20-7a)? The intersection should be grounded in real data — look up how busy the cross street is, use Street View or satellite imagery to determine turn lanes, traffic controls, etc.`,
  5: `This is weird because it's an intersection but it's not showing an intersection in the drawing. The cross-street geometry is missing entirely. Same comments about using real data and showing the full sign sequence.`,
  6: `Same as sheet 5 — intersection geometry missing.`,
  7: `Same as sheet 5 — intersection geometry missing.`,
  8: `Same as sheet 5 — intersection geometry missing.`,
  9: `Only showing W20-1 signs. Should show the whole series of signs for a flagging station. Should look up real intersection data.`,
  10: `Looks good.`,
  11: `Looks good.`,
  12: `This is a hot mess. Actually look at it and try to understand what it is with fresh eyes like a human in the field. It says something but what is it actually showing? Is it readable? Useful?`,
  13: `The signs all show the same point, the streets are weirdly labeled. It's just not good.`,
  14: `There are weird gaps in the road, and the signs and streets aren't good.`,
  15: `Signs are all showing being at the same point, there are weird gaps in the road.`,
  16: `Looks good.`,
};

async function main() {
  const { GoogleGenAI } = await import('@google/genai');
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) { console.error('No API key'); process.exit(1); }
  const ai = new GoogleGenAI({ apiKey });

  const pdfPath = process.argv[2] || 'C:\\Users\\mcopelan\\AppData\\Local\\Temp\\zip68_inspect\\output_plan.pdf';
  if (!fs.existsSync(pdfPath)) { console.error(`PDF not found: ${pdfPath}`); process.exit(1); }

  const pdfBase64 = fs.readFileSync(pdfPath).toString('base64');
  console.log(`PDF: ${(Buffer.from(pdfBase64, 'base64').length / 1024).toFixed(0)} KB`);

  // Load the drawing code
  const cadGenPath = path.join(__dirname, '..', 'generators', 'cadGenerator.ts');
  const cadGenCode = fs.readFileSync(cadGenPath, 'utf8');

  // Load audit log
  const auditPath = pdfPath.replace('output_plan.pdf', 'engineering_audit_log.txt');
  const auditLog = fs.existsSync(auditPath) ? fs.readFileSync(auditPath, 'utf8') : '';

  const allResults: any[] = [];

  // Process sheets the user commented on (skip "looks good" ones)
  const sheetsToReview = Object.entries(USER_COMMENTS)
    .filter(([_, comment]) => !comment.toLowerCase().includes('looks good'))
    .map(([num, _]) => parseInt(num));

  console.log(`Reviewing ${sheetsToReview.length} sheets: ${sheetsToReview.join(', ')}\n`);

  for (const sheetNum of sheetsToReview) {
    const userComment = USER_COMMENTS[sheetNum]!;
    console.log(`\n${'='.repeat(60)}`);
    console.log(`SHEET ${sheetNum}`);
    console.log(`${'='.repeat(60)}`);
    console.log(`User: ${userComment}\n`);

    const prompt = `Look at PAGE ${sheetNum} of this PDF. A traffic engineer reviewed it and found these problems:

"${userComment}"

## AUDIT LOG (context)
\`\`\`
${auditLog}
\`\`\`

## DRAWING CODE (cadGenerator.ts — relevant excerpts will be long, focus on the function that draws this page type)
\`\`\`typescript
${cadGenCode}
\`\`\`

## YOUR TASK
1. Look at page ${sheetNum} in the PDF
2. Confirm or dispute each problem the engineer identified
3. For each CONFIRMED problem, identify the exact function and line range in cadGenerator.ts
4. Propose a specific code fix (with the exact old code and new code)

Focus on PAGE ${sheetNum} ONLY. Be specific about what you see visually vs what the code produces.

Output JSON:
{
  "sheet_number": ${sheetNum},
  "visual_description": "what you actually see on this page",
  "confirmed_issues": [
    {
      "issue": "description",
      "function": "functionName",
      "line_range": "start-end",
      "fix": "specific code change"
    }
  ],
  "disputed_issues": [
    { "issue": "...", "reason": "why the engineer may be wrong" }
  ]
}`;

    try {
      const result = await ai.models.generateContent({
        model: 'gemini-3.1-pro-preview',
        contents: { parts: [
          { inlineData: { data: pdfBase64, mimeType: 'application/pdf' } },
          { text: prompt },
        ]},
        config: { temperature: 1.0, topP: 0.95, thinkingConfig: { thinkingBudget: 24576 } },
      });

      const text = result?.text || '';
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const review = JSON.parse(jsonMatch[0]);
          allResults.push(review);
          console.log(`Visual: ${review.visual_description?.substring(0, 100)}...`);
          console.log(`Confirmed: ${review.confirmed_issues?.length || 0} | Disputed: ${review.disputed_issues?.length || 0}`);
          for (const issue of review.confirmed_issues || []) {
            console.log(`  [CONFIRMED] ${issue.issue}`);
            console.log(`    Function: ${issue.function} (${issue.line_range})`);
          }
          for (const d of review.disputed_issues || []) {
            console.log(`  [DISPUTED] ${d.issue}: ${d.reason}`);
          }
        } catch {
          console.log(`  Raw response (parse failed): ${text.substring(0, 300)}`);
          allResults.push({ sheet_number: sheetNum, raw: text });
        }
      } else {
        console.log(`  No JSON in response: ${text.substring(0, 300)}`);
        allResults.push({ sheet_number: sheetNum, raw: text });
      }
    } catch (err: any) {
      console.error(`  ERROR: ${err.message}`);
      allResults.push({ sheet_number: sheetNum, error: err.message });
    }

    // Rate limit — 2s between calls
    await new Promise(r => setTimeout(r, 2000));
  }

  // Save all results
  const outPath = path.join(__dirname, '..', '..', 'data', `per_sheet_review_${new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19)}.json`);
  fs.writeFileSync(outPath, JSON.stringify(allResults, null, 2), 'utf8');
  console.log(`\n${'='.repeat(60)}`);
  console.log(`All results saved to ${outPath}`);
  console.log(`Total: ${allResults.length} sheets reviewed`);
}

main().catch(e => { console.error(e); process.exit(1); });
