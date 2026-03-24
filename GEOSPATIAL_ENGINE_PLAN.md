# Geospatial Engineering Engine — Implementation Plan

## Overview
Upgrade from "stick figure" schematics to commercial-grade, true-geometry plan sheets that show actual road shapes, curves, roundabouts, and divided highways at proper scale with station-based referencing.

**Consensus Architecture** (Claude Opus + Gemini 3.1 Pro, validated):
- Primary Alignment + Opposing Alignment (divided highways)
- UTM Zone 11N/12N projection (not Web Mercator)
- Linear Referencing System (LRS) with stationing
- Parallel curve offsetting (no bowties)
- Strip-map format for multi-mile projects
- OSM cross-street geometry harvesting
- Accuracy disclaimer: schematic-level (~5m), not survey-grade

## Phase 1: UTM Projection & LRS Engine
**File:** `backend/engineering/GeospatialEngine.ts`

### What it does:
- Takes GPS polyline points → projects to UTM Zone 11N or 12N (US Survey Feet)
- Calculates cumulative chainage (stationing) along the projected polyline
- Provides `getCoordinatesAtStation(stationFt)` → `{x, y, heading}`
- Auto-detects UTM zone from longitude (-114° boundary between 11N/12N)

### Dependencies:
- `proj4` — coordinate projection library
- Route polyline (already available from Google Directions API via `decodePolyline()`)

### Key Methods:
```typescript
class ProjectAlignment {
  constructor(gpsPoints: {lat, lng}[], anchorStation?: number)
  totalLengthFt: number
  getCoordinatesAtStation(stationFt: number): { x: number, y: number, heading: number }
  getStationAtFraction(fraction: number): number
  getUtmPoints(): [number, number][]
}
```

## Phase 2: Parallel Curve Offsetting
**File:** `backend/engineering/GeospatialEngine.ts` (additional methods)

### What it does:
- Generates road edge polylines by offsetting the centerline ± lane width
- Handles sharp curves without self-intersecting "bowtie" artifacts
- Generates work zone polygons between two stations and offsets

### Key Methods:
```typescript
getOffsetPolyline(offsetFt: number): [number, number][]
getWorkZonePolygon(startSta: number, endSta: number, leftOffset: number, rightOffset: number): [number, number][]
```

### Algorithm:
- Use perpendicular offset with miter-limit for gentle curves
- For sharp curves (angle change > 30°), use arc insertion
- Post-process to remove any self-intersections

## Phase 3: Strip-Map Viewport Generator
**File:** `backend/engineering/SheetLayoutEngine.ts`

### What it does:
- Slices long projects into sequential 11x17 sheet viewports
- Each viewport covers ~1,500 ft at 1"=100' scale
- Rotates viewport to keep road roughly horizontal on page
- Provides 50-ft matchline overlap between sheets

### Key Methods:
```typescript
interface Viewport {
  sheetNumber: number
  startStation: number
  endStation: number
  centerX: number
  centerY: number
  rotationDeg: number
  scaleFactor: number
}

function generateViewports(alignment: ProjectAlignment, maxCoverageFt?: number): Viewport[]
```

## Phase 4: CAD Integration
**File:** `backend/generators/cadGenerator.ts` (updates)

### What it does:
- New sheet type: "Geometry Plan" using real road shape
- Loops through viewports, generates one sheet per viewport
- Places signs, devices, flaggers at correct stations along real geometry
- Draws road edges from offset polylines
- Work zone hatching from real polygons
- Cross-street stubs at actual angles

### Legal:
- Title block disclaimer: "SCHEMATIC LEVEL ACCURACY (~5m). NOT FOR SURVEY-GRADE STAKING."
- DXF exports in UTM coordinates for Civil 3D import

## Phase 5: Divided Highway & Cross-Street Enhancement
- Reverse-route query for opposing alignment on divided highways
- OSM cross-street mini-polylines for accurate approach angles
- Skew angle calculation at intersection points

## Data Flow:
```
Google Directions → routePolyline (encoded)
    ↓
decodePolyline() → GPS points [{lat, lng}]
    ↓
ProjectAlignment → UTM points + LRS stations
    ↓
SheetLayoutEngine → Viewports[]
    ↓
cadGenerator → PDF/DXF sheets with real geometry
```

## Testing:
- Run 15-location automated test suite
- Visual review via Gemini 3.1 Pro
- CI pipeline debate (Opus + Gemini)
- Focus on: roundabout geometry, curved mountain roads, divided highways, long corridors

## Status:
- [ ] Phase 1: UTM + LRS
- [ ] Phase 2: Parallel offset
- [ ] Phase 3: Strip-map
- [ ] Phase 4: CAD integration
- [ ] Phase 5: Divided + cross-streets
