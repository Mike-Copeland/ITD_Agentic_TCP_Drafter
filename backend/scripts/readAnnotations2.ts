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

  const pdfPath = 'C:\\Users\\mcopelan\\Downloads\\output_plan_annotate.pdf';
  const pdf = fs.readFileSync(pdfPath);
  const b64 = pdf.toString('base64');
  console.log('PDF size:', Math.round(pdf.length / 1024), 'KB');

  // Also load the code for context
  const cadGenCode = fs.readFileSync(path.join(__dirname, '..', 'generators', 'cadGenerator.ts'), 'utf8');

  console.log('Sending annotated PDF to Gemini with corrections...');
  const result = await ai.models.generateContent({
    model: 'gemini-3.1-pro-preview',
    contents: { parts: [
      { inlineData: { data: b64, mimeType: 'application/pdf' } },
      { text: `This PDF has been annotated by a senior traffic engineer with red marks. You previously misinterpreted the annotations. The engineer corrected you:

CRITICAL CORRECTIONS FROM THE ENGINEER:
1. "If you reduce speeds one way, you need to reduce the other unless it's an interstate." — The W3-5 speed reduction sign MUST stay on the opposing approach. The red circle is NOT asking to remove it — it's pointing out that the TEXT IS OVERLAPPING AND UNREADABLE.
2. "The full series of flagger signs on cross streets IS needed." — The red circles on the intersection detail sheets (pages 4-8) are NOT asking to remove the signs. They're pointing out that THE SIGNS ARE ALL OVERLAPPING AND THE TEXT IS UNREADABLE. The signs need to be SPACED OUT so they're readable.
3. Red circles/marks generally indicate LAYOUT PROBLEMS (overlapping text, unreadable elements, misaligned elements) — NOT requests to delete content.

With these corrections in mind, re-examine EVERY page of this annotated PDF. For each red mark:
- What element has the layout problem?
- What is overlapping or unreadable?
- What specific code change would fix the spacing/sizing/alignment?

Also load the drawing code for reference:
\`\`\`typescript
${cadGenCode}
\`\`\`

Output JSON:
[
  {
    "page": N,
    "annotations": [
      {
        "location": "where on page",
        "problem": "what is overlapping/unreadable/misaligned",
        "affected_function": "function name in cadGenerator.ts",
        "fix": "specific code change to fix spacing/sizing"
      }
    ]
  }
]` },
    ]},
    config: { temperature: 1.0, topP: 0.95, thinkingConfig: { thinkingBudget: 24576 } },
  });

  const text = result?.text || '';
  console.log('Response:', text.length, 'chars');

  const outPath = path.join(__dirname, '..', '..', 'data', 'annotated_review_v2.json');
  fs.writeFileSync(outPath, text, 'utf8');
  console.log('Saved to', outPath);

  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (jsonMatch) {
    try {
      const pages = JSON.parse(jsonMatch[0]);
      console.log('\n=== CORRECTED ANNOTATION REVIEW ===');
      for (const page of pages) {
        console.log(`\nPage ${page.page}: ${page.annotations?.length || 0} issues`);
        for (const a of page.annotations || []) {
          console.log(`  [${a.affected_function}] ${a.location}`);
          console.log(`    Problem: ${a.problem}`);
          console.log(`    Fix: ${a.fix}`);
        }
      }
    } catch { console.log('Parse failed — raw text saved'); }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
