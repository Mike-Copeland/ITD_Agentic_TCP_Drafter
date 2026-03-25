/**
 * Visual PDF Review + Code Review via Gemini 3.1 Pro
 * Sends the PDF + cadGenerator.ts source for per-page visual fix recommendations.
 * Usage: npx.cmd tsx scripts/visualReviewWithCode.ts [path-to-pdf]
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

  // PDF path from arg or default to latest
  const pdfPath = process.argv[2] || 'C:\\Users\\mcopelan\\AppData\\Local\\Temp\\zip67_inspect\\output_plan.pdf';
  if (!fs.existsSync(pdfPath)) { console.error(`PDF not found: ${pdfPath}`); process.exit(1); }

  const pdfBase64 = fs.readFileSync(pdfPath).toString('base64');
  console.log(`PDF: ${(Buffer.from(pdfBase64, 'base64').length / 1024).toFixed(0)} KB`);

  // Load the drawing code
  const cadGenPath = path.join(__dirname, '..', 'generators', 'cadGenerator.ts');
  const cadGenCode = fs.readFileSync(cadGenPath, 'utf8');
  console.log(`cadGenerator.ts: ${(cadGenCode.length / 1024).toFixed(0)} KB`);

  // Load audit log if available
  const auditPath = pdfPath.replace('output_plan.pdf', 'engineering_audit_log.txt');
  const auditLog = fs.existsSync(auditPath) ? fs.readFileSync(auditPath, 'utf8') : '(not available)';

  const prompt = `For each page in the PDF, take a look at the page and corresponding script and recommend fixes to improve the visuals of the PDF without changing the content.

## AUDIT LOG (for context on what this plan contains)
\`\`\`
${auditLog}
\`\`\`

## DRAWING SCRIPT (cadGenerator.ts)
This is the TypeScript code that generates this PDF using PDFKit. Reference specific line numbers and function names in your recommendations.

\`\`\`typescript
${cadGenCode}
\`\`\`

## INSTRUCTIONS

For EACH page in the PDF:
1. Describe what you see visually on the page
2. Identify specific visual problems (overlapping text, poor spacing, unreadable elements, misaligned items, confusing symbology, etc.)
3. Reference the exact function/line in cadGenerator.ts that draws the problematic element
4. Propose a specific code fix (with line numbers) to improve the visual

Focus on VISUAL quality only — do not change engineering content, sign codes, distances, or compliance logic.

Categories to evaluate per page:
- Text readability (font size, overlap, truncation)
- Element spacing and alignment
- Color contrast and fill opacity
- Line weights and styles
- Label placement and leader lines
- Overall professional appearance (would a PE be comfortable stamping this?)

## OUTPUT FORMAT
Output valid JSON:
{
  "pages": [
    {
      "page_number": 1,
      "page_type": "Cover Sheet",
      "visual_description": "what you see on this page",
      "issues": [
        {
          "element": "what's wrong",
          "severity": "critical|major|minor|cosmetic",
          "function": "drawCoverSheet",
          "line_range": "522-710",
          "current_behavior": "what it looks like now",
          "proposed_fix": "specific code change to improve it",
          "why": "why this improves the visual"
        }
      ],
      "looks_good": ["things that already look professional"]
    }
  ],
  "overall_visual_grade": "A/B/C/D/F",
  "top_3_priorities": ["the 3 most impactful visual fixes across all pages"],
  "stamp_ready_visually": true/false
}

IMPORTANT: After generating your response, review it as a peer reviewer. Identify where your response may have flaws or uncertainty, and include corrections.`;

  console.log('Sending PDF + cadGenerator.ts to Gemini 3.1 Pro for visual review...');
  console.log('This may take 2-3 minutes...\n');

  const result = await ai.models.generateContent({
    model: 'gemini-3.1-pro-preview',
    contents: { parts: [
      { inlineData: { data: pdfBase64, mimeType: 'application/pdf' } },
      { text: prompt },
    ]},
    config: {
      temperature: 1.0,
      topP: 0.95,
      thinkingConfig: { thinkingBudget: 24576 },
      // mediaResolution: 'high' — not available in SDK, handled by model default
    },
  });

  const text = result?.text || '';
  console.log(`Response: ${text.length} chars`);

  const outDir = path.join(__dirname, '..', '..', 'data');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
  const outPath = path.join(outDir, `visual_review_${timestamp}.json`);

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const review = JSON.parse(jsonMatch[0]);
      fs.writeFileSync(outPath, JSON.stringify(review, null, 2), 'utf8');
      console.log(`\nVisual review saved to ${outPath}`);
      console.log(`\nOverall Visual Grade: ${review.overall_visual_grade}`);
      console.log(`Stamp Ready Visually: ${review.stamp_ready_visually}`);
      if (review.top_3_priorities?.length) {
        console.log('\nTop 3 Priorities:');
        review.top_3_priorities.forEach((p: string, i: number) => console.log(`  ${i + 1}. ${p}`));
      }
      // Print issue counts per page
      console.log('\nPer-Page Summary:');
      for (const page of review.pages || []) {
        const issues = page.issues?.length || 0;
        const good = page.looks_good?.length || 0;
        console.log(`  Page ${page.page_number} (${page.page_type}): ${issues} issues, ${good} positives`);
      }
    } catch {
      fs.writeFileSync(outPath.replace('.json', '.txt'), jsonMatch[0], 'utf8');
      console.log(`Raw JSON saved to ${outPath.replace('.json', '.txt')}`);
    }
  } else {
    fs.writeFileSync(outPath.replace('.json', '.txt'), text, 'utf8');
    console.log(`Raw text saved (no JSON found)`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
