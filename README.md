# ITD Agentic TCP Drafter

An AI-powered, context-aware application for drafting Temporary Traffic Control (TCP) plans for the Idaho Transportation Department.

Instead of relying on static templates or manual CAD drafting, this app uses a multi-agent LLM architecture combined with real-world geospatial and ITD ArcGIS data to engineer, verify, and draft highway work zone plans dynamically.

## Current Capabilities

- **Adaptive TA Selection:** Auto-selects TA-10/18/22/23/30/31/33/35 based on lane count, functional class, and operation type
- **Multi-Lane Road Geometry:** Renders 2-5 lanes with TWLTL, divided median, and lane lines
- **TA-Specific Schematics:** TA-10 (flagger), TA-18 (median crossover), TA-22/23 (shoulder), TA-30/31 (multi-lane), TA-33/35 (divided/interstate)
- **Engineering-Grade Intersections:** Bezier curb returns, CAD masking, stop bars, crosswalks, traffic signal/stop sign symbols
- **MUTCD 11th Edition Compliance:** Table 6C-2 buffer, Table 6C-1 sign spacing, taper formulas, device spacing
- **ITD ArcGIS Integration:** Speed, AADT, lanes, terrain, functional class, crash history, bridges — all auto-fetched
- **3-Layer Cross-Street Detection:** Geocoding + ITD Roads + Gemini Vision analysis
- **Automated MUTCD Compliance Checker:** 8-point validation with PASS/FAIL audit trail
- **Professional Drawing Quality:** PE stamp block, PRELIMINARY watermark, MUTCD sign symbology (orange/white/green), graphical legend, arrowhead dimensions, north arrow, scale bar
- **Queue Analysis Sheet:** AADT-based peak hour volume, HCM queue length estimate, V/C ratio, capacity assessment
- **Special Considerations Sheet:** Night operations, pedestrian/ADA, emergency access, environmental, utility coordination
- **DXF Engine:** 14 CAD layers, multi-lane geometry, channelizing devices, cross-street stubs, dimension annotations, geo-reference

## Output

Drop two pins on a map, select operation type, and generate a downloadable ZIP containing:

| File | Description |
|------|-------------|
| `output_plan.pdf` | Multi-sheet 11x17 tabloid TCP plan set (6-12+ sheets) |
| `output_plan.dxf` | Fully layered CAD file with standard ITD layers |
| `pe_blueprint.json` | Raw AI-generated engineering math (taper, signs, spacing) |
| `engineering_audit_log.txt` | Full audit trail with corrected values and MUTCD compliance checks |

### Plan Set Sheets
1. Cover Sheet & General Notes (with graphical symbology legend)
2. Typical Application schematic (TA-specific)
3. Site-Specific Work Zone Layout (satellite overlay, north arrow, scale bar)
4. Intersection Detail sheets (one per cross-street, up to 6)
5. Traffic Data & Queue Analysis
6. Special Considerations
7. Sign Schedule & Quantities

## Architecture

### Multi-Agent Pipeline
1. **The Librarian (RAG):** Cosine similarity search against `mutcd_2026_vector_db.json` for exact MUTCD paragraphs
2. **The PE Agent (Gemini 3.1 Pro):** Calculates sign sequences, taper lengths, and outputs a structured JSON blueprint
3. **The CAD Generator (Deterministic):** Translates the blueprint into PDF/DXF with post-hoc TA correction, sign code enforcement, and compliance validation

### Data Sources
- **Google Maps Platform:** Roads API, Elevation API, Street View, Static Maps, Directions
- **ITD ArcGIS:** Speed zones, AADT, roadway characteristics, terrain, functional class, crash history, bridges
- **Gemini Vision:** Intersection geometry analysis from satellite imagery

### Post-Hoc Corrections
The PE Agent assumes TA-10 (flaggers). The CAD generator overrides based on actual road data:
- TA-30+ → W20-7a replaced with W20-5, W20-4 replaced with W20-5
- TA-33/35 → Opposing approach signs cleared (divided highway)
- TA-22/23 → W20-7a replaced with W21-5b (shoulder work)
- Device type enforced by duration (short-term → cones, long-term → drums)

## Tech Stack
- **Frontend:** React 18, Vite, Tailwind CSS, Lucide Icons, Framer Motion
- **Backend:** Node.js, Express, `pdfkit`, `dxf-writer`
- **AI/ML:** `@google/genai` — Gemini 3.1 Pro (PE Agent), Gemini 3 Flash (vision), Gemini Embedding 2 (RAG)
- **Maps:** `@vis.gl/react-google-maps` — Google Maps JS API
- **Database/Auth:** Firebase (Firestore, Google Auth)

## Setup

```bash
# Install dependencies
npm install
cd backend && npm install

# Configure environment
cp .env.example .env
# Add GOOGLE_API_KEY, GEMINI_API_KEY, Firebase config

# Run
cd backend && npm run dev   # Backend on :3001
npm run dev                  # Frontend on :5173
```

## Roadmap
- [x] Phase 1: Lane-aware TA selection + multi-lane geometry
- [x] Phase 2: Engineering-grade intersection details + DXF engine
- [x] Phase 3: TA-specific schematics (TA-10/18/22/23/30/31/33/35)
- [x] Phase 4: Professional drawing quality (symbology, PE stamp, legend)
- [x] Phase 5: Additional sheets (queue analysis, special considerations)
- [x] Phase 6 (partial): MUTCD compliance checker + audit trail
- [ ] Phase 6 (complete): Full automated compliance validation
- [ ] Detour plan sheets
- [ ] Multi-phase operation support
