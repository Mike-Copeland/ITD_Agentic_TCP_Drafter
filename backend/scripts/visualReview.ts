/**
 * Visual PDF Review via Gemini 3.1 Pro — examines every sheet.
 * Usage: npx tsx scripts/visualReview.ts
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const SELF_REVIEW = '\n\nIMPORTANT: After generating your response, please review your response, acting as a technical peer reviewer with constructive criticism, identify where your response may have flaws or uncertainty, and include corrections to rectify those issues.';

async function main() {
  const { GoogleGenAI } = await import('@google/genai');
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) { console.error('No API key'); process.exit(1); }
  const ai = new GoogleGenAI({ apiKey });

  const pdfPath = 'C:\\Users\\mcopelan\\Downloads\\ITD_Plan_Set_55_inspect\\output_plan.pdf';
  const auditLog = fs.readFileSync('C:\\Users\\mcopelan\\Downloads\\ITD_Plan_Set_55_inspect\\engineering_audit_log.txt', 'utf8');
  const pdfBase64 = fs.readFileSync(pdfPath).toString('base64');
  console.log(`PDF: ${(pdfBase64.length / 1024 / 1024).toFixed(1)} MB`);

  const prompt = `You are a senior Professional Engineer (PE) conducting a FINAL stamp review of this TCP plan set before it goes to construction. This is the last review before the plan is stamped — it must be PERFECT.

## AUDIT LOG
\`\`\`
${auditLog}
\`\`\`

## REVIEW EVERY SHEET OF THIS PDF IN DETAIL

For EACH sheet, examine:

### Sheet 1 (Cover Sheet):
- Are ALL general notes correct and complete?
- Is the project information accurate?
- Is the sheet index correct?
- Is the symbology legend complete and does each symbol match its description?
- Are there any typos or formatting issues?

### Sheet 2+ (TA Schematics):
- Do the sign symbols look like proper MUTCD signs (correct shape, color, text)?
- Are the channelizing devices drawn as cones or drums (not circles)?
- Are dimension lines clear with arrowheads and correct inter-sign distances?
- Is the road geometry correct for the lane count?
- Are flaggers drawn in the correct positions?
- Is the work area properly crosshatched?
- Are zone labels (Advance Warning, Transition, Buffer, Activity Area, etc.) correct?

### Site Layout Sheet:
- Is the satellite image present?
- Is there a north arrow and scale bar?
- Is coordinate information correct?

### Intersection Detail Sheets:
- Do curb returns look realistic?
- Are signs on the correct side of the road (US right-hand driving)?
- Are stop bars, crosswalks, and signals drawn correctly?

### Queue Analysis Sheet:
- Are the calculations reasonable for the AADT?
- Is the crash history section appropriate?

### Special Considerations:
- Are night operations, pedestrian, emergency, environmental notes appropriate?

### Sign Schedule:
- Does the sign count match what's shown on the drawings?
- Are sign sizes correct for the speed and road class?

### Title Block:
- PE stamp area present?
- PRELIMINARY watermark visible but not obstructive?
- Sheet numbering correct?

## OUTPUT FORMAT
{
  "stamp_ready": true/false,
  "overall_grade": "A/B/C/D/F",
  "sheet_reviews": [
    {
      "sheet_number": 1,
      "sheet_type": "Cover Sheet",
      "grade": "A/B/C/D/F",
      "issues": [{"severity": "critical/major/minor/cosmetic", "description": "...", "fix": "..."}],
      "positives": ["..."]
    }
  ],
  "formatting_issues": [{"description": "...", "fix": "..."}],
  "missing_for_stamp": ["what specifically needs to change before stamping"],
  "would_you_stamp_this": "yes/no/conditional",
  "conditions_for_stamp": ["..."]
}` + SELF_REVIEW;

  console.log('Sending PDF to Gemini 3.1 Pro for visual stamp review...');

  const result = await ai.models.generateContent({
    model: 'gemini-3.1-pro-preview',
    contents: { parts: [
      { inlineData: { data: pdfBase64, mimeType: 'application/pdf' } },
      { text: prompt },
    ]},
    config: { temperature: 1.0, topP: 0.95, thinkingConfig: { thinkingBudget: 24576 } },
  });

  const text = result?.text || '';
  console.log(`Response: ${text.length} chars`);

  const outPath = path.join(__dirname, '..', '..', 'data', 'visual_review.json');
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    fs.writeFileSync(outPath, jsonMatch[0], 'utf8');
    console.log(`Visual review saved to ${outPath}`);
    const review = JSON.parse(jsonMatch[0]);
    console.log(`\nStamp Ready: ${review.stamp_ready}`);
    console.log(`Overall Grade: ${review.overall_grade}`);
    console.log(`Would Stamp: ${review.would_you_stamp_this}`);
    if (review.missing_for_stamp?.length) {
      console.log('\nMissing for Stamp:');
      review.missing_for_stamp.forEach((m: string) => console.log(`  - ${m}`));
    }
  } else {
    fs.writeFileSync(outPath.replace('.json', '.txt'), text, 'utf8');
    console.log('Raw text saved');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
