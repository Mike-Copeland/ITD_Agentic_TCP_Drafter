import { GoogleGenAI } from '@google/genai';
import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';

// --- LOAD VECTOR DB INTO SERVER RAM (ONCE) ---
const dbPath = path.join(process.cwd(), 'public', 'mutcd_2026_vector_db.json');
let mutcdData: any[] = [];

try {
  const raw = fs.readFileSync(dbPath, 'utf8');
  mutcdData = JSON.parse(raw);
  console.log(`[RAG] Loaded ${mutcdData.length} pages from MUTCD vector database into server RAM.`);
} catch (e) {
  console.error('[RAG] CRITICAL: Failed to load mutcd_2026_vector_db.json', e);
}

// --- MATH ---
function cosineSimilarity(vecA: number[], vecB: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dot += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// --- CORE MUTCD MATH TABLES (injected to prevent LLM hallucination) ---
const CORE_TABLES = `
--- CORE MUTCD MATH TABLES ---
TABLE 6B-1 (Advance Warning Spacing A, B, C):
- Urban (Low Speed <=40mph): A=100ft, B=100ft, C=100ft.
- Urban (High Speed >40mph): A=350ft, B=350ft, C=350ft.
- Rural: A=500ft, B=500ft, C=500ft.
- Expressway/Freeway: A=1000ft, B=1500ft, C=2640ft.
TABLE 6B-3 & 6B-4 (Taper Length L):
- Merging Taper: L = W*S (for >=45mph), L = (W*S^2)/60 (for <=40mph).
- Shifting Taper: 0.5 * L.
- Shoulder Taper: 0.33 * L.
- One-Lane, Two-Way Traffic Taper (Flagger): 50 ft minimum, 100 ft maximum.
- Downstream Taper: 50 ft minimum, 100 ft maximum.
`;

// --- EXPRESS ROUTER ---
const ragRouter = Router();

ragRouter.post('/rag', async (req: Request, res: Response) => {
  try {
    const { operationType, speedLimit, siteContext } = req.body;

    if (!operationType || !speedLimit) {
      return res.status(400).json({ error: 'operationType and speedLimit are required.' });
    }

    // 1. Embed the query using server-side API key (NEVER exposed to browser)
    const apiKey = process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY || '';
    if (!apiKey) {
      return res.status(500).json({ error: 'Server GEMINI_API_KEY not configured.' });
    }

    const ai = new GoogleGenAI({ apiKey });
    const searchQuery = `Temporary Traffic Control layout rules and MUTCD Typical Application (TA) for ${operationType} on a highway with a speed limit of ${speedLimit} mph. Critical Site Context: ${siteContext || 'None'}`;

    const embedResponse = await ai.models.embedContent({
      model: 'gemini-embedding-2-preview',
      contents: searchQuery,
    });

    const queryVector = embedResponse.embeddings[0].values;

    // 2. O(N) cosine similarity search (fast in server RAM, ~50ms for 200 pages)
    let bestMatch: any = null;
    let maxSim = -1;

    for (const page of mutcdData) {
      if (page.page_number === 0) continue;
      const sim = cosineSimilarity(queryVector, page.embedding);
      if (sim > maxSim) {
        maxSim = sim;
        bestMatch = page;
      }
    }

    if (bestMatch) {
      return res.json({
        text: `[RAG MATCH: Page ${bestMatch.page_number} | Layout: ${bestMatch.layout_name}]\nRULES: ${bestMatch.engineering_rules}\nSUMMARY: ${bestMatch.dense_summary}\n${CORE_TABLES}`,
        image_base64: bestMatch.diagram_base64 || null
      });
    }

    return res.json({
      text: 'No MUTCD rules found in database. Rely on standard MUTCD math.' + CORE_TABLES,
      image_base64: null
    });

  } catch (e: any) {
    console.error('[RAG] Error:', e.message);
    return res.status(500).json({
      text: 'RAG Engine failed. Rely on standard MUTCD math.' + CORE_TABLES,
      image_base64: null
    });
  }
});

export default ragRouter;
