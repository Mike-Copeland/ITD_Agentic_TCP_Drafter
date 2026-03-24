/**
 * Intersection Geometry Classifier
 * Detects roundabouts, interchanges, and other non-standard intersections
 * using OpenStreetMap Overpass API.
 */

export type IntersectionType =
  | 'standard_4way'
  | 'standard_3way'
  | 'signalized'
  | 'roundabout_single'
  | 'roundabout_multi'
  | 'interchange_dogbone'
  | 'interchange_diamond'
  | 'interchange_other'
  | 'unknown';

export interface IntersectionClassification {
  type: IntersectionType;
  legs: number;
  circulatoryLanes?: number;
  hasSignal: boolean;
  hasSplitterIslands?: boolean;
  inscribedDiameterFt?: number;
  nearbyRoundaboutCount: number;
  osmData?: any;
}

export interface RouteIntersectionResult {
  routeHasRoundabouts: boolean;
  roundaboutCount: number;
  intersections: {
    name: string;
    position: number;
    classification: IntersectionClassification;
    lat: number;
    lng: number;
  }[];
}

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

// Simple cache to avoid Overpass rate limiting between site-context calls
const osmCache = new Map<string, { roundabouts: any[]; interchanges: any[]; timestamp: number }>();
const CACHE_TTL_MS = 120000; // 2 minutes

/**
 * Query OpenStreetMap for roundabouts near a route segment.
 * Uses Overpass API to find junction=roundabout ways within buffer.
 */
async function queryOverpassRoundabouts(
  startLat: number, startLng: number,
  endLat: number, endLng: number,
  bufferMeters = 500
): Promise<any[]> {
  // Build bounding box with buffer
  const latMin = Math.min(startLat, endLat) - bufferMeters / 111000;
  const latMax = Math.max(startLat, endLat) + bufferMeters / 111000;
  const lngMin = Math.min(startLng, endLng) - bufferMeters / (111000 * Math.cos(startLat * Math.PI / 180));
  const lngMax = Math.max(startLng, endLng) + bufferMeters / (111000 * Math.cos(startLat * Math.PI / 180));

  const query = `
    [out:json][timeout:10];
    (
      way["junction"="roundabout"](${latMin},${lngMin},${latMax},${lngMax});
      way["highway"="mini_roundabout"](${latMin},${lngMin},${latMax},${lngMax});
      node["highway"="mini_roundabout"](${latMin},${lngMin},${latMax},${lngMax});
    );
    out center body;
  `;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(OVERPASS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `data=${encodeURIComponent(query)}`,
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) return [];
    const data = await res.json() as any;
    return data.elements || [];
  } catch (err) {
    console.warn('[intersectionClassifier] Overpass query failed:', err);
    return [];
  }
}

/**
 * Query OSM for interchange features (highway ramps, bridges) near route.
 */
async function queryOverpassInterchanges(
  startLat: number, startLng: number,
  endLat: number, endLng: number,
  bufferMeters = 500
): Promise<any[]> {
  const latMin = Math.min(startLat, endLat) - bufferMeters / 111000;
  const latMax = Math.max(startLat, endLat) + bufferMeters / 111000;
  const lngMin = Math.min(startLng, endLng) - bufferMeters / (111000 * Math.cos(startLat * Math.PI / 180));
  const lngMax = Math.max(startLng, endLng) + bufferMeters / (111000 * Math.cos(startLat * Math.PI / 180));

  const query = `
    [out:json][timeout:10];
    (
      way["highway"="motorway_link"](${latMin},${lngMin},${latMax},${lngMax});
      way["highway"="trunk_link"](${latMin},${lngMin},${latMax},${lngMax});
      way["bridge"="yes"]["highway"](${latMin},${lngMin},${latMax},${lngMax});
    );
    out center body;
  `;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(OVERPASS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `data=${encodeURIComponent(query)}`,
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) return [];
    const data = await res.json() as any;
    return data.elements || [];
  } catch {
    return [];
  }
}

/**
 * Classify a specific intersection point based on nearby OSM features.
 */
function classifyPoint(
  lat: number, lng: number,
  roundabouts: any[], interchangeFeatures: any[],
  proximityFt = 300
): IntersectionClassification {
  const proximityDeg = proximityFt / 364000; // rough ft to degrees

  // Check for nearby roundabouts
  const nearbyRoundabouts = roundabouts.filter(r => {
    const rLat = r.center?.lat || r.lat || 0;
    const rLng = r.center?.lon || r.lon || 0;
    return Math.abs(rLat - lat) < proximityDeg && Math.abs(rLng - lng) < proximityDeg;
  });

  // Check for nearby interchange features (ramps, bridges)
  const nearbyRamps = interchangeFeatures.filter(f => {
    const fLat = f.center?.lat || f.lat || 0;
    const fLng = f.center?.lon || f.lon || 0;
    return Math.abs(fLat - lat) < proximityDeg && Math.abs(fLng - lng) < proximityDeg;
  });

  if (nearbyRoundabouts.length > 0) {
    // Determine if multi-lane roundabout by checking lanes tag
    const lanes = nearbyRoundabouts[0]?.tags?.lanes;
    const laneCount = lanes ? parseInt(lanes) : 1;
    const isMulti = laneCount >= 2;

    return {
      type: isMulti ? 'roundabout_multi' : 'roundabout_single',
      legs: 4, // Default, could be refined
      circulatoryLanes: laneCount,
      hasSignal: false,
      hasSplitterIslands: true,
      nearbyRoundaboutCount: nearbyRoundabouts.length,
      osmData: nearbyRoundabouts[0]?.tags,
    };
  }

  if (nearbyRamps.length >= 2) {
    const hasBridge = nearbyRamps.some((f: any) => f.tags?.bridge === 'yes');
    return {
      type: hasBridge ? 'interchange_diamond' : 'interchange_other',
      legs: 4,
      hasSignal: false,
      nearbyRoundaboutCount: 0,
    };
  }

  return {
    type: 'unknown',
    legs: 4,
    hasSignal: false,
    nearbyRoundaboutCount: 0,
  };
}

/**
 * Main entry: classify all intersections along a route.
 */
export async function classifyRouteIntersections(
  startCoords: { lat: number; lng: number },
  endCoords: { lat: number; lng: number },
  crossStreets: { name: string; position: number; lat?: number; lng?: number }[] = [],
): Promise<RouteIntersectionResult> {
  console.log('[intersectionClassifier] Querying OSM for roundabouts and interchanges...');

  // Check cache first (Overpass API can be inconsistent between rapid calls)
  const cacheKey = `${startCoords.lat.toFixed(4)},${startCoords.lng.toFixed(4)}_${endCoords.lat.toFixed(4)},${endCoords.lng.toFixed(4)}`;
  const cached = osmCache.get(cacheKey);
  let roundabouts: any[], interchangeFeatures: any[];

  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    roundabouts = cached.roundabouts;
    interchangeFeatures = cached.interchanges;
    console.log(`[intersectionClassifier] Using cached OSM data (${roundabouts.length} roundabouts)`);
  } else {
    [roundabouts, interchangeFeatures] = await Promise.all([
      queryOverpassRoundabouts(startCoords.lat, startCoords.lng, endCoords.lat, endCoords.lng),
      queryOverpassInterchanges(startCoords.lat, startCoords.lng, endCoords.lat, endCoords.lng),
    ]);
    osmCache.set(cacheKey, { roundabouts, interchanges: interchangeFeatures, timestamp: Date.now() });
  }

  console.log(`[intersectionClassifier] Found ${roundabouts.length} roundabouts, ${interchangeFeatures.length} interchange features`);

  // Check if any roundabouts are near the route (not just in the bounding box)
  const routeHasRoundabouts = roundabouts.length > 0;
  const roundaboutCount = roundabouts.length;

  // Detect dog-bone: 2+ roundabouts with a bridge between them
  let hasDogbone = false;
  if (roundaboutCount >= 2) {
    const hasBridge = interchangeFeatures.some((f: any) => f.tags?.bridge === 'yes');
    if (hasBridge) hasDogbone = true;
  }

  // Classify each cross-street intersection
  const intersections = crossStreets.map(cs => {
    // Interpolate lat/lng from position along route
    const lat = cs.lat || startCoords.lat + (endCoords.lat - startCoords.lat) * cs.position;
    const lng = cs.lng || startCoords.lng + (endCoords.lng - startCoords.lng) * cs.position;

    const classification = classifyPoint(lat, lng, roundabouts, interchangeFeatures);

    // Override for dog-bone detection
    if (hasDogbone && classification.nearbyRoundaboutCount > 0) {
      classification.type = 'interchange_dogbone';
    }

    return { name: cs.name, position: cs.position, classification, lat, lng };
  });

  // Also check the route itself for roundabouts (not just at cross-streets)
  // Sample 10 points along the route
  for (let i = 0; i <= 10; i++) {
    const frac = i / 10;
    const lat = startCoords.lat + (endCoords.lat - startCoords.lat) * frac;
    const lng = startCoords.lng + (endCoords.lng - startCoords.lng) * frac;
    const cls = classifyPoint(lat, lng, roundabouts, interchangeFeatures);
    if (cls.type.includes('roundabout') || cls.type.includes('interchange')) {
      // Check if we already have this intersection
      const exists = intersections.some(i => Math.abs(i.lat - lat) < 0.001 && Math.abs(i.lng - lng) < 0.001);
      if (!exists) {
        const type = hasDogbone ? 'interchange_dogbone' : cls.type;
        intersections.push({
          name: `Roundabout (OSM detected)`,
          position: frac,
          classification: { ...cls, type: type as IntersectionType },
          lat, lng,
        });
      }
    }
  }

  return { routeHasRoundabouts, roundaboutCount, intersections };
}
