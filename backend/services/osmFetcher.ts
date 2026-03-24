/**
 * OSM Road Network Fetcher
 * Fetches all road geometries within a bounding box from OpenStreetMap Overpass API.
 * Used as a basemap layer for Geometry Plan sheets.
 */
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

export interface OsmRoadway {
  name: string;
  highway: string; // motorway, trunk, primary, secondary, tertiary, residential, etc.
  nodes: { lat: number; lng: number }[];
  oneway: boolean;
  lanes: number;
}

export interface BasemapData {
  roads: OsmRoadway[];
  fetchedAt: number;
}

// Cache to avoid hammering Overpass
const basemapCache = new Map<string, BasemapData>();
const CACHE_TTL = 300000; // 5 minutes

/**
 * Fetch all highway ways within a buffered bounding box around the route.
 */
export async function fetchRoadNetwork(
  startLat: number, startLng: number,
  endLat: number, endLng: number,
  bufferFt = 500,
): Promise<OsmRoadway[]> {
  const bufferDeg = bufferFt / 364000;
  const latMin = Math.min(startLat, endLat) - bufferDeg;
  const latMax = Math.max(startLat, endLat) + bufferDeg;
  const lngMin = Math.min(startLng, endLng) - bufferDeg * 1.4; // Wider for longitude at Idaho latitudes
  const lngMax = Math.max(startLng, endLng) + bufferDeg * 1.4;

  const cacheKey = `${latMin.toFixed(3)}_${lngMin.toFixed(3)}_${latMax.toFixed(3)}_${lngMax.toFixed(3)}`;
  const cached = basemapCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
    console.log(`[osmFetcher] Using cached basemap (${cached.roads.length} roads)`);
    return cached.roads;
  }

  const query = `
    [out:json][timeout:15];
    way["highway"~"^(motorway|trunk|primary|secondary|tertiary|residential|unclassified|service|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$"](${latMin},${lngMin},${latMax},${lngMax});
    out body geom;
  `;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    const res = await fetch(OVERPASS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `data=${encodeURIComponent(query)}`,
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      console.warn(`[osmFetcher] Overpass returned ${res.status}`);
      return [];
    }

    const data = await res.json() as any;
    const elements = data.elements || [];

    const roads: OsmRoadway[] = elements
      .filter((el: any) => el.type === 'way' && el.geometry?.length >= 2)
      .map((el: any) => ({
        name: el.tags?.name || el.tags?.ref || '',
        highway: el.tags?.highway || 'unclassified',
        nodes: el.geometry.map((n: any) => ({ lat: n.lat, lng: n.lon })),
        oneway: el.tags?.oneway === 'yes',
        lanes: parseInt(el.tags?.lanes) || (el.tags?.highway === 'motorway' ? 4 : 2),
      }));

    console.log(`[osmFetcher] Fetched ${roads.length} roads from Overpass`);
    basemapCache.set(cacheKey, { roads, fetchedAt: Date.now() });
    return roads;
  } catch (err) {
    console.warn(`[osmFetcher] Overpass fetch failed:`, err);
    return [];
  }
}

/**
 * Get line weight for rendering based on highway classification.
 */
export function getOsmRoadStyle(highway: string): { lineWidth: number; color: string } {
  switch (highway) {
    case 'motorway': case 'trunk': return { lineWidth: 2.0, color: '#BBBBBB' };
    case 'primary': return { lineWidth: 1.5, color: '#CCCCCC' };
    case 'secondary': return { lineWidth: 1.2, color: '#CCCCCC' };
    case 'tertiary': return { lineWidth: 1.0, color: '#DDDDDD' };
    case 'residential': case 'unclassified': return { lineWidth: 0.6, color: '#DDDDDD' };
    case 'service': return { lineWidth: 0.4, color: '#EEEEEE' };
    default: return { lineWidth: 0.5, color: '#DDDDDD' };
  }
}
