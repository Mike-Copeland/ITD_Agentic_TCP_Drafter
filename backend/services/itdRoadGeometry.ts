/**
 * ITD Road Geometry Fetcher
 * Primary basemap data source — pulls actual road polylines from ITD ArcGIS.
 * Layer 13: All Roads (TransportationLayers/MapServer/13)
 * Returns geometry as GPS coordinates (outSR=4326).
 */

const ITD_BASE = 'https://gis.itd.idaho.gov/arcgisprod/rest/services/ArcGISOnline';

export interface ItdRoadSegment {
  segCode: string;
  routeName: string;
  beginMilepost: number;
  endMilepost: number;
  nodes: { lat: number; lng: number }[];
  funcClass?: string;
}

// Cache — road geometry doesn't change
const geoCache = new Map<string, { roads: ItdRoadSegment[]; timestamp: number }>();
const CACHE_TTL = 600000; // 10 minutes

/**
 * Fetch all ITD road geometries within a buffered area around the route.
 * Uses TransportationLayers/13 (All Roads) with returnGeometry=true.
 */
export async function fetchItdRoadGeometry(
  startLat: number, startLng: number,
  endLat: number, endLng: number,
  bufferMeters = 500,
): Promise<ItdRoadSegment[]> {
  const cacheKey = `${startLat.toFixed(3)}_${startLng.toFixed(3)}_${endLat.toFixed(3)}_${endLng.toFixed(3)}`;
  const cached = geoCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    console.log(`[itdRoadGeometry] Using cached geometry (${cached.roads.length} segments)`);
    return cached.roads;
  }

  // Use center point with large buffer to capture the full area
  const centerLat = (startLat + endLat) / 2;
  const centerLng = (startLng + endLng) / 2;

  // Query Layer 13 with geometry return in WGS84
  const url = `${ITD_BASE}/TransportationLayers/MapServer/13/query` +
    `?geometry=${centerLng},${centerLat}` +
    `&geometryType=esriGeometryPoint` +
    `&inSR=4326` +
    `&spatialRel=esriSpatialRelIntersects` +
    `&distance=${bufferMeters}` +
    `&units=esriSRUnit_Meter` +
    `&outFields=SegCode,BMP,EMP` +
    `&returnGeometry=true` +
    `&outSR=4326` +
    `&f=json` +
    `&resultRecordCount=100`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) {
      console.warn(`[itdRoadGeometry] ITD returned ${res.status}`);
      return [];
    }

    const data = await res.json() as any;
    const features = data.features || [];

    const roads: ItdRoadSegment[] = features
      .filter((f: any) => f.geometry?.paths?.length > 0)
      .flatMap((f: any) =>
        f.geometry.paths.map((path: number[][]) => ({
          segCode: f.attributes?.SegCode || '',
          routeName: '',
          beginMilepost: f.attributes?.BMP || 0,
          endMilepost: f.attributes?.EMP || 0,
          nodes: path.map((pt: number[]) => ({ lat: pt[1]!, lng: pt[0]! })),
        }))
      );

    console.log(`[itdRoadGeometry] Fetched ${roads.length} road segments (${features.length} features) from ITD Layer 13`);
    geoCache.set(cacheKey, { roads, timestamp: Date.now() });
    return roads;
  } catch (err) {
    console.warn(`[itdRoadGeometry] ITD fetch failed:`, err);
    return [];
  }
}

/**
 * Also query a wider area if the route is long (multiple queries along the route).
 */
export async function fetchItdRoadGeometryAlongRoute(
  startLat: number, startLng: number,
  endLat: number, endLng: number,
  bufferMeters = 500,
): Promise<ItdRoadSegment[]> {
  // For short routes (<1 mile), a single query from center is sufficient
  const routeLenDeg = Math.sqrt(
    Math.pow(endLat - startLat, 2) + Math.pow(endLng - startLng, 2)
  );

  if (routeLenDeg < 0.015) { // ~1 mile
    return fetchItdRoadGeometry(startLat, startLng, endLat, endLng, bufferMeters);
  }

  // For longer routes, sample 3 points along the route
  const allRoads: ItdRoadSegment[] = [];
  const seenSegCodes = new Set<string>();

  for (let frac = 0; frac <= 1; frac += 0.5) {
    const lat = startLat + (endLat - startLat) * frac;
    const lng = startLng + (endLng - startLng) * frac;
    const roads = await fetchItdRoadGeometry(lat, lng, lat, lng, bufferMeters);
    for (const road of roads) {
      const key = `${road.segCode}_${road.beginMilepost}`;
      if (!seenSegCodes.has(key)) {
        seenSegCodes.add(key);
        allRoads.push(road);
      }
    }
  }

  console.log(`[itdRoadGeometry] Total unique segments along route: ${allRoads.length}`);
  return allRoads;
}
