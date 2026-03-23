import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import path from 'path';
import archiver from 'archiver';
import { fileURLToPath } from 'url';
import { generateCAD } from './generators/cadGenerator.js';
// Agentic loop disabled — it bypassed all cadGenerator fixes. Re-enable via ENABLE_AGENTIC=true.
// import { runAgenticLoop } from './agents/agenticLoop.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = parseInt(process.env.PORT || '3001', 10);

// ---------------------------------------------------------------------------
// CRITICAL: 50 MB JSON limit — prevents crashes when processing large
// Base64 image payloads between agents (see CLAUDE.md §4.1)
// ---------------------------------------------------------------------------
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// ---------------------------------------------------------------------------
// Ensure /tmp directory exists for ephemeral CAD artifacts
// ---------------------------------------------------------------------------
const tmpDir = path.join(__dirname, '..', 'tmp');
if (!fs.existsSync(tmpDir)) {
  fs.mkdirSync(tmpDir, { recursive: true });
}

// ---------------------------------------------------------------------------
// UTILITY: Exponential-backoff fetch (retries on 429 / 503 / network errors)
// ---------------------------------------------------------------------------
async function fetchWithRetry(url: string, init?: RequestInit, maxRetries = 3): Promise<Response> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, init);
      if (res.ok) return res;
      if ((res.status === 429 || res.status === 503) && attempt < maxRetries) {
        await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000));
        continue;
      }
      return res; // non-retryable status — return as-is so caller can inspect
    } catch (err) {
      if (attempt === maxRetries) throw err;
      await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000));
    }
  }
  throw new Error('fetchWithRetry: unreachable');
}

// ---------------------------------------------------------------------------
// UTILITY: Google Encoded Polyline decoder (RFC: Encoded Polyline Algorithm)
// Converts the compact ASCII string from the Directions API into lat/lng pairs.
// ---------------------------------------------------------------------------
export function decodePolyline(encoded: string): { lat: number; lng: number }[] {
  const points: { lat: number; lng: number }[] = [];
  let index = 0, lat = 0, lng = 0;
  while (index < encoded.length) {
    let result = 0, shift = 0, b: number;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    result = 0; shift = 0;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);
    points.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return points;
}

// ---------------------------------------------------------------------------
// ITD ArcGIS REST API — Authoritative Idaho road segment data
// ---------------------------------------------------------------------------
const ITD_BASE = 'https://gis.itd.idaho.gov/arcgisprod/rest/services/ArcGISOnline';

async function queryITDLayer(serviceGroup: string, layerId: number, lat: number, lng: number, distanceMeters = 200, maxRecords = 1): Promise<any[]> {
  const url = `${ITD_BASE}/${serviceGroup}/MapServer/${layerId}/query?geometry=${lng},${lat}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&distance=${distanceMeters}&units=esriSRUnit_Meter&outFields=*&returnGeometry=false&f=json&resultRecordCount=${maxRecords}`;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000); // 8s timeout per query
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return [];
    const data = await res.json() as any;
    return data.features?.map((f: any) => f.attributes) || [];
  } catch { return []; }
}

async function queryITDCount(serviceGroup: string, layerId: number, lat: number, lng: number, distanceMeters = 500): Promise<number> {
  const url = `${ITD_BASE}/${serviceGroup}/MapServer/${layerId}/query?geometry=${lng},${lat}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&distance=${distanceMeters}&units=esriSRUnit_Meter&returnGeometry=false&returnCountOnly=true&f=json`;
  try {
    const res = await fetchWithRetry(url);
    if (!res.ok) return 0;
    const data = await res.json() as any;
    return data.count || 0;
  } catch { return 0; }
}

const FUNC_CLASS_NAMES: Record<number, string> = {
  1: 'Interstate', 2: 'Principal Arterial - Freeways/Expressways',
  3: 'Principal Arterial - Other', 4: 'Minor Arterial',
  5: 'Major Collector', 6: 'Minor Collector', 7: 'Local',
};

async function fetchITDContext(lat: number, lng: number) {
  // Wrap entire ITD fetch in a 15-second timeout
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('ITD query timeout')), 25000)
  );

  try { return await Promise.race([_fetchITDContextInner(lat, lng), timeoutPromise]); }
  catch (e) {
    console.warn(`[ITD] Timeout or error fetching ITD data: ${e}`);
    return {
      speedLimitMph: null, speedZoneDirection: null, speedZoneDesc: null,
      aadtTotal: null, aadtCommercial: null, aadtTruckPct: null, dhv: null,
      laneWidth: null, totalLanes: 0, lanesAsc: null, lanesDes: null,
      terrain: null, funcClassCode: null, funcClassName: null, roadType: null,
      crashCount: 0, bridgeDetails: [], itdRouteName: '',
      contextString: '--- ITD DATA UNAVAILABLE (timeout or service error) ---',
    };
  }
}

async function _fetchITDContextInner(lat: number, lng: number) {
  // Query all layers in parallel
  const [speedZones, aadtRecords, roadChars, terrainTypes, funcClasses, crashCount, bridges] = await Promise.all([
    queryITDLayer('TransportationLayers', 2, lat, lng, 200, 2),   // Speed Zone
    queryITDLayer('AADTLayers', 40, lat, lng, 300, 1),            // AADT 2024
    queryITDLayer('IdahoTransportationLayersForOpenData', 78, lat, lng, 200, 1), // Roadway Characteristics
    queryITDLayer('IdahoTransportationLayersForOpenData', 89, lat, lng, 200, 1), // Terrain Type
    queryITDLayer('TransportationLayers', 11, lat, lng, 200, 1),  // Functional Class
    queryITDCount('IdahoTransportationLayersForOpenData', 123, lat, lng, 500), // Crash count
    queryITDLayer('IdahoTransportationLayersForOpenData', 152, lat, lng, 1000, 3), // Bridges
  ]);

  // Extract speed limit
  const speedZone = speedZones.find((s: any) => !s.ExpiredYN) || speedZones[0];
  const speedLimitMph = speedZone?.SpeedLimit || null;
  const speedZoneDirection = speedZone?.ZoneDirection || null;
  const speedZoneDesc = speedZone ? `MP ${speedZone.FromMeasure?.toFixed(1)} — ${speedZone.ToMeasure?.toFixed(1)} (${speedZone.DescriptionFrom || ''} → ${speedZone.DescriptionTo || ''})` : null;

  // Extract clean route name from ITD RouteID (e.g., "01990ASH055" → "SH-55")
  let itdRouteName = '';
  const routeId = speedZone?.RouteID || aadtRecords[0]?.RouteID || '';
  const routeMatch = routeId.match(/A(SH|US|I)(\d+)/);
  if (routeMatch) {
    const prefix = routeMatch[1] === 'I' ? 'I-' : routeMatch[1] === 'US' ? 'US-' : 'SH-';
    itdRouteName = prefix + parseInt(routeMatch[2]!, 10);
  }

  // Extract AADT
  const aadt = aadtRecords[0];
  const aadtTotal = aadt?.AADT || null;
  const aadtCommercial = aadt?.CommercialAADT || null;
  const aadtTruckPct = aadtTotal && aadtCommercial ? Math.round((aadtCommercial / aadtTotal) * 100) : null;
  const dhv = aadt?.DHV || null;

  // Extract roadway characteristics
  const rc = roadChars[0];
  const laneWidth = rc?.ID_LANE_WID || null;
  const lanesAsc = rc?.NUMBER_OF_ASC_LANES || null;
  const lanesDes = rc?.NUMBER_OF_DES_LANES || null;
  const totalLanes = (lanesAsc || 0) + (lanesDes || 0);

  // Extract terrain type
  const terrain = terrainTypes[0]?.ID_TERR_TYPE_NAME || null;

  // Extract functional class
  const fc = funcClasses[0];
  const funcClassCode = fc?.NewFCCODE || null;
  const funcClassName = funcClassCode ? (FUNC_CLASS_NAMES[funcClassCode] || `Code ${funcClassCode}`) : null;
  const roadType = fc?.Type || null;

  // Bridge details
  const bridgeDetails = bridges.map((b: any) => ({
    name: b.STRUC_NAME?.trim(),
    feature: b.FEATURES,
    deckWidth: b.DECK_WIDTH,
    lanes: b.LANES_ON,
    condition: b.CONDITION,
    loadRating: b.DESIGN_LOAD,
  }));

  // Build human-readable context string for the PE Agent
  const lines: string[] = ['--- ITD AUTHORITATIVE ROAD DATA ---'];
  if (itdRouteName) lines.push(`ROUTE: ${itdRouteName}`);
  if (speedLimitMph) lines.push(`SPEED LIMIT: ${speedLimitMph} MPH (${speedZoneDirection || 'both directions'}) ${speedZoneDesc || ''}`);
  if (funcClassName) lines.push(`FUNCTIONAL CLASS: ${funcClassName} (${roadType || 'unknown type'})`);
  if (terrain) lines.push(`TERRAIN: ${terrain}`);
  if (aadtTotal) {
    lines.push(`AADT (2024): ${aadtTotal.toLocaleString()} vpd | Commercial: ${(aadtCommercial || 0).toLocaleString()} (${aadtTruckPct}% trucks) | DHV: ${dhv || 'N/A'}`);
  }
  if (totalLanes > 0) lines.push(`LANES: ${totalLanes} total (${lanesDes || '?'} descending, ${lanesAsc || '?'} ascending) | Lane Width: ${laneWidth || '?'} ft`);
  if (crashCount > 0) lines.push(`CRASH HISTORY: ${crashCount} crashes within 500m (2005-present)`);
  if (bridgeDetails.length > 0) {
    lines.push(`BRIDGES WITHIN 1 KM: ${bridgeDetails.length}`);
    bridgeDetails.forEach((b: any) => {
      lines.push(`  - ${b.feature || b.name}: ${b.deckWidth}ft deck, ${b.lanes} lane(s), ${b.condition}`);
    });
  }

  console.log(`[ITD] Speed: ${speedLimitMph || 'N/A'} | AADT: ${aadtTotal || 'N/A'} | FC: ${funcClassName || 'N/A'} | Terrain: ${terrain || 'N/A'} | Crashes: ${crashCount} | Bridges: ${bridgeDetails.length}`);

  return {
    speedLimitMph,
    speedZoneDirection,
    speedZoneDesc,
    aadtTotal,
    aadtCommercial,
    aadtTruckPct,
    dhv,
    laneWidth,
    totalLanes,
    lanesAsc,
    lanesDes,
    terrain,
    funcClassCode,
    funcClassName,
    roadType,
    crashCount,
    bridgeDetails,
    itdRouteName,
    contextString: lines.join('\n'),
  };
}

// ---------------------------------------------------------------------------
// POST /api/speed-limit — Roads API proxy
// Frontend sends { lat, lng }, expects { speedLimits: [...] }
// ---------------------------------------------------------------------------
app.post('/api/speed-limit', async (req, res) => {
  try {
    const { lat, lng } = req.body;
    const apiKey = process.env.GOOGLE_MAPS_PLATFORM_KEY || process.env.GEMINI_API_KEY || '';

    // Step 1: Snap the point to the nearest road to get a placeId
    const snapUrl = `https://roads.googleapis.com/v1/nearestRoads?points=${lat},${lng}&key=${apiKey}`;
    const snapRes = await fetch(snapUrl);
    const snapData = await snapRes.json() as any;
    console.log(`[speed-limit] snapToRoads status: ${snapRes.status}`, JSON.stringify(snapData).substring(0, 200));

    const placeId = snapData.snappedPoints?.[0]?.placeId;
    if (!placeId) {
      // Fallback: try direct path query
      const directUrl = `https://roads.googleapis.com/v1/speedLimits?path=${lat},${lng}&key=${apiKey}`;
      const directRes = await fetch(directUrl);
      const directData = await directRes.json();
      console.log(`[speed-limit] direct path status: ${directRes.status}`, JSON.stringify(directData).substring(0, 200));
      res.json(directData);
      return;
    }

    // Step 2: Get speed limit using the placeId
    const speedUrl = `https://roads.googleapis.com/v1/speedLimits?placeId=${placeId}&key=${apiKey}`;
    const speedRes = await fetch(speedUrl);
    const speedData = await speedRes.json();
    console.log(`[speed-limit] placeId=${placeId} result:`, JSON.stringify(speedData).substring(0, 200));
    res.json(speedData);
  } catch (e) {
    console.error('[speed-limit] Error:', e);
    res.status(500).json({ error: 'Failed to fetch speed limit' });
  }
});

// ---------------------------------------------------------------------------
// UTILITY: Calculate bearing between two GPS points (degrees, 0=N, 90=E)
// ---------------------------------------------------------------------------
function calcBearing(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const aLat = a.lat * Math.PI / 180, bLat = b.lat * Math.PI / 180;
  const y = Math.sin(dLng) * Math.cos(bLat);
  const x = Math.cos(aLat) * Math.sin(bLat) - Math.sin(aLat) * Math.cos(bLat) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
}

// ---------------------------------------------------------------------------
// POST /api/site-context — Omniscient Sensory Payload (Phase 1)
// Fetches: Directions (road name, distance, cross-streets), Reverse Geocoding,
// Elevation (per-approach grade), Street View (heading-aware, both pins),
// Static Map (with route polyline + markers baked in).
// ---------------------------------------------------------------------------
app.post('/api/site-context', async (req, res) => {
  try {
    const { startCoords, endCoords, normalSpeed } = req.body;
    const apiKey = process.env.GOOGLE_MAPS_PLATFORM_KEY || process.env.GEMINI_API_KEY || '';

    // ------------------------------------------------------------------
    // 1. DIRECTIONS API — road name, distance, cross-streets, polyline
    // ------------------------------------------------------------------
    const dirUrl = `https://maps.googleapis.com/maps/api/directions/json?origin=${startCoords.lat},${startCoords.lng}&destination=${endCoords.lat},${endCoords.lng}&key=${apiKey}`;
    const dirRes = await fetchWithRetry(dirUrl).catch(() => null);

    let routePolyline = '';
    let routeDistanceMeters = 0;
    let routeDurationSec = 0;
    let roadName = '';
    let crossStreets: string[] = [];
    let startAddress = '';
    let endAddress = '';

    if (dirRes && dirRes.ok) {
      const dirData = await dirRes.json() as any;
      const route = dirData.routes?.[0];
      if (route) {
        routePolyline = route.overview_polyline?.points || '';
        const leg = route.legs?.[0];
        if (leg) {
          routeDistanceMeters = leg.distance?.value || 0;
          routeDurationSec = leg.duration?.value || 0;
          startAddress = leg.start_address || '';
          endAddress = leg.end_address || '';

          // Extract road names and cross-streets from step instructions
          const steps = leg.steps || [];
          const roadNames = new Set<string>();
          for (const step of steps) {
            const instr: string = step.html_instructions || '';
            // Strip HTML tags
            const clean = instr.replace(/<[^>]*>/g, '');
            // Extract road names: match highway patterns like "ID-55 N", "US-95", "SH-21", "I-84 W"
            const hwyMatch = clean.match(/\b((?:ID|US|SH|I|SR|State Hwy|State Route|Highway|Hwy)[\s-]*\d+[\s]*[NSEW]?\b)/i);
            if (hwyMatch) roadNames.add(hwyMatch[1]!.trim());
            // Fallback: extract road name after "onto" but stop at navigation phrases
            if (roadNames.size === 0) {
              const ontoMatch = clean.match(/(?:onto|on)\s+([A-Z0-9][A-Za-z0-9\s\-\.]+?)(?:\s*(?:toward|Destination|Continue|Turn|$))/i);
              if (ontoMatch) roadNames.add(ontoMatch[1]!.trim());
            }
            // Detect cross-streets from "Turn" instructions
            if (/turn|merge|fork/i.test(clean)) {
              crossStreets.push(clean.substring(0, 80));
            }
          }
          // Use the most common road name, or the first one found
          if (roadNames.size > 0) roadName = [...roadNames][0]!;
        }
      }
    }

    const routeDistanceFt = Math.round(routeDistanceMeters * 3.28084);

    // ------------------------------------------------------------------
    // 1b. REVERSE GEOCODING — road name fallback when Directions doesn't provide one
    // ------------------------------------------------------------------
    if (!roadName) {
      const geoUrl = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${startCoords.lat},${startCoords.lng}&result_type=route&key=${apiKey}`;
      const geoRes = await fetchWithRetry(geoUrl).catch(() => null);
      if (geoRes && geoRes.ok) {
        const geoData = await geoRes.json() as any;
        const result = geoData.results?.[0];
        if (result) {
          const routeComp = result.address_components?.find((c: any) => c.types?.includes('route'));
          if (routeComp) roadName = routeComp.long_name || routeComp.short_name || '';
          if (!startAddress) startAddress = result.formatted_address || '';
        }
      }
    }

    console.log(`[site-context] Road: ${roadName || 'unknown'} | Distance: ${routeDistanceFt} ft | Cross-streets: ${crossStreets.length}`);

    // ------------------------------------------------------------------
    // 2. ELEVATION API — per-approach directional grade analysis
    // ------------------------------------------------------------------
    let elevationContext = 'Elevation data unavailable.';
    let maxGradePercent = 0;
    let approachGradeContext = '';

    if (routePolyline) {
      const samples = Math.min(Math.max(Math.ceil(routeDistanceMeters / 200), 5), 50);
      const elevUrl = `https://maps.googleapis.com/maps/api/elevation/json?path=enc:${encodeURIComponent(routePolyline)}&samples=${samples}&key=${apiKey}`;
      const elevRes = await fetchWithRetry(elevUrl).catch(() => null);

      if (elevRes && elevRes.ok) {
        const elevData = await elevRes.json() as { results?: { elevation: number }[] };
        const pts = elevData.results;
        if (pts && pts.length >= 2) {
          const elevations = pts.map(p => p.elevation);
          const minElev = Math.min(...elevations);
          const maxElev = Math.max(...elevations);
          const segLen = routeDistanceMeters / (elevations.length - 1);

          // Per-segment grade analysis
          let maxUpgrade = 0, maxDowngrade = 0;
          for (let i = 1; i < elevations.length; i++) {
            const grade = ((elevations[i]! - elevations[i - 1]!) / segLen) * 100;
            if (grade > maxUpgrade) { maxUpgrade = grade; }
            if (grade < maxDowngrade) { maxDowngrade = grade; }
          }
          maxGradePercent = Math.round(Math.max(Math.abs(maxUpgrade), Math.abs(maxDowngrade)) * 10) / 10;

          // Directional analysis: which approach faces a downgrade?
          const startElev = elevations[0]!;
          const endElev = elevations[elevations.length - 1]!;
          const netGrade = ((endElev - startElev) / routeDistanceMeters) * 100;
          const netGradeRound = Math.round(Math.abs(netGrade) * 10) / 10;

          if (Math.abs(netGrade) >= 3) {
            if (netGrade < 0) {
              approachGradeContext = `PRIMARY APPROACH faces a ${netGradeRound}% DOWNGRADE (${startElev.toFixed(0)}m → ${endElev.toFixed(0)}m). Apply 1.5x advance warning sign spacing multiplier for the Primary approach.`;
            } else {
              approachGradeContext = `OPPOSING APPROACH faces a ${netGradeRound}% DOWNGRADE (${endElev.toFixed(0)}m → ${startElev.toFixed(0)}m). Apply 1.5x advance warning sign spacing multiplier for the Opposing approach.`;
            }
          }

          elevationContext =
            `Route Elev: ${minElev.toFixed(0)}m — ${maxElev.toFixed(0)}m (${((maxElev - minElev) * 3.28084).toFixed(0)} ft relief). ` +
            `Max Ruling Grade: ${maxGradePercent}%. ` +
            `Net Grade: ${netGrade > 0 ? '+' : ''}${netGradeRound}% (${netGrade > 0 ? 'uphill' : 'downhill'} start→end). ` +
            `True Driving Distance: ${routeDistanceFt.toLocaleString()} ft (${(routeDistanceMeters / 1609.34).toFixed(1)} mi). ` +
            (approachGradeContext || 'Grade within normal limits — no spacing multiplier required.');
        }
      }
    }

    // Fallback: 2-point elevation if Directions API failed
    if (elevationContext === 'Elevation data unavailable.') {
      const fallbackUrl = `https://maps.googleapis.com/maps/api/elevation/json?locations=${startCoords.lat},${startCoords.lng}|${endCoords.lat},${endCoords.lng}&key=${apiKey}`;
      const fallbackRes = await fetchWithRetry(fallbackUrl).catch(() => null);
      if (fallbackRes && fallbackRes.ok) {
        const fbData = await fallbackRes.json() as { results?: { elevation: number }[] };
        if (fbData.results?.length === 2) {
          elevationContext = `Start Elev: ${fbData.results[0]!.elevation.toFixed(0)}m. End Elev: ${fbData.results[1]!.elevation.toFixed(0)}m. (Straight-line fallback)`;
        }
      }
    }

    // ------------------------------------------------------------------
    // 2b. CROSS-STREET DETECTION — 3-layer approach
    //   Layer 1: Reverse geocode sample points along polyline
    //   Layer 2: ITD All Idaho Road cross-reference at sample points
    //   Layer 3: Gemini Vision analysis of satellite image
    // ------------------------------------------------------------------
    const detectedRoads = new Set<string>();

    // Normalize the main road name for comparison
    const mainRoadNorm = (roadName || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const isMainRoad = (name: string) => {
      if (!mainRoadNorm) return false;
      const norm = name.toLowerCase().replace(/[^a-z0-9]/g, '');
      // Exact match only — don't filter "US-95 BUS" just because it contains "US-95"
      if (norm === mainRoadNorm) return true;
      // Match road numbers: "US-95" matches "US 95 N" but not "US-95 BUS"
      const mainNum = mainRoadNorm.match(/\d+/)?.[0];
      const csNum = norm.match(/\d+/)?.[0];
      if (mainNum && csNum && mainNum === csNum) {
        // Same number, but check for BUS/ALT/SPUR suffixes — those are different roads
        const hasSuffix = /bus|alt|spur|byp|loop/i.test(name);
        if (hasSuffix) return false; // Different road
        return true; // Same road, just directional variant
      }
      return false;
    };

    // Track positioned cross-streets: { name, position (0-1 fraction along route) }
    const positionedCrossStreets: { name: string; position: number }[] = [];

    if (routePolyline) {
      const polyPoints = decodePolyline(routePolyline);

      // -- LAYER 1: Reverse geocode at high density along polyline --
      // For short urban routes, ensure we sample enough unique points
      const targetSamples = Math.min(15, Math.max(5, polyPoints.length - 1));
      const sampleIndices: number[] = [];
      for (let i = 0; i < targetSamples; i++) {
        const idx = Math.min(Math.round((i + 0.5) * (polyPoints.length - 1) / targetSamples), polyPoints.length - 1);
        if (!sampleIndices.includes(idx)) sampleIndices.push(idx);
      }
      const samplePoints = sampleIndices.map(idx => polyPoints[idx]!);

      // Use broader result_type to catch intersections in urban corridors
      const geoPromises = samplePoints.map(pt => {
        const geoUrl = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${pt.lat},${pt.lng}&key=${apiKey}`;
        return fetchWithRetry(geoUrl).then(r => r.json()).catch(() => null);
      });

      const geoResults = await Promise.all(geoPromises);

      // Process each sample point's geocode results
      for (let si = 0; si < (geoResults as any[]).length; si++) {
        const geoData = (geoResults as any[])[si];
        const position = sampleIndices[si]! / (polyPoints.length - 1); // 0-1 fraction
        if (!geoData?.results) continue;
        for (const result of geoData.results) {
          let name = '';
          if (result.types?.includes('intersection')) {
            name = result.formatted_address?.split(',')[0] || '';
          } else {
            const routeComp = result.address_components?.find((c: any) => c.types?.includes('route'));
            name = routeComp?.short_name || routeComp?.long_name || '';
          }
          // Filter out garbage: navigation instructions, long strings, parenthetical text
          if (name && name.length > 50) name = '';
          if (name && /turn|pass by|onto|destination|continue|head /i.test(name)) name = '';
          if (name && !isMainRoad(name) && !detectedRoads.has(name)) {
            detectedRoads.add(name);
            crossStreets.push(name);
            positionedCrossStreets.push({ name, position: Math.round(position * 100) / 100 });
          }
        }
      }

      console.log(`[site-context] Cross-street Layer 1 (geocode): ${crossStreets.length} streets from ${targetSamples} samples`);
    }

    console.log(`[site-context] Cross-street detection (pre-vision): ${crossStreets.length} — ${crossStreets.join(', ') || 'none'}`);

    // ------------------------------------------------------------------
    // 3. STREET VIEW — heading-aware captures at BOTH pins
    // ------------------------------------------------------------------
    const bearing = calcBearing(startCoords, endCoords);
    const reverseBearing = (bearing + 180) % 360;

    // Start pin: face toward the work zone (bearing toward end)
    const svStartUrl = `https://maps.googleapis.com/maps/api/streetview?size=600x400&location=${startCoords.lat},${startCoords.lng}&heading=${Math.round(bearing)}&pitch=-5&key=${apiKey}`;
    // End pin: face back toward the work zone (bearing toward start)
    const svEndUrl = `https://maps.googleapis.com/maps/api/streetview?size=600x400&location=${endCoords.lat},${endCoords.lng}&heading=${Math.round(reverseBearing)}&pitch=-5&key=${apiKey}`;

    // ------------------------------------------------------------------
    // 4. STATIC MAP — bake route polyline + pin markers into satellite image
    // ------------------------------------------------------------------
    const mapImgW = 600, mapImgH = 400;
    const latSpan = Math.abs(startCoords.lat - endCoords.lat);
    const lngSpan = Math.abs(startCoords.lng - endCoords.lng);
    const paddedLatSpan = Math.max(latSpan, 0.0005) * 1.8;
    const paddedLngSpan = Math.max(lngSpan, 0.0005) * 1.8;
    const zoomLng = Math.log2((mapImgW * 360) / (256 * paddedLngSpan));
    const zoomLat = Math.log2((mapImgH * 180) / (256 * paddedLatSpan));
    const fitZoom = Math.max(12, Math.min(20, Math.floor(Math.min(zoomLng, zoomLat))));

    const mapCenterLat = (startCoords.lat + endCoords.lat) / 2;
    const mapCenterLng = (startCoords.lng + endCoords.lng) / 2;

    // Build Static Map URL with route path overlay and pin markers
    // Use hybrid (satellite + road labels) so intersections and road names are visible
    let smUrl = `https://maps.googleapis.com/maps/api/staticmap?center=${mapCenterLat},${mapCenterLng}&zoom=${fitZoom}&size=${mapImgW}x${mapImgH}&maptype=hybrid`;
    if (routePolyline) {
      smUrl += `&path=color:0xFF0000AA|weight:4|enc:${encodeURIComponent(routePolyline)}`;
    }
    smUrl += `&markers=color:green|label:S|${startCoords.lat},${startCoords.lng}`;
    smUrl += `&markers=color:red|label:E|${endCoords.lat},${endCoords.lng}`;
    smUrl += `&key=${apiKey}`;

    const [svStartRes, svEndRes, smRes] = await Promise.all([
      fetchWithRetry(svStartUrl).catch(() => null),
      fetchWithRetry(svEndUrl).catch(() => null),
      fetchWithRetry(smUrl).catch(() => null),
    ]);

    console.log(`[site-context] SV-Start: ${svStartRes?.status ?? 'FAILED'} | SV-End: ${svEndRes?.status ?? 'FAILED'} | StaticMap: ${smRes?.status ?? 'FAILED'}`);

    const toBase64 = async (r: Response | null): Promise<string | null> => {
      if (!r || !r.ok) return null;
      const arrayBuffer = await r.arrayBuffer();
      return Buffer.from(arrayBuffer).toString('base64');
    };

    const staticMapB64 = await toBase64(smRes);

    // ------------------------------------------------------------------
    // 4b. LAYER 3: Gemini Vision intersection detection from satellite image
    // ------------------------------------------------------------------
    if (staticMapB64 && crossStreets.length < 5 && process.env.GEMINI_API_KEY) {
      try {
        const { GoogleGenAI } = await import('@google/genai');
        const visionAi = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

        // 12-second timeout for vision analysis
        const visionTimeout = new Promise<any>((_, rej) => setTimeout(() => rej(new Error('Vision timeout')), 12000));
        const visionRes = await Promise.race([visionAi.models.generateContent({
          model: 'gemini-3-flash-preview',
          contents: {
            parts: [
              { inlineData: { data: staticMapB64, mimeType: 'image/jpeg' } },
              { text: `Analyze this satellite/hybrid map image of a highway work zone. The route runs between the green "S" marker and the red "E" marker along the highlighted red path.

List ALL visible road intersections, cross-streets, named roads, and significant access points that connect to or cross the highlighted route between the S and E markers. Include labeled road names visible on the map.

Output ONLY a JSON array of objects: [{"name": "road name or description", "position": "near start | 1/4 | midpoint | 3/4 | near end", "type": "intersection | driveway | access_road"}]
If no intersections are visible, output: []` },
            ],
          },
        }), visionTimeout]);

        const visionText = visionRes?.text || '[]';
        const jsonMatch = visionText.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          const visionIntersections = JSON.parse(jsonMatch[0]) as { name: string; position: string; type: string }[];
          for (const ix of visionIntersections) {
            const label = ix.name;
            if (label && !isMainRoad(label) && !detectedRoads.has(label)) {
              detectedRoads.add(label);
              // Map position text to fraction
              const posMap: Record<string, number> = { 'near start': 0.1, '1/4': 0.25, 'midpoint': 0.5, '3/4': 0.75, 'near end': 0.9 };
              const posFrac = posMap[ix.position] || 0.5;
              crossStreets.push(`${label} (${ix.position})`);
              positionedCrossStreets.push({ name: label, position: posFrac });
            }
          }
          console.log(`[site-context] Cross-street Layer 3 (vision): +${visionIntersections.length} intersections from satellite analysis`);
        }
      } catch (visionErr) {
        console.warn('[site-context] Vision intersection detection failed:', visionErr);
      }
    }

    console.log(`[site-context] Total cross-streets detected: ${crossStreets.length} — ${crossStreets.join(', ') || 'none'}`);

    // ------------------------------------------------------------------
    // 4c. INTERSECTION GEOMETRY ANALYSIS — Vision-based
    // Analyze each detected cross-street's geometry using the satellite image
    // ------------------------------------------------------------------
    if (staticMapB64 && positionedCrossStreets.length > 0 && process.env.GEMINI_API_KEY) {
      try {
        const { GoogleGenAI } = await import('@google/genai');
        const geoAi = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

        const csNames = positionedCrossStreets.slice(0, 6).map(cs => cs.name).join(', ');
        const geoTimeout = new Promise<any>((_, rej) => setTimeout(() => rej(new Error('Geo vision timeout')), 25000));
        const geoRes = await Promise.race([geoAi.models.generateContent({
          model: 'gemini-3-flash-preview',
          contents: {
            parts: [
              { inlineData: { data: staticMapB64, mimeType: 'image/jpeg' } },
              { text: `Analyze the intersections of these cross-streets with the main highlighted route: ${csNames}

For each cross-street, determine:
1. type: "T-north" (T from north only), "T-south", "T-east", "T-west", "4-way" (full cross), "Y" (angled), "offset" (staggered), "roundabout"
2. hasSignal: true/false (traffic signal visible?)
3. hasStopSign: true/false (stop sign visible on cross-street?)
4. turnLanes: true/false (dedicated turn lanes visible?)
5. legs: number of intersection legs (3 for T, 4 for cross)
6. approachAngle: degrees from perpendicular (0=perfect cross, 30=angled)

Output ONLY a JSON array matching the cross-street order: [{"name":"...","type":"...","hasSignal":false,"hasStopSign":true,"turnLanes":false,"legs":3,"approachAngle":0}]` },
            ],
          },
        }), geoTimeout]);

        const geoText = geoRes?.text || '[]';
        const geoMatch = geoText.match(/\[[\s\S]*\]/);
        if (geoMatch) {
          const geoData = JSON.parse(geoMatch[0]) as any[];
          for (let i = 0; i < Math.min(geoData.length, positionedCrossStreets.length); i++) {
            const g = geoData[i];
            if (g) {
              (positionedCrossStreets[i] as any).geometry = {
                type: g.type || '4-way',
                hasSignal: !!g.hasSignal,
                hasStopSign: !!g.hasStopSign,
                turnLanes: !!g.turnLanes,
                approachAngle: g.approachAngle || 0,
                legs: g.legs || 4,
              };
            }
          }
          console.log(`[site-context] Intersection geometry: analyzed ${geoData.length} intersections`);
        }
      } catch (geoErr) {
        console.warn('[site-context] Intersection geometry analysis failed:', geoErr);
      }
    }

    // ------------------------------------------------------------------
    // 5. ITD AUTHORITATIVE DATA (Speed, AADT, Lanes, Terrain, Crashes, Bridges)
    // ------------------------------------------------------------------
    const itd = await fetchITDContext(startCoords.lat, startCoords.lng);

    // Prefer ITD route name (cleanest), then Directions API road name, then functional class
    if (itd.itdRouteName) {
      roadName = itd.itdRouteName;
    } else if (!roadName && itd.funcClassName) {
      roadName = `${itd.roadType || 'Road'} (${itd.funcClassName})`;
    }

    // ------------------------------------------------------------------
    // 6. BUILD ENRICHED CONTEXT STRING
    // ------------------------------------------------------------------
    const roadContext = [
      roadName ? `Road: ${roadName}` : null,
      startAddress ? `Start Address: ${startAddress}` : null,
      endAddress ? `End Address: ${endAddress}` : null,
      routeDurationSec > 0 ? `Drive Time: ${Math.ceil(routeDurationSec / 60)} min` : null,
      crossStreets.length > 0 ? `Cross-Streets/Turns: ${crossStreets.join('; ')}` : 'No cross-streets detected along route.',
    ].filter(Boolean).join('. ');

    res.json({
      elevationContext,
      speedLimitContext: itd.speedLimitMph
        ? `ITD Authoritative Speed Limit: ${itd.speedLimitMph} MPH (${itd.speedZoneDirection || 'both'}). ${itd.speedZoneDesc || ''}`
        : `User input speed: ${normalSpeed} MPH.`,
      streetViewBase64: await toBase64(svStartRes),
      streetViewEndBase64: await toBase64(svEndRes),
      staticMapBase64: staticMapB64,
      routeDistanceFt,
      maxGradePercent,
      roadName,
      roadContext,
      crossStreets,
      approachGradeContext,
      // ITD authoritative data
      itdSpeedLimit: itd.speedLimitMph || null,
      itdAADT: itd.aadtTotal || null,
      itdCommercialAADT: itd.aadtCommercial || null,
      itdTruckPct: itd.aadtTruckPct || null,
      itdLaneWidth: itd.laneWidth || null,
      itdTotalLanes: itd.totalLanes || 0,
      itdTerrain: itd.terrain || '',
      itdFuncClass: String(itd.funcClassCode || ''),
      itdCrashCount: itd.crashCount || 0,
      itdBridges: itd.bridgeDetails || [],
      itdContext: itd.contextString || '',
      positionedCrossStreets: positionedCrossStreets || [],
    });
  } catch (e) {
    console.error('[site-context] Error:', e);
    res.status(500).json({ error: 'Context fetch failed' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/rag — Ground Truth MUTCD Injection (Phase 2)
// Frontend sends { operationType, speedLimit, siteContext }
// Backend embeds the query, runs cosine similarity over the MUTCD vector DB.
// Returns { text, image_base64 }
// ---------------------------------------------------------------------------
const vectorDbPath = path.join(__dirname, '..', 'data', 'mutcd_2026_vector_db.json');
let mutcdData: { page_number: number; layout_name: string; engineering_rules: string; dense_summary: string; diagram_base64?: string; embedding: number[] }[] = [];

try {
  const raw = fs.readFileSync(vectorDbPath, 'utf8');
  mutcdData = JSON.parse(raw);
  console.log(`[RAG] Loaded ${mutcdData.length} pages from MUTCD vector database.`);
} catch {
  // Fallback: try the public/ folder (legacy location)
  const legacyPath = path.join(__dirname, '..', 'public', 'mutcd_2026_vector_db.json');
  try {
    const raw = fs.readFileSync(legacyPath, 'utf8');
    mutcdData = JSON.parse(raw);
    console.log(`[RAG] Loaded ${mutcdData.length} pages from legacy public/ location.`);
  } catch {
    console.error('[RAG] CRITICAL: mutcd_2026_vector_db.json not found in /data or /public.');
  }
}

function cosineSimilarity(vecA: number[], vecB: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dot += vecA[i]! * vecB[i]!;
    normA += vecA[i]! * vecA[i]!;
    normB += vecB[i]! * vecB[i]!;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

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

app.post('/api/rag', async (req, res) => {
  try {
    const { operationType, speedLimit, siteContext, laneWidth, duration } = req.body;

    if (!operationType || !speedLimit) {
      res.status(400).json({ error: 'operationType and speedLimit are required.' });
      return;
    }

    const apiKey = process.env.GEMINI_API_KEY || '';
    if (!apiKey) {
      res.status(500).json({ error: 'Server GEMINI_API_KEY not configured.' });
      return;
    }

    const { GoogleGenAI } = await import('@google/genai');
    const ai = new GoogleGenAI({ apiKey });

    // Enriched query: include lane width and duration so the RAG matches the correct TA
    const lw = laneWidth || 12;
    const dur = duration || 'Short-term';
    const searchQuery = `Temporary Traffic Control layout rules and MUTCD Typical Application (TA) for ${operationType} on a ${lw}-ft lane highway with a speed limit of ${speedLimit} mph. Work duration: ${dur}. Critical Site Context: ${siteContext || 'None'}`;

    const embedResponse = await ai.models.embedContent({
      model: 'gemini-embedding-2-preview',
      contents: searchQuery,
    });

    const queryVector = embedResponse.embeddings![0]!.values!;

    let bestMatch: (typeof mutcdData)[number] | null = null;
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
      res.json({
        text: `[RAG MATCH: Page ${bestMatch.page_number} | Layout: ${bestMatch.layout_name}]\nRULES: ${bestMatch.engineering_rules}\nSUMMARY: ${bestMatch.dense_summary}\n${CORE_TABLES}`,
        image_base64: bestMatch.diagram_base64 || null,
      });
      return;
    }

    res.json({
      text: 'No MUTCD rules found in database. Rely on standard MUTCD math.' + CORE_TABLES,
      image_base64: null,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[RAG] Error:', msg);
    res.status(500).json({
      text: 'RAG Engine failed. Rely on standard MUTCD math.' + CORE_TABLES,
      image_base64: null,
    });
  }
});

// ---------------------------------------------------------------------------
// POST /api/generate-plan — Deterministic CAD Generation (Phase 4-5)
// The deterministic cadGenerator.ts has all the engineering fixes:
//   dynamic titles, correct speed math, PE taper respect, break lines, geo-DXF.
// The agentic Drafter-Reviewer loop is available but disabled — when it "succeeded"
// it bypassed every cadGenerator fix, producing worse output than the deterministic path.
// Re-enable via ENABLE_AGENTIC=true in .env when the Drafter prompt is mature.
// ---------------------------------------------------------------------------
app.post('/api/generate-plan', async (req, res) => {
  try {
    const { blueprint, startCoords, endCoords, staticMapBase64, normalSpeed, workZoneSpeed, laneWidth, operationType, routeDistanceFt: rawRouteDist, roadName: rawRoadName, positionedCrossStreets: rawCrossStreets, itdTerrain: rawTerrain, itdFuncClass: rawFuncClass, itdTotalLanes: rawTotalLanes } = req.body;
    const speedMph: number = normalSpeed || 65;
    const wzSpeedMph: number = workZoneSpeed || 55;
    const laneWidthFt: number = laneWidth || 12;
    const opType: string = operationType || 'Single Lane Closure';
    const roadNameStr: string = rawRoadName || '';
    let routeDistanceFt: number = rawRouteDist || 0;

    // Haversine fallback when Directions API didn't provide route distance
    if (routeDistanceFt === 0 && startCoords && endCoords) {
      const R = 20902231; // Earth radius in feet
      const dLat = (endCoords.lat - startCoords.lat) * Math.PI / 180;
      const dLng = (endCoords.lng - startCoords.lng) * Math.PI / 180;
      const aLat = startCoords.lat * Math.PI / 180;
      const bLat = endCoords.lat * Math.PI / 180;
      const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat) * Math.cos(bLat) * Math.sin(dLng / 2) ** 2;
      routeDistanceFt = Math.round(R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h)));
    }

    if (!blueprint) {
      res.status(400).json({ error: 'No blueprint provided.' });
      return;
    }

    const sessionId = crypto.randomUUID();
    const sessionDir = path.join(tmpDir, sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });

    const pdfPath = path.join(sessionDir, 'output_plan.pdf');
    const dxfPath = path.join(sessionDir, 'output_plan.dxf');

    // ------------------------------------------------------------------
    // Deterministic generation — cadGenerator.ts has ALL the engineering fixes
    // ------------------------------------------------------------------
    console.log(`[generate-plan] Session ${sessionId} | speed=${speedMph} | op=${opType} | route=${routeDistanceFt}ft`);
    console.log(`[generate-plan] staticMapBase64 length: ${(staticMapBase64 || '').length}`);

    await generateCAD(
      blueprint,
      staticMapBase64 || null,
      startCoords || null,
      endCoords || null,
      pdfPath, dxfPath,
      speedMph, wzSpeedMph, laneWidthFt, opType, routeDistanceFt, roadNameStr,
      rawCrossStreets || [],
      rawTerrain || '',
      rawFuncClass || '',
      parseInt(rawTotalLanes) || 0,
    );

    // Verify the generated files
    const pdfSize = fs.existsSync(pdfPath) ? fs.statSync(pdfPath).size : 0;
    const dxfSize = fs.existsSync(dxfPath) ? fs.statSync(dxfPath).size : 0;
    console.log(`[generate-plan] PDF: ${pdfSize} bytes | DXF: ${dxfSize} bytes`);

    // ------------------------------------------------------------------
    // Build the generation log
    // ------------------------------------------------------------------
    const auditLog = [
      `Engineering Generation Log`,
      `Session: ${sessionId}`,
      `Generated: ${new Date().toISOString()}`,
      ``,
      `Parameters:`,
      `  Road: ${roadNameStr || 'Not identified'}`,
      `  Operation: ${opType}`,
      `  Normal Speed: ${speedMph} MPH | Work Zone Speed: ${wzSpeedMph} MPH`,
      `  Lane Width: ${laneWidthFt} ft`,
      `  Route Distance: ${routeDistanceFt > 0 ? `${routeDistanceFt.toLocaleString()} ft (${(routeDistanceFt / 5280).toFixed(1)} mi)${rawRouteDist ? '' : ' [Haversine estimate]'}` : 'Not available'}`,
      `  Satellite Image: ${(staticMapBase64 || '').length > 100 ? 'YES' : 'NOT PROVIDED'}`,
      ``,
      `PE Blueprint Taper: ${blueprint.taper?.length_ft} ft (${blueprint.taper?.device_type})`,
      `Downstream Taper: ${blueprint.downstream_taper?.length_ft} ft`,
      `Primary Approach Signs: ${blueprint.primary_approach?.length}`,
      `Opposing Approach Signs: ${blueprint.opposing_approach?.length}`,
      ``,
      `Output:`,
      `  PDF: ${pdfSize} bytes`,
      `  DXF: ${dxfSize} bytes`,
      ``,
      `PE Agent Engineering Notes:`,
      blueprint.engineering_notes || '(none)',
    ].join('\n');

    // ------------------------------------------------------------------
    // PHASE 5: Archive — build ZIP from in-memory buffers
    // No file-system races: text artifacts are appended as strings directly.
    // ------------------------------------------------------------------
    const blueprintJson = JSON.stringify(blueprint, null, 2);

    const archive = archiver('zip', { zlib: { level: 9 } });

    archive.on('error', (err) => {
      console.error('[generate-plan] Archive error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to create zip archive: ' + err.message });
      }
    });

    res.on('close', () => {
      fs.rmSync(sessionDir, { recursive: true, force: true });
      console.log(`[generate-plan] Session ${sessionId} — cleaned up.`);
    });

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="ITD_Plan_Set.zip"');
    archive.pipe(res);

    // Binary files: read from disk into memory first
    if (fs.existsSync(pdfPath)) archive.append(fs.readFileSync(pdfPath), { name: 'output_plan.pdf' });
    if (fs.existsSync(dxfPath)) archive.append(fs.readFileSync(dxfPath), { name: 'output_plan.dxf' });

    // Text files: append directly from strings — no disk I/O, zero race conditions
    archive.append(Buffer.from(blueprintJson, 'utf8'), { name: 'pe_blueprint.json' });
    archive.append(Buffer.from(auditLog, 'utf8'), { name: 'engineering_audit_log.txt' });

    await archive.finalize();
    console.log(`[generate-plan] Session ${sessionId} — ZIP finalized with 4 artifacts.`);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[generate-plan] Error:', msg);
    if (!res.headersSent) {
      res.status(500).json({ error: msg });
    }
  }
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[ITD Backend] Running on http://localhost:${PORT}`);
});
