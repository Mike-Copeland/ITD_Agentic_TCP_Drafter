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

// Multiple Overpass endpoints for reliability
const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

// Aggressive cache — roundabouts don't move
const osmCache = new Map<string, { roundabouts: any[]; interchanges: any[]; timestamp: number }>();
const CACHE_TTL_MS = 600000; // 10 minutes

/**
 * Query OpenStreetMap for roundabouts near a route segment.
 * Uses Overpass API to find junction=roundabout ways within buffer.
 */
async function queryOverpassRoundabouts(
  startLat: number, startLng: number,
  endLat: number, endLng: number,
  bufferMeters = 800 // Increased from 500 for better coverage
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

  // Try each endpoint with retry
  for (const url of OVERPASS_URLS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 12000);
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `data=${encodeURIComponent(query)}`,
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if (!res.ok) { continue; }
        const data = await res.json() as any;
        const elements = data.elements || [];
        if (elements.length > 0) return elements; // Got data — use it
        // Got empty result — try again or next endpoint
        if (attempt === 0) await new Promise(r => setTimeout(r, 1000)); // Brief wait before retry
      } catch {
        if (attempt === 0) await new Promise(r => setTimeout(r, 1000));
      }
    }
  }
  console.warn('[intersectionClassifier] All Overpass endpoints failed for roundabouts');
  return [];
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

  for (const url of OVERPASS_URLS) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12000);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `data=${encodeURIComponent(query)}`,
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!res.ok) continue;
      const data = await res.json() as any;
      return data.elements || [];
    } catch { continue; }
  }
  return [];
}

/**
 * Cluster OSM roundabout way segments into distinct roundabout locations.
 * OSM stores roundabouts as multiple way segments — 9 ways could be 1 roundabout.
 * Cluster by proximity: segments within ~200ft of each other = same roundabout.
 */
interface RoundaboutCluster {
  lat: number;
  lng: number;
  segmentCount: number;
  maxLanes: number;
  hasBridge: boolean;
}

function clusterRoundabouts(roundaboutWays: any[], interchangeFeatures: any[]): RoundaboutCluster[] {
  const clusterRadiusDeg = 0.002; // ~700ft — enough to cluster all segments of one roundabout
  const clusters: RoundaboutCluster[] = [];

  for (const way of roundaboutWays) {
    const lat = way.center?.lat || way.lat || 0;
    const lng = way.center?.lon || way.lon || 0;
    if (!lat || !lng) continue;

    // Find existing cluster this segment belongs to
    const existing = clusters.find(c =>
      Math.abs(c.lat - lat) < clusterRadiusDeg && Math.abs(c.lng - lng) < clusterRadiusDeg
    );

    if (existing) {
      existing.segmentCount++;
      const lanes = way.tags?.lanes ? parseInt(way.tags.lanes) : 1;
      if (lanes > existing.maxLanes) existing.maxLanes = lanes;
      // Update center to average
      existing.lat = (existing.lat * (existing.segmentCount - 1) + lat) / existing.segmentCount;
      existing.lng = (existing.lng * (existing.segmentCount - 1) + lng) / existing.segmentCount;
    } else {
      clusters.push({
        lat, lng,
        segmentCount: 1,
        maxLanes: way.tags?.lanes ? parseInt(way.tags.lanes) : 1,
        hasBridge: false,
      });
    }
  }

  // Check if any cluster has a bridge nearby (dog-bone indicator)
  for (const cluster of clusters) {
    cluster.hasBridge = interchangeFeatures.some(f => {
      const fLat = f.center?.lat || f.lat || 0;
      const fLng = f.center?.lon || f.lon || 0;
      return Math.abs(fLat - cluster.lat) < clusterRadiusDeg * 2 &&
             Math.abs(fLng - cluster.lng) < clusterRadiusDeg * 2 &&
             f.tags?.bridge === 'yes';
    });
  }

  // Detect dog-bone: 2 roundabout clusters close together with a bridge between
  if (clusters.length >= 2) {
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const dist = Math.sqrt(
          Math.pow(clusters[i]!.lat - clusters[j]!.lat, 2) +
          Math.pow(clusters[i]!.lng - clusters[j]!.lng, 2)
        );
        if (dist < 0.005) { // ~1500ft — close enough to be a dog-bone pair
          clusters[i]!.hasBridge = true;
          clusters[j]!.hasBridge = true;
        }
      }
    }
  }

  console.log(`[intersectionClassifier] Clustered ${roundaboutWays.length} OSM ways into ${clusters.length} distinct roundabout(s)`);
  return clusters;
}

/**
 * Check if a point is near any roundabout cluster.
 */
function findNearestRoundabout(
  lat: number, lng: number, clusters: RoundaboutCluster[], proximityFt = 600
): RoundaboutCluster | null {
  const proximityDeg = proximityFt / 364000;
  let nearest: RoundaboutCluster | null = null;
  let nearestDist = Infinity;

  for (const c of clusters) {
    const dist = Math.sqrt(Math.pow(c.lat - lat, 2) + Math.pow(c.lng - lng, 2));
    if (dist < proximityDeg && dist < nearestDist) {
      nearest = c;
      nearestDist = dist;
    }
  }
  return nearest;
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

  console.log(`[intersectionClassifier] Found ${roundabouts.length} roundabout ways, ${interchangeFeatures.length} interchange features`);

  // Cluster OSM way segments into distinct roundabout locations
  const clusters = clusterRoundabouts(roundabouts, interchangeFeatures);
  const routeHasRoundabouts = clusters.length > 0;
  const roundaboutCount = clusters.length;

  // Detect dog-bone: 2+ clusters close together, or single cluster with bridge
  const hasDogbone = clusters.length >= 2 && clusters.some(c => c.hasBridge);
  const hasPeanut = clusters.length === 1 && clusters[0]!.segmentCount >= 4; // Many segments = elongated/peanut shape

  // Classify each cross-street — check if it's near a roundabout cluster
  const intersections = crossStreets.map(cs => {
    const lat = cs.lat || startCoords.lat + (endCoords.lat - startCoords.lat) * cs.position;
    const lng = cs.lng || startCoords.lng + (endCoords.lng - startCoords.lng) * cs.position;

    const nearestRB = findNearestRoundabout(lat, lng, clusters, 800); // 800ft proximity for cross-streets

    if (nearestRB) {
      const isDogbone = hasDogbone || nearestRB.hasBridge;
      const isPeanut = hasPeanut;
      const type: IntersectionType = isDogbone ? 'interchange_dogbone' :
        isPeanut ? 'roundabout_multi' : // Peanut roundabouts are typically multi-lane
        nearestRB.maxLanes >= 2 ? 'roundabout_multi' : 'roundabout_single';

      return {
        name: cs.name, position: cs.position, lat, lng,
        classification: {
          type,
          legs: 4,
          circulatoryLanes: nearestRB.maxLanes,
          hasSignal: false,
          hasSplitterIslands: true,
          nearbyRoundaboutCount: 1,
        } as IntersectionClassification,
      };
    }

    return {
      name: cs.name, position: cs.position, lat, lng,
      classification: { type: 'unknown' as IntersectionType, legs: 4, hasSignal: false, nearbyRoundaboutCount: 0 },
    };
  });

  // For each roundabout cluster, ensure at least one intersection entry exists
  for (const cluster of clusters) {
    const alreadyMapped = intersections.some(i =>
      i.classification.type.includes('roundabout') || i.classification.type.includes('interchange')
    );
    if (!alreadyMapped) {
      // No cross-street matched this roundabout — add it as a standalone entry
      const routeFrac = (() => {
        const dLat = endCoords.lat - startCoords.lat;
        const dLng = endCoords.lng - startCoords.lng;
        if (Math.abs(dLat) > Math.abs(dLng)) return (cluster.lat - startCoords.lat) / dLat;
        return (cluster.lng - startCoords.lng) / dLng;
      })();
      const pos = Math.max(0, Math.min(1, routeFrac));
      const isDogbone = hasDogbone || cluster.hasBridge;
      const isPeanut = hasPeanut;

      intersections.push({
        name: isDogbone ? 'Dog-Bone Roundabout Interchange' : isPeanut ? 'Peanut Roundabout' : 'Roundabout',
        position: pos,
        lat: cluster.lat,
        lng: cluster.lng,
        classification: {
          type: isDogbone ? 'interchange_dogbone' : isPeanut ? 'roundabout_multi' : cluster.maxLanes >= 2 ? 'roundabout_multi' : 'roundabout_single',
          legs: 4,
          circulatoryLanes: cluster.maxLanes,
          hasSignal: false,
          hasSplitterIslands: true,
          nearbyRoundaboutCount: 1,
        },
      });
      console.log(`[intersectionClassifier] Added standalone roundabout entry at ${cluster.lat.toFixed(5)}, ${cluster.lng.toFixed(5)} (${cluster.segmentCount} OSM segments, ${cluster.maxLanes} lanes)`);
    }
  }

  return { routeHasRoundabouts, roundaboutCount, intersections };
}
