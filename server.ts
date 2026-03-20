import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import archiver from 'archiver';
import { createServer as createViteServer } from 'vite';
import { generateCAD } from './server/cadGenerator.js';
import ragRouter from './server/ragRoute.js';

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

// Ensure /tmp directory exists
const tmpDir = path.join(process.cwd(), 'tmp');
if (!fs.existsSync(tmpDir)) {
  fs.mkdirSync(tmpDir);
}

// --- MOUNT BACKEND RAG ROUTE ---
app.use('/api', ragRouter);

// --- MAIN GENERATION ENDPOINT ---
app.post('/api/generate-plan', async (req, res) => {
  try {
    const blueprint = req.body.blueprint;
    const startCoords = req.body.startCoords || null;
    const endCoords = req.body.endCoords || null;
    const staticMapBase64: string | null = req.body.staticMapBase64 || null;

    if (!blueprint) {
      throw new Error("No blueprint provided.");
    }
    
    const dxfPath = path.join(tmpDir, 'output_plan.dxf');
    const pdfPath = path.join(tmpDir, 'output_plan.pdf');
    
    console.log("Starting Deterministic Generation...");
    await generateCAD(blueprint, staticMapBase64, startCoords, endCoords, pdfPath, dxfPath);
    console.log("Deterministic Generation Complete.");

    // Verify files
    const pdfExists = fs.existsSync(pdfPath);
    const dxfExists = fs.existsSync(dxfPath);
    console.log(`File Verification — PDF: ${pdfExists}, DXF: ${dxfExists}`);

    if (!dxfExists) {
      throw new Error("DXF not found after generation.");
    }
    if (!pdfExists) {
      throw new Error("PDF not found after generation.");
    }

    // ZIP and send
    const zipPath = path.join(tmpDir, 'ITD_Plan_Set.zip');
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    
    output.on('close', () => {
      console.log(`ZIP complete. Size: ${archive.pointer()} bytes`);
      res.download(zipPath, 'ITD_Plan_Set.zip', (err) => {
        if (err) console.error("Download error:", err);
        // Cleanup
        [dxfPath, pdfPath, zipPath].forEach(f => {
          if (fs.existsSync(f)) {
            try { fs.unlinkSync(f); } catch(e) { console.warn("Cleanup failed for", f); }
          }
        });
      });
    });
    
    archive.on('error', (err) => {
      console.error("Archive error:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to create zip archive: " + err.message });
      }
    });
    
    archive.pipe(output);
    archive.file(pdfPath, { name: 'output_plan.pdf' });
    archive.file(dxfPath, { name: 'output_plan.dxf' });
    archive.finalize();

  } catch (error: any) {
    console.error("Pipeline Error:", error);
    res.status(500).json({ error: error.message, stack: error.stack });
  }
});

// --- SPEED LIMIT PROXY ---
app.post('/api/speed-limit', async (req, res) => {
  try {
    const { lat, lng } = req.body;
    const apiKey = process.env.GOOGLE_MAPS_PLATFORM_KEY || process.env.GEMINI_API_KEY;
    const url = `https://roads.googleapis.com/v1/speedLimits?path=${lat},${lng}&key=${apiKey}`;
    const response = await fetch(url);
    const data = await response.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch speed limit" });
  }
});

// --- OMNISCIENT CONTEXT PROXY ---
app.post('/api/site-context', async (req, res) => {
  try {
    const { startCoords, endCoords, normalSpeed } = req.body;
    const apiKey = process.env.GOOGLE_MAPS_PLATFORM_KEY || process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY;
    
    const elevUrl = `https://maps.googleapis.com/maps/api/elevation/json?locations=${startCoords.lat},${startCoords.lng}|${endCoords.lat},${endCoords.lng}&key=${apiKey}`;
    const svUrl = `https://maps.googleapis.com/maps/api/streetview?size=600x400&location=${startCoords.lat},${startCoords.lng}&key=${apiKey}`;
    const smUrl = `https://maps.googleapis.com/maps/api/staticmap?center=${startCoords.lat},${startCoords.lng}&zoom=18&size=600x400&maptype=satellite&key=${apiKey}`;

    const [elevRes, svRes, smRes] = await Promise.all([
      fetch(elevUrl).catch(()=>null), fetch(svUrl).catch(()=>null), fetch(smUrl).catch(()=>null)
    ]);

    let elevationContext = "Elevation data unavailable.";
    if (elevRes && elevRes.ok) {
      const elevData = await elevRes.json();
      if (elevData.results?.length === 2) {
        elevationContext = `Start Elev: ${elevData.results[0].elevation.toFixed(2)}m. End Elev: ${elevData.results[1].elevation.toFixed(2)}m.`;
      }
    }

    const toBase64 = async (r: any) => {
      if (!r || !r.ok) return null;
      const arrayBuffer = await r.arrayBuffer();
      return Buffer.from(arrayBuffer).toString('base64');
    };

    res.json({
      elevationContext,
      streetViewBase64: await toBase64(svRes),
      staticMapBase64: await toBase64(smRes)
    });
  } catch (e) {
    console.error("Context proxy error:", e);
    res.status(500).json({ error: "Context fetch failed" });
  }
});

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
