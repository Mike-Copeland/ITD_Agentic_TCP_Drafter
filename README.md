# ITD Agentic TCP Drafter

An AI-powered, context-aware application for drafting Temporary Traffic Control (TCP) plans. 

Instead of relying on static templates or manual CAD drafting, this app uses a multi-agent LLM architecture combined with real-world geospatial data to engineer, verify, and draft highway work zone plans dynamically.

## The Logic: Why It's Built This Way

This app isn't just a wrapper around a single LLM prompt. It is a deterministic, multi-step engineering pipeline designed to prevent hallucinations and account for real-world physics.

### 1. Multi-Agent Architecture (The Pipeline)
We split the cognitive load across specialized AI agents to optimize for both accuracy and cost:
* **The Librarian (Deterministic Lookup):** Fast and cost-effective. Its only job is to retrieve the textbook MUTCD and ITD guidelines (taper lengths, channelizer spacing) based on the speed limit and operation type using a static JSON file.
* **The Professional Engineer (Gemini 3.1 Pro):** The high-reasoning engine. It fact-checks the Librarian's math, applies the geographical context, and calculates bi-directional signing sequences, outputting a structured JSON blueprint.
* **The CAD Drafter (Deterministic Engine):** Translates the PE's verified JSON blueprint into PDF and DXF files using a deterministic Node.js backend.

### 2. Geospatial & Physics Awareness
Textbook math fails in the real world if you don't account for the environment. The app injects real-time Google Maps Platform data directly into the AI's context window:
* **Roads API:** Automatically snaps to the dropped pin and fetches the actual posted speed limit.
* **Elevation API:** Calculates the grade/slope between the start and end pins. If there's a steep downgrade, the PE Agent mathematically increases advance warning sign spacing to account for commercial truck braking distances.
* **Multimodal Vision:** Pulls Street View and Satellite imagery of the coordinates so the AI can "see" physical constraints like narrow shoulders, blind curves, or canyon walls.
* **Search Grounding:** Uses Google Search to identify the specific highway and remind the designer of historical AADT (Annual Average Daily Traffic) considerations.

### 3. Dynamic Backend Generation
LLMs cannot natively output binary `.pdf` or `.dxf` files. 
To solve this, the Drafter Agent outputs a structured JSON blueprint. The React frontend sends this JSON to our Express backend, which uses a deterministic rendering engine (`pdfkit` and `dxf-writer`) to generate the files, and returns a downloadable ZIP/Blob to the user.

## Tech Stack
* **Frontend:** React 18, Vite, Tailwind CSS, Lucide Icons, Framer Motion.
* **Backend:** Node.js, Express.
* **AI/ML:** `@google/genai` (Gemini 3.1 Pro Preview).
* **Geospatial:** Google Maps Platform (Maps JavaScript API, Roads API, Elevation API, Street View Static API).
* **Database/Auth:** Firebase (Firestore, Google Auth).
