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

  const pdfPath = process.argv[2] || 'C:\\Users\\mcopelan\\Downloads\\output_plan_annotate.pdf';
  if (!fs.existsSync(pdfPath)) { console.error('PDF not found:', pdfPath); process.exit(1); }

  const pdf = fs.readFileSync(pdfPath);
  const b64 = pdf.toString('base64');
  console.log('PDF size:', Math.round(pdf.length / 1024), 'KB');

  console.log('Sending annotated PDF to Gemini...');
  const result = await ai.models.generateContent({
    model: 'gemini-3.1-pro-preview',
    contents: { parts: [
      { inlineData: { data: b64, mimeType: 'application/pdf' } },
      { text: `This PDF has been annotated by a traffic engineer with red marks, circles, arrows, and handwritten comments on each page.

For EACH page in the PDF, carefully examine it and describe:
1. What annotations/markups are visible (red circles, arrows, text comments, highlights, strikethroughs)
2. What element each annotation is pointing to
3. What the engineer wants fixed or changed

Be extremely thorough — every red mark, every comment, every circled area matters. These are the engineer's exact instructions for what needs to change in the code.

Output as a JSON array:
[
  {
    "page": 1,
    "annotations": [
      {
        "location": "where on the page (top-left, center, near sign X, etc.)",
        "markup_type": "circle/arrow/text/highlight/strikethrough",
        "content": "exact text of any written comment",
        "issue": "what the engineer wants fixed"
      }
    ]
  }
]` },
    ]},
    config: { temperature: 1.0, topP: 0.95, thinkingConfig: { thinkingBudget: 24576 } },
  });

  const text = result?.text || '';
  console.log('Response:', text.length, 'chars');

  const outPath = path.join(__dirname, '..', '..', 'data', 'annotated_review.json');
  fs.writeFileSync(outPath, text, 'utf8');
  console.log('Saved to', outPath);

  // Parse and summarize
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (jsonMatch) {
    try {
      const pages = JSON.parse(jsonMatch[0]);
      console.log('\n=== ANNOTATION SUMMARY ===');
      for (const page of pages) {
        const count = page.annotations?.length || 0;
        console.log(`\nPage ${page.page}: ${count} annotations`);
        for (const a of page.annotations || []) {
          console.log(`  [${a.markup_type}] ${a.location}: ${a.issue}`);
        }
      }
    } catch { console.log('Parse failed — raw text saved'); }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
