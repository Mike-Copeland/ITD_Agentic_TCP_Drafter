import { GoogleGenAI } from '@google/genai';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const apiKey = process.env.GEMINI_API_KEY || (import.meta as any)?.env?.VITE_GEMINI_API_KEY || process.env.GOOGLE_MAPS_PLATFORM_KEY || '';
const genAI = new GoogleGenAI({ apiKey });

export async function generateAgenticCAD(blueprint: any, siteContext: string, pdfPath: string) {
    const history: any[] = [];
    let round = 1;
    const maxRounds = 3;
    let currentCode = "";
    
    // Step 1: Initial Drafting
    const drafterPromptBase = `You are a Senior TTC Engineer. Write a standalone Node.js script using PDFKit to draw an 11x17 landscape Temporary Traffic Control (TTC) plan.
    
    BLUEPRINT: ${JSON.stringify(blueprint)}
    SITE CONTEXT: ${siteContext}
    
    REQUIREMENTS:
    - Use strict geometric coordinates (11x17 tabloid landscape: 1224x792 points).
    - Grounds your design in MUTCD standards and the physical location geography.
    - Output only raw JavaScript code.
    - IMPORTANT: Use const PDFDocument = require('pdfkit'); and literally this write stream execution to perfectly save your file without crashing: const fs = require('fs'); const doc = new PDFDocument({ size: 'tabloid', layout: 'landscape', margin: 0 }); doc.pipe(fs.createWriteStream('${pdfPath.replace(/\\/g, '\\\\')}'));
    `;

    console.log(`--- AGENTIC DRAFTER ROUND 1 (Initial) ---`);
    const initialPrompt = { role: 'user', parts: [{ text: drafterPromptBase }] };
    const initialRes = await genAI.models.generateContent({
        model: 'gemini-3.1-pro-preview',
        contents: [initialPrompt],
    });

    currentCode = cleanCode(initialRes.text || "");
    history.push(initialPrompt);
    history.push({ role: 'model', parts: [{ text: initialRes.text || "" }] });

    // Step 2: Peer Review & Revision Loops
    while (round < maxRounds) {
        round++;
        console.log(`--- AGENTIC DRAFTER ROUND ${round} (Peer Review) ---`);
        
        const peerReviewPromptText = `Please review your response, acting as a technical peer reviewer with constructive criticism, identify where your response may have flaws or uncertainty (grounded in MUTCD safety and the geographical context), and include corrections to rectify those issues. revise and resubmit the full updated Node.js script. Output only raw JavaScript code.`;
        const reviewPrompt = { role: 'user', parts: [{ text: peerReviewPromptText }] };

        const reviewRes = await genAI.models.generateContent({
            model: 'gemini-3.1-pro-preview',
            contents: [...history, reviewPrompt],
        });

        const newCode = cleanCode(reviewRes.text || "");
        history.push(reviewPrompt);
        history.push({ role: 'model', parts: [{ text: reviewRes.text || "" }] });
        
        if (newCode === currentCode) {
            console.log("No changes made in review loop. Breaking.");
            break;
        }
        currentCode = newCode;
    }

    // Step 3: Execution
    // We wrap the generated code in a synchronous completion pattern to ensure
    // the PDF file is FULLY written to disk before execSync returns.
    const formattedPdfPath = pdfPath.replace(/\\/g, '\\\\');

    const wrappedCode = `
const { execSync } = require('child_process');
// ---- AI GENERATED CODE START ----
${currentCode}
// ---- AI GENERATED CODE END ----
// Ensure the PDF is fully flushed before the process exits
if (typeof doc !== 'undefined' && doc && typeof doc.end === 'function') {
  doc.on('finish', () => { process.exit(0); });
  doc.on('error', (e) => { console.error('PDF doc error:', e); process.exit(1); });
  doc.end();
} else {
  console.warn('doc not found or already finalized');
  process.exit(0);
}
`;

    const tmpDir = path.join(process.cwd(), 'tmp');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir);
    
    const scriptPath = path.join(tmpDir, 'agentic_script.js');
    fs.writeFileSync(scriptPath, wrappedCode, 'utf8');
    
    console.log(`Executing Agentic Script...`);
    execSync(`node "${scriptPath}"`, { stdio: 'pipe' }); // use 'pipe' to capture output
    console.log(`Agentic Script Exited`);

    // Verify the PDF was actually written
    let waited = 0;
    while (!fs.existsSync(pdfPath) && waited < 5000) {
        await new Promise(r => setTimeout(r, 200));
        waited += 200;
    }

    if (fs.existsSync(pdfPath)) {
        console.log(`Agentic Draft Complete: ${pdfPath}`);
    } else {
        console.error(`Agentic PDF not found at ${pdfPath} after execution!`);
    }
}

function cleanCode(text: string): string {
    return text.replace(/```(?:javascript|js)?\n?/gi, '').replace(/```/g, '').trim();
}
