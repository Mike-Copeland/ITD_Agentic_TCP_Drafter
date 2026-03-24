/**
 * Gemini Peer Review: Send the latest test output + code to Gemini 3.1 Pro
 * for independent engineering review.
 * Usage: npx tsx scripts/geminiPeerReview.ts
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

  // Load test output
  const auditLog = fs.readFileSync('C:\\Users\\mcopelan\\Downloads\\ITD_Plan_Set_54_inspect\\engineering_audit_log.txt', 'utf8');
  const blueprint = fs.readFileSync('C:\\Users\\mcopelan\\Downloads\\ITD_Plan_Set_54_inspect\\pe_blueprint.json', 'utf8');

  // Load current code
  const mutcdModule = fs.readFileSync(path.join(__dirname, '..', 'engineering', 'mutcdPart6.ts'), 'utf8');
  const cadGenSnippet = fs.readFileSync(path.join(__dirname, '..', 'generators', 'cadGenerator.ts'), 'utf8')
    .substring(0, 15000); // First 15K chars (utilities + sign enforcement)

  // Load PDF for visual review
  const pdfBase64 = fs.readFileSync('C:\\Users\\mcopelan\\Downloads\\ITD_Plan_Set_54_inspect\\output_plan.pdf').toString('base64');

  const prompt = `You are a licensed Professional Engineer specializing in traffic engineering and MUTCD compliance. You are conducting an independent peer review of an AI-generated Temporary Traffic Control (TCP) plan.

## YOUR TASK
Review ALL of the following and provide a detailed, actionable report:

### 1. AUDIT LOG (engineering_audit_log.txt)
\`\`\`
${auditLog}
\`\`\`

### 2. PE BLUEPRINT (pe_blueprint.json)
\`\`\`json
${blueprint}
\`\`\`

### 3. MUTCD REFERENCE MODULE (mutcdPart6.ts) — First 600 lines
\`\`\`typescript
${mutcdModule.substring(0, 20000)}
\`\`\`

### 4. CAD GENERATOR SIGN ENFORCEMENT (cadGenerator.ts snippet)
\`\`\`typescript
${cadGenSnippet}
\`\`\`

### 5. PDF OUTPUT (attached — examine all sheets visually)

## REVIEW CRITERIA
1. **MUTCD 11th Edition Compliance**: Are ALL sign codes, distances, taper lengths, buffer spaces, and device specifications correct per the MUTCD?
2. **Sign Spacing**: The B and C spacing checks FAIL (350 ft vs 500 ft required for Rural). The MUTCD module classifies FC 3 with flat terrain as Rural (A=B=C=500). But the PE used Urban High Speed (A=B=C=350). WHO IS CORRECT? For FC 3 (Principal Arterial - Other) at 45 MPH on flat terrain, what is the correct Table 6B-1 classification?
3. **Sign Symbology**: Do the signs on the PDF match MUTCD figure conventions? Are they the right shape, color, and have correct legend text?
4. **Drawing Quality**: Comment on layout, readability, professional appearance for stamp-grade quality.
5. **Engineering Logic**: Are there any flaws in the TA selection, sign correction, or taper calculations?
6. **Missing Items**: What MUTCD-required elements are missing that a PE would flag before stamping?

## OUTPUT FORMAT
Provide a structured JSON response:
{
  "overall_grade": "A/B/C/D/F",
  "critical_issues": [{"issue": "...", "mutcd_reference": "...", "fix": "..."}],
  "sign_spacing_ruling": {
    "correct_classification": "Urban High Speed / Rural / ...",
    "reasoning": "...",
    "correct_A_B_C": {"A": ..., "B": ..., "C": ...}
  },
  "sign_quality_issues": [{"sign_code": "...", "issue": "...", "mutcd_figure": "...", "fix": "..."}],
  "drawing_quality": [{"sheet": "...", "issue": "...", "fix": "..."}],
  "missing_elements": [{"element": "...", "mutcd_section": "...", "importance": "critical/major/minor"}],
  "code_fixes": [{"file": "...", "function": "...", "issue": "...", "fix_description": "..."}],
  "positive_observations": ["..."]
}`;

  console.log('Sending to Gemini 3.1 Pro with PDF visual review... (may take 60-90 seconds)');

  const result = await ai.models.generateContent({
    model: 'gemini-2.5-pro',
    contents: {
      parts: [
        { inlineData: { data: pdfBase64, mimeType: 'application/pdf' } },
        { text: prompt },
      ],
    },
    config: {
      temperature: 1.0,
      topP: 0.95,
      thinkingConfig: { thinkingBudget: 10000 },
    },
  });

  const text = result?.text || '';
  console.log(`Response: ${text.length} chars`);

  const outPath = path.join(__dirname, '..', '..', 'data', 'gemini_peer_review.json');
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    fs.writeFileSync(outPath, jsonMatch[0], 'utf8');
    console.log(`Review saved to ${outPath}`);
  } else {
    fs.writeFileSync(outPath.replace('.json', '.txt'), text, 'utf8');
    console.log('No JSON found, saved raw text');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
