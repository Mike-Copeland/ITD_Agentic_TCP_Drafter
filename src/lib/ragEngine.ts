import { GoogleGenAI } from '@google/genai';

function cosineSimilarity(vecA: number[], vecB: number[]) {
    let dotProduct = 0, normA = 0, normB = 0;
    for (let i = 0; i < vecA.length; i++) {
        dotProduct += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

export async function retrieveMutcdRules(operationType: string, speedLimit: number, siteContext: string) {
    try {
        // 1. Asynchronously fetch the massive JSON from the public folder
        const response = await fetch('/mutcd_2026_vector_db.json');
        if (!response.ok) throw new Error("JSON not found");
        const mutcdData = await response.json();

        // 2. Embed the query
        const { getConfig } = await import('../config');
        const cfg = await getConfig();
        const ai = new GoogleGenAI({ apiKey: cfg.geminiApiKey });
        const searchQuery = `Temporary Traffic Control layout rules and MUTCD Typical Application (TA) for ${operationType} on a highway with a speed limit of ${speedLimit} mph. Critical Site Context: ${siteContext}`;

        const embedResponse = await ai.models.embedContent({
            model: 'gemini-embedding-2-preview',
            contents: searchQuery,
        });

        const queryVector = embedResponse.embeddings[0].values;
        let bestMatch: any = null;
        let maxSim = -1;

        // 3. Search the loaded data
        for (const page of mutcdData) {
            if (page.page_number === 0) continue; // Skip placeholder
            const sim = cosineSimilarity(queryVector, page.embedding);
            if (sim > maxSim) {
                maxSim = sim;
                bestMatch = page;
            }
        }

        if (bestMatch) {
            const coreTables = `
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

            return {
                text: `[RAG MATCH: Page ${bestMatch.page_number} | Layout: ${bestMatch.layout_name}]\nRULES: ${bestMatch.engineering_rules}\nSUMMARY: ${bestMatch.dense_summary}\n${coreTables}`,
                image_base64: bestMatch.diagram_base64 || null
            };
        }
        return { text: "No MUTCD rules found in database. Rely on standard MUTCD math.", image_base64: null };
    } catch (e) {
        console.error("RAG Engine failed", e);
        return { text: "RAG Engine failed. Rely on standard MUTCD math.", image_base64: null };
    }
}
