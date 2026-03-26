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

  // Load MUTCD PDF for sign face reference
  const mutcdPath = path.join(__dirname, '..', '..', 'data', 'reference', 'mutcd_part6.pdf');
  const mutcdB64 = fs.readFileSync(mutcdPath).toString('base64');
  console.log('MUTCD PDF:', Math.round(fs.statSync(mutcdPath).size / 1024), 'KB');

  // Load both plan PDFs
  const pdf72 = fs.readFileSync('C:\\Users\\mcopelan\\AppData\\Local\\Temp\\zip72_inspect\\output_plan.pdf').toString('base64');
  const pdf73 = fs.readFileSync('C:\\Users\\mcopelan\\AppData\\Local\\Temp\\zip73_inspect\\output_plan.pdf').toString('base64');
  console.log('PDF 72:', Math.round(Buffer.from(pdf72, 'base64').length / 1024), 'KB');
  console.log('PDF 73:', Math.round(Buffer.from(pdf73, 'base64').length / 1024), 'KB');

  // Task 1: Look up MUTCD sign face text formatting
  console.log('\n=== TASK 1: MUTCD Sign Face Text Lookup ===');
  const signResult = await ai.models.generateContent({
    model: 'gemini-3.1-pro-preview',
    contents: { parts: [
      { inlineData: { data: mutcdB64, mimeType: 'application/pdf' } },
      { text: `Look at the MUTCD Part 6 PDF. Find the illustrations/figures showing what the following warning signs look like on their FACE (the text that appears ON the sign itself, how it's arranged/wrapped):

1. W20-1 (ROAD WORK AHEAD)
2. W20-4 (ONE LANE ROAD AHEAD)
3. W20-7a (FLAGGER AHEAD or FLAGGER symbol)
4. W3-5 (REDUCED SPEED XX MPH AHEAD)
5. G20-2 (END ROAD WORK)

For each sign, tell me:
- The exact text shown on the sign face
- How the text is wrapped/arranged (line breaks)
- The sign shape (diamond, rectangle, etc.)
- The color scheme (background, text, border)

Output JSON:
{
  "signs": [
    {
      "code": "W20-1",
      "face_text": ["ROAD", "WORK", "AHEAD"],
      "shape": "diamond",
      "background": "orange",
      "text_color": "black",
      "border": "black"
    }
  ]
}` },
    ]},
    config: { temperature: 1.0, topP: 0.95, thinkingConfig: { thinkingBudget: 24576 } },
  });
  const signText = signResult?.text || '';
  console.log(signText.substring(0, 2000));
  fs.writeFileSync(path.join(__dirname, '..', '..', 'data', 'mutcd_sign_faces.json'), signText, 'utf8');

  // Task 2: Visual review of both PDFs
  console.log('\n=== TASK 2: Compare ZIP 72 (no site context) vs ZIP 73 (with site context) ===');
  const compareResult = await ai.models.generateContent({
    model: 'gemini-3.1-pro-preview',
    contents: { parts: [
      { inlineData: { data: pdf72, mimeType: 'application/pdf' } },
      { inlineData: { data: pdf73, mimeType: 'application/pdf' } },
      { text: `Two TCP plan PDFs for the same road (SH-14).
PDF 1 (first document) was generated WITHOUT using the "Analyze Site Context" button — it defaulted to 65 MPH.
PDF 2 (second document) was generated WITH the site context analysis — it correctly detected 45 MPH.

Compare EVERY page of both documents side by side. For each page:
1. What differences do you see between the two versions?
2. Which version is better and why?
3. What visual issues exist in EITHER version?

Focus on: sign text readability, layout quality, engineering accuracy, professional appearance.

Output JSON:
{
  "comparison": [
    {
      "page": N,
      "pdf1_description": "what you see in PDF 1",
      "pdf2_description": "what you see in PDF 2",
      "differences": ["list of differences"],
      "better_version": "PDF 1 or PDF 2",
      "issues_in_either": ["visual problems"]
    }
  ],
  "overall_verdict": "which is better overall and why",
  "sign_text_issues": ["any sign face text that is unreadable, missing, or incorrectly formatted"]
}` },
    ]},
    config: { temperature: 1.0, topP: 0.95, thinkingConfig: { thinkingBudget: 24576 } },
  });
  const compareText = compareResult?.text || '';
  console.log('\nComparison response:', compareText.length, 'chars');
  fs.writeFileSync(path.join(__dirname, '..', '..', 'data', 'zip72_73_comparison.json'), compareText, 'utf8');

  // Print summary
  const jsonMatch = compareText.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const comp = JSON.parse(jsonMatch[0]);
      console.log('\nOverall:', comp.overall_verdict);
      console.log('\nSign text issues:');
      (comp.sign_text_issues || []).forEach((s: string) => console.log('  -', s));
    } catch { console.log('Parse failed'); }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
