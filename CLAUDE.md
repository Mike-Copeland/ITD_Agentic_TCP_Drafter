**SYSTEM INSTRUCTION:** You are an Expert Software Engineer building the ITD Agentic TCP Drafter. Do NOT act as the traffic engineer; your job is to build the Node/TypeScript backend that orchestrates the traffic engineering agents.

# ITD Agentic TCP Drafter: Detailed Architectural Blueprint & Implementation Guide

## 0. The Ultimate Objective & End Goal

**The Business Objective:**
Currently, creating a Temporary Traffic Control (TCP) plan for the Idaho Transportation Department (ITD) requires a human engineer to manually calculate MUTCD taper lengths, check physical site constraints (like hills or curves), and manually draft CAD files. This process is slow and error-prone. This application automates that entire process using an AI-driven, multi-agent "Co-Research" loop.

**The End Goal (The Deliverable):**
The system is not finished until a user can drop two pins on a map, click "Generate", and within 60 seconds receive a downloadable ZIP file containing a perfectly accurate, mathematically sound, professional-grade TCP Plan Set.

The generated ZIP file MUST contain exactly these 4 artifacts:
*   **output_plan.pdf:** A multi-page 11x17 (Tabloid Landscape) PDF.
    *   *Sheet 1:* A linear, unscaled schematic of the typical application (TA) with exact MUTCD dimension lines.
    *   *Sheet 2:* A geo-stamped satellite overlay of the actual work zone, plotting the exact GPS coordinates of the start/end pins.
    *   *Sheet 3+ (Optional):* Specific intersection or detour layouts if the AI detects cross-streets.
*   **output_plan.dxf:** A fully layered CAD file mimicking the PDF schematic, with standard CAD layers (L-ROAD-EDGE, L-TTC-WORK, L-TTC-SIGN).
*   **pe_blueprint.json:** The raw, AI-generated JSON math (taper lengths, sign distances) proving the design is anchored in reality.
*   **engineering_audit_log.txt:** A transcript proving the "Judge" and "Reviewer" AI agents audited the "Drafter" AI agent's work and forced corrections before delivery.

## 1. System Overview & Core Tenets

### 1.1 Core Tenets (DO NOT VIOLATE)
*   **Zero Data Slosh (Crucial):** The frontend React app is ONLY a lightweight UI. It sends coordinates and receives text. DO NOT send megabytes of Base64 images from the frontend to the backend just to send them back again. Heavy payloads live entirely on the backend in a Session Cache to prevent browser crashes.
*   **Deterministic CAD:** LLMs do not draw PDFs directly. They are terrible at spatial reasoning. They must output strict JSON math blueprints. A deterministic Node.js script uses `pdfkit` and `dxf-writer` to do the actual geometric drawing based on those numbers.
*   **Consensus-Driven QA:** No plan is delivered to the user until a simulated "Judge" agent agrees that the visual PDF draft meets safety standards.

## 2. Explicit Directory & State Architecture

To prevent spaghetti code, the repository MUST be organized as follows. Do not mix frontend React code with backend Express routes.

```text
/itd-agentic-tcp-drafter
├── /frontend                  # React (Vite) + Tailwind CSS + Mapbox
│   ├── /src/components        # UI Components (Map, Sidebar, Setup Forms)
│   └── /src/api               # Fetch wrappers calling backend /api/* routes
├── /backend                   # Express.js Server (Node.js)
│   ├── /routes                # Express route controllers (build-corpus, generate-plans)
│   ├── /agents                # The AI logic (PE, Drafter, Reviewer, Judge prompts)
│   ├── /services              # Google Maps API fetchers, RAG vector search logic
│   └── /generators            # The base cadGenerator.ts templates
├── /data                      # Static proprietary assets (Never exposed to public web)
│   └── mutcd_2026_vector_db.json # The RAG database (Must be read via fs.readFileSync)
├── /tmp                       # Ephemeral storage for CAD execution (Wiped per session)
└── server.ts                  # Main Express entry point
```

### 2.1 The Backend Session State (The "Corpus")
Because we aren't passing images back and forth, the backend must hold a Session object in memory.

```typescript
interface SessionData {
  sessionId: string;
  startCoords: { lat: number, lng: number };
  endCoords: { lat: number, lng: number };
  speedLimitMph: number;
  elevationData: any;          // From Google Elevation API
  streetViewImages: string[];  // Array of Base64 encoded strings
  satelliteImage: string;      // Base64 encoded string
  narrativeText: string;       // The text the user approved
  peBlueprintJson?: any;       // Populated in Phase 3
}

// Store this in a global Map or Redis instance
const globalSessionStore = new Map<string, SessionData>();
```

## 3. The 5-Phase Pipeline (Step-by-Step Data Flow)

### Phase 1: Initiation & The Context Corpus
*   **Goal:** Gather all geographic and regulatory truth on the server before making a single drafting decision.
*   **User Input:** User drops a Start Pin and End Pin.
*   **API Trigger:** Frontend sends `POST /api/build-corpus` with coordinates.
*   **Backend Action:** Generate sessionId. Fetch Speed limit, Elevation, StreetView images, and Satellite images. Save images to `globalSessionStore` as Base64. Prompt AI to write a "Site Condition Narrative".
*   **UI Response:** Backend returns `{ sessionId, narrativeText }`. Frontend displays text for user editing.

### Phase 2: Ground Truth MUTCD Injection (Local RAG)
*   **Goal:** Prevent AI hallucination by finding the exact MUTCD rulebook paragraph for this specific road.
*   **Trigger:** User clicks "Generate Plans". Frontend sends `{ sessionId, finalizedNarrative }` to `POST /api/generate-agentic-plans`.
*   **Backend Action:** Uses Cosine Similarity to compare the narrative against `data/mutcd_2026_vector_db.json`.
*   **Payload Construction:** Extracts the top 3 matching Typical Applications (e.g., "TA-10 Lane Closure on Two-Lane Road").

### Phase 3: Senior PE Agent Fact-Checking & JSON Blueprint
*   **Goal:** Translate narrative + rules into raw mathematical coordinates. No code is written here.
*   **The Prompt:** The "Senior PE" Agent is fed the Base64 images from the Session Store, the RAG Tables, and the Narrative.
*   **The Task:** Calculate exact taper lengths, advance warning sign distances, and sheet layouts.
*   **Structured Output:** The Agent MUST output valid JSON using the response schema tool:

```json
{
  "sheets":[
    { 
      "sheet_number": 1,
      "type": "linear_schematic", 
      "ta_code": "TA-10",
      "taper_length_ft": 660,
      "primary_approach_signs":[
        {"code": "W20-1", "distance_ft": 1000, "label": "ROAD WORK AHEAD"},
        {"code": "W20-4", "distance_ft": 500, "label": "ONE LANE ROAD AHEAD"}
      ]
    }
  ],
  "engineering_notes": "Added 1.5x distance multiplier due to 6% downgrade."
}
```

### Phase 4: The Iterative Drafter-Reviewer Loop (The Core Engine)
*   **Goal:** Write CAD code, run it, visually look at the output, and fix it if it's broken.
*   **Initial Draft:** The Drafter Agent gets the PE's JSON blueprint and the base `cadGenerator.ts` source code string. The Drafter writes a standalone Node.js script to draw the PDF.
*   **Execution:** Backend saves script to `/tmp/{sessionId}/draft_1.js` and runs `execSync('node draft_1.js')`. This creates `draft_1.pdf`.
*   **The Reviewer Agent:** Backend converts `draft_1.pdf` into a Base64 PNG image. The Reviewer Agent looks at the PDF image and compares it to the PE's JSON. It outputs a JSON list of defects: `["The W20-1 text overlaps the dimension line on Sheet 1", "Missing downstream taper"]`.
*   **The Judge Agent:** Reads the Reviewer's defects. If empty, the Judge approves! Proceed to Phase 5. If defects exist, it sends them back to the Drafter: "You failed. Fix these exact issues and rewrite the code." (Loops max 3 times).

### Phase 5: Archiving and Delivery
*   **Goal:** Package the artifacts and clean up.
*   **Action:** The backend uses the `archiver` npm package. It zips: `output_plan.pdf`, `output_plan.dxf`, `engineering_audit_log.txt`, and `pe_blueprint.json`.
*   **Delivery:** The Express route streams the Zip file back to the browser using `res.download()`.
*   **Cleanup:** Delete `/tmp/{sessionId}` entirely. Remove the sessionId from `globalSessionStore`.

## 4. Strict API Contract Specifications

### 4.1 Server Configuration (Required in server.ts)
```typescript
// MUST BE INCLUDED: Prevents crashes when processing large API payloads internally
app.use(express.json({ limit: '50mb' })); 
app.use(express.urlencoded({ limit: '50mb', extended: true }));
```

### 4.2 Endpoint: POST /api/build-corpus
*   **Request:** `{ startCoords: {lat, lng}, endCoords: {lat, lng}, operationType: "Single Lane Closure" }`
*   **Response:** `{ sessionId: "abc-123-uuid", narrativeText: "...", speedLimit: 55 }`

### 4.3 Endpoint: POST /api/generate-agentic-plans
*   **Request:** `{ sessionId: "abc-123-uuid", finalizedNarrative: "..." }`
*   **Response:** HTTP Zip Stream (`application/zip`).

## 6. Known Failure Modes & Defensive Engineering
If you skip these, the app will crash in production.

*   **Node `execSync` Sandboxing (CRITICAL RCE PREVENTION):** The LLM-generated CAD script must NOT have access to the broader file system. Do not allow the script to require modules other than `pdfkit`, `dxf-writer`, and `fs`. Ensure the execution directory is strictly limited to the temporary UUID folder.
*   **The "Unfinished PDF" Crash:** When running `execSync('node script.js')`, if the script exits before pdfkit finishes writing the file to disk, the PDF will be blank.
    *   *Fix:* The Drafter prompt MUST enforce the `doc.on('finish', () => process.exit(0))` rule. Wrap `execSync` in a try/catch with a timeout: `15000` to prevent infinite hanging.
*   **Node Relative Pathing in RAG:** Do NOT use `fetch('/mutcd.json')` in your backend Node.js files or expose proprietary DB files in the `/public` static routes.
    *   *Fix:* Use `const dbPath = path.join(process.cwd(), 'data', 'mutcd_2026_vector_db.json'); JSON.parse(fs.readFileSync(dbPath));`
*   **API Rate Limiting:** The loop calls the AI up to 8 times. You will hit a 429 RESOURCE_EXHAUSTED error.
    *   *Fix:* Wrap API calls in a retry loop with exponential backoff (1s, 2s, 4s).
*   **Concurrency & File Overwrites:** If User A and User B click "Generate" simultaneously, `/tmp/output.pdf` will be overwritten.
    *   *Fix:* Always use the UUID: `path.join(process.cwd(), 'tmp', sessionId, 'output_plan.pdf')`.