/**
 * Geospatial Engineering Engine
 * ==============================
 * Commercial-grade coordinate projection and Linear Referencing System.
 * Uses UTM Zone 11N/12N (Idaho) for accurate distance/angle calculations.
 *
 * Consensus architecture: Claude Opus 4.6 + Gemini 3.1 Pro
 */
import proj4 from 'proj4';

// === UTM ZONE DEFINITIONS (Idaho spans Zone 11N and 12N) ===
// Boundary: -114° longitude (approx. Salmon/Stanley area)
const UTM_11N = '+proj=utm +zone=11 +datum=NAD83 +units=us-ft +no_defs';
const UTM_12N = '+proj=utm +zone=12 +datum=NAD83 +units=us-ft +no_defs';
const WGS84 = '+proj=longlat +datum=WGS84 +no_defs';

function getUtmZone(lng: number): string {
  return lng < -114 ? UTM_11N : UTM_12N;
}

function getUtmZoneNumber(lng: number): number {
  return lng < -114 ? 11 : 12;
}

// === INTERFACES ===
export interface UtmPoint {
  x: number; // Easting (US Survey Feet)
  y: number; // Northing (US Survey Feet)
}

export interface StationResult {
  x: number;
  y: number;
  heading: number; // degrees, 0=north, clockwise
  station: number; // cumulative distance in feet
}

export interface GpsPoint {
  lat: number;
  lng: number;
}

// === PROJECT ALIGNMENT (Primary LRS) ===
export class ProjectAlignment {
  private utmPoints: UtmPoint[] = [];
  private stations: number[] = []; // cumulative distance at each point
  private utmZone: string;
  public utmZoneNumber: number;
  public totalLengthFt: number;
  public gpsPoints: GpsPoint[];

  constructor(gpsPoints: GpsPoint[], anchorStation = 0) {
    if (gpsPoints.length < 2) throw new Error('Alignment requires at least 2 points');
    this.gpsPoints = gpsPoints;

    // Determine UTM zone from first point
    this.utmZone = getUtmZone(gpsPoints[0]!.lng);
    this.utmZoneNumber = getUtmZoneNumber(gpsPoints[0]!.lng);

    // Project all points to UTM
    this.utmPoints = gpsPoints.map(p => {
      const [x, y] = proj4(WGS84, this.utmZone, [p.lng, p.lat]);
      return { x: x!, y: y! };
    });

    // Calculate cumulative stations (chainage)
    this.stations = [anchorStation];
    for (let i = 1; i < this.utmPoints.length; i++) {
      const dx = this.utmPoints[i]!.x - this.utmPoints[i - 1]!.x;
      const dy = this.utmPoints[i]!.y - this.utmPoints[i - 1]!.y;
      const segLen = Math.sqrt(dx * dx + dy * dy);
      this.stations.push(this.stations[i - 1]! + segLen);
    }
    this.totalLengthFt = this.stations[this.stations.length - 1]!;
  }

  /** Get UTM-projected points */
  getUtmPoints(): UtmPoint[] {
    return [...this.utmPoints];
  }

  /** Get station value at a 0-1 fraction along the alignment */
  getStationAtFraction(fraction: number): number {
    return fraction * this.totalLengthFt;
  }

  /** Get fraction along alignment for a given station */
  getFractionAtStation(station: number): number {
    return station / this.totalLengthFt;
  }

  /**
   * Interpolate position, heading at a given station (chainage in feet).
   */
  getCoordinatesAtStation(stationFt: number): StationResult {
    // Clamp station to alignment bounds
    const sta = Math.max(0, Math.min(stationFt, this.totalLengthFt));

    // Find the segment containing this station
    let segIdx = 0;
    for (let i = 1; i < this.stations.length; i++) {
      if (this.stations[i]! >= sta) { segIdx = i - 1; break; }
      segIdx = i - 1;
    }

    const segStart = this.stations[segIdx]!;
    const segEnd = this.stations[segIdx + 1] ?? segStart;
    const segLen = segEnd - segStart;
    const frac = segLen > 0 ? (sta - segStart) / segLen : 0;

    const p0 = this.utmPoints[segIdx]!;
    const p1 = this.utmPoints[segIdx + 1] ?? p0;

    const x = p0.x + frac * (p1.x - p0.x);
    const y = p0.y + frac * (p1.y - p0.y);

    // Heading: angle from north, clockwise (standard surveying convention)
    const dx = p1.x - p0.x;
    const dy = p1.y - p0.y;
    const headingRad = Math.atan2(dx, dy); // atan2(east, north) = azimuth
    const headingDeg = ((headingRad * 180 / Math.PI) + 360) % 360;

    return { x, y, heading: headingDeg, station: sta };
  }

  /**
   * Generate offset polyline (parallel curve).
   * Positive offset = right side of travel direction.
   * Uses perpendicular offset with miter limiting for sharp curves.
   */
  getOffsetPolyline(offsetFt: number): UtmPoint[] {
    const pts = this.utmPoints;
    if (pts.length < 2) return [];
    const result: UtmPoint[] = [];
    const miterLimit = Math.abs(offsetFt) * 3; // Max miter extension

    for (let i = 0; i < pts.length; i++) {
      if (i === 0) {
        // First point: perpendicular to first segment
        const dx = pts[1]!.x - pts[0]!.x;
        const dy = pts[1]!.y - pts[0]!.y;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len === 0) continue;
        const nx = -dy / len; // perpendicular normal (right side)
        const ny = dx / len;
        result.push({ x: pts[0]!.x + nx * offsetFt, y: pts[0]!.y + ny * offsetFt });
      } else if (i === pts.length - 1) {
        // Last point: perpendicular to last segment
        const dx = pts[i]!.x - pts[i - 1]!.x;
        const dy = pts[i]!.y - pts[i - 1]!.y;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len === 0) continue;
        const nx = -dy / len;
        const ny = dx / len;
        result.push({ x: pts[i]!.x + nx * offsetFt, y: pts[i]!.y + ny * offsetFt });
      } else {
        // Interior point: bisector offset with miter limiting
        const dx1 = pts[i]!.x - pts[i - 1]!.x;
        const dy1 = pts[i]!.y - pts[i - 1]!.y;
        const len1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);
        const dx2 = pts[i + 1]!.x - pts[i]!.x;
        const dy2 = pts[i + 1]!.y - pts[i]!.y;
        const len2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);

        if (len1 === 0 || len2 === 0) {
          // Degenerate: use simple perpendicular
          const dx = len1 > 0 ? dx1 : dx2;
          const dy = len1 > 0 ? dy1 : dy2;
          const len = Math.sqrt(dx * dx + dy * dy);
          const nx = -dy / len;
          const ny = dx / len;
          result.push({ x: pts[i]!.x + nx * offsetFt, y: pts[i]!.y + ny * offsetFt });
          continue;
        }

        // Normals for each segment (right-side perpendicular)
        const n1x = -dy1 / len1, n1y = dx1 / len1;
        const n2x = -dy2 / len2, n2y = dx2 / len2;

        // Bisector
        let bx = n1x + n2x, by = n1y + n2y;
        const blen = Math.sqrt(bx * bx + by * by);
        if (blen < 0.001) {
          // Near-parallel segments, use first normal
          result.push({ x: pts[i]!.x + n1x * offsetFt, y: pts[i]!.y + n1y * offsetFt });
          continue;
        }
        bx /= blen;
        by /= blen;

        // Miter distance
        const dot = n1x * bx + n1y * by;
        let miterDist = dot !== 0 ? offsetFt / dot : offsetFt;

        // Miter limiting: if the miter is too long, clamp it
        if (Math.abs(miterDist) > miterLimit) {
          miterDist = Math.sign(miterDist) * miterLimit;
        }

        result.push({ x: pts[i]!.x + bx * miterDist, y: pts[i]!.y + by * miterDist });
      }
    }
    return result;
  }

  /**
   * Generate a closed polygon representing the work zone between two stations.
   * Returns UTM coordinates.
   */
  getWorkZonePolygon(startSta: number, endSta: number, leftOffsetFt: number, rightOffsetFt: number): UtmPoint[] {
    // Extract the segment of points between stations
    const segPoints: UtmPoint[] = [];
    const segStations: number[] = [];

    // Add interpolated start point
    const startPt = this.getCoordinatesAtStation(startSta);
    segPoints.push({ x: startPt.x, y: startPt.y });
    segStations.push(startSta);

    // Add intermediate points that fall between start and end stations
    for (let i = 0; i < this.stations.length; i++) {
      if (this.stations[i]! > startSta && this.stations[i]! < endSta) {
        segPoints.push(this.utmPoints[i]!);
        segStations.push(this.stations[i]!);
      }
    }

    // Add interpolated end point
    const endPt = this.getCoordinatesAtStation(endSta);
    segPoints.push({ x: endPt.x, y: endPt.y });
    segStations.push(endSta);

    // Create a sub-alignment for offsetting
    const subAlignment = new ProjectAlignmentFromUtm(segPoints);
    const leftEdge = subAlignment.getOffsetPolyline(leftOffsetFt);
    const rightEdge = subAlignment.getOffsetPolyline(rightOffsetFt);

    // Close the polygon: left edge forward, right edge backward
    return [...leftEdge, ...rightEdge.reverse()];
  }

  /**
   * Convert UTM coordinates to page coordinates for PDF rendering.
   * Fits the alignment into a rectangular viewport on the sheet.
   */
  toPageCoordinates(
    utmPt: UtmPoint,
    viewport: { centerX: number; centerY: number; rotation: number; scale: number },
    pageCenter: { x: number; y: number }
  ): { px: number; py: number } {
    // Translate to viewport center
    let dx = utmPt.x - viewport.centerX;
    let dy = utmPt.y - viewport.centerY;

    // Rotate to align road with horizontal
    const rad = -viewport.rotation * Math.PI / 180;
    const rx = dx * Math.cos(rad) - dy * Math.sin(rad);
    const ry = dx * Math.sin(rad) + dy * Math.cos(rad);

    // Scale to page units (points at 72 dpi)
    const px = pageCenter.x + rx / viewport.scale * 72;
    const py = pageCenter.y - ry / viewport.scale * 72; // Y is inverted on page

    return { px, py };
  }

  /**
   * Project a GPS point to UTM using this alignment's zone.
   */
  projectGps(gps: GpsPoint): UtmPoint {
    const [x, y] = proj4(WGS84, this.utmZone, [gps.lng, gps.lat]);
    return { x: x!, y: y! };
  }

  /**
   * Format a station value as engineering notation (e.g., 15+00.00)
   */
  static formatStation(stationFt: number): string {
    const hundreds = Math.floor(stationFt / 100);
    const remainder = stationFt % 100;
    return `${hundreds}+${remainder.toFixed(2).padStart(5, '0')}`;
  }
}

/**
 * Helper: Create alignment directly from UTM points (for sub-segments).
 */
class ProjectAlignmentFromUtm {
  private utmPoints: UtmPoint[];

  constructor(utmPoints: UtmPoint[]) {
    this.utmPoints = utmPoints;
  }

  getOffsetPolyline(offsetFt: number): UtmPoint[] {
    const pts = this.utmPoints;
    if (pts.length < 2) return [];
    const result: UtmPoint[] = [];
    const miterLimit = Math.abs(offsetFt) * 3;

    for (let i = 0; i < pts.length; i++) {
      if (i === 0 || i === pts.length - 1) {
        const j = i === 0 ? 0 : i - 1;
        const k = i === 0 ? 1 : i;
        const dx = pts[k]!.x - pts[j]!.x;
        const dy = pts[k]!.y - pts[j]!.y;
        const len = Math.sqrt(dx * dx + dy * dy) || 1;
        const nx = -dy / len, ny = dx / len;
        result.push({ x: pts[i]!.x + nx * offsetFt, y: pts[i]!.y + ny * offsetFt });
      } else {
        const dx1 = pts[i]!.x - pts[i - 1]!.x, dy1 = pts[i]!.y - pts[i - 1]!.y;
        const dx2 = pts[i + 1]!.x - pts[i]!.x, dy2 = pts[i + 1]!.y - pts[i]!.y;
        const len1 = Math.sqrt(dx1 * dx1 + dy1 * dy1) || 1;
        const len2 = Math.sqrt(dx2 * dx2 + dy2 * dy2) || 1;
        const n1x = -dy1 / len1, n1y = dx1 / len1;
        const n2x = -dy2 / len2, n2y = dx2 / len2;
        let bx = n1x + n2x, by = n1y + n2y;
        const blen = Math.sqrt(bx * bx + by * by) || 1;
        bx /= blen; by /= blen;
        const dot = n1x * bx + n1y * by;
        let miterDist = dot !== 0 ? offsetFt / dot : offsetFt;
        if (Math.abs(miterDist) > miterLimit) miterDist = Math.sign(miterDist) * miterLimit;
        result.push({ x: pts[i]!.x + bx * miterDist, y: pts[i]!.y + by * miterDist });
      }
    }
    return result;
  }
}

// === SHEET LAYOUT ENGINE (Grid Tiling) ===

export interface Viewport {
  sheetNumber: number;
  startStation: number;
  endStation: number;
  centerX: number;
  centerY: number;
  rotationDeg: number;
  scaleFtPerInch: number;
  // Grid tile info
  isIndexSheet?: boolean;
  tileMinX?: number;
  tileMinY?: number;
  tileMaxX?: number;
  tileMaxY?: number;
}

/**
 * Generate grid-tiled viewports for a project alignment.
 * For short/straight routes: single sheet.
 * For long/curvy routes: grid tiles + index sheet.
 * Much fewer sheets than linear strip-mapping for winding roads.
 */
export function generateViewports(
  alignment: ProjectAlignment,
  tileSizeFt?: number,
): Viewport[] {
  const viewports: Viewport[] = [];
  const pts = alignment.getUtmPoints();
  const totalLen = alignment.totalLengthFt;

  // Compute bounding box of the alignment
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }

  const extentX = maxX - minX;
  const extentY = maxY - minY;

  // Short route or small extent: single sheet
  if (totalLen <= 3000 && extentX < 3000 && extentY < 3000) {
    const midSta = totalLen / 2;
    const mid = alignment.getCoordinatesAtStation(midSta);
    viewports.push({
      sheetNumber: 1,
      startStation: 0,
      endStation: totalLen,
      centerX: mid.x,
      centerY: mid.y,
      rotationDeg: mid.heading,
      scaleFtPerInch: Math.max(50, Math.ceil(Math.max(extentX, extentY) * 1.6 / 14)),
    });
    return viewports;
  }

  // Dynamic tile size: target ~4-8 total detail sheets max
  // Scale tile size so the larger extent dimension fits in 2-3 tiles
  const maxExtent = Math.max(extentX, extentY);
  // Target 2-3 tiles per axis, minimum 3000ft per tile
  const effectiveTileSize = tileSizeFt || Math.max(3000, Math.ceil(maxExtent / 2.5 / 1000) * 1000);

  // Grid tiling for long/curvy routes
  const pad = effectiveTileSize * 0.2;
  const gridMinX = minX - pad, gridMinY = minY - pad;
  const gridMaxX = maxX + pad, gridMaxY = maxY + pad;

  const cols = Math.max(1, Math.ceil((gridMaxX - gridMinX) / effectiveTileSize));
  const rows = Math.max(1, Math.ceil((gridMaxY - gridMinY) / effectiveTileSize));

  // Adjust tile size to evenly divide the extent
  const tileW = (gridMaxX - gridMinX) / cols;
  const tileH = (gridMaxY - gridMinY) / rows;

  // Sheet 1: INDEX SHEET (full route overview with grid overlay)
  viewports.push({
    sheetNumber: 1,
    startStation: 0,
    endStation: totalLen,
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2,
    rotationDeg: 0, // North-up for index
    scaleFtPerInch: Math.ceil(Math.max(extentX, extentY) * 1.4 / 14),
    isIndexSheet: true,
    tileMinX: gridMinX,
    tileMinY: gridMinY,
    tileMaxX: gridMaxX,
    tileMaxY: gridMaxY,
  });

  // Generate tiles — only include tiles that contain road points
  let sheetNum = 2;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const tMinX = gridMinX + col * tileW;
      const tMaxX = tMinX + tileW;
      const tMinY = gridMinY + row * tileH;
      const tMaxY = tMinY + tileH;

      // Check if any alignment points fall in this tile
      const hasPoints = pts.some(p => p.x >= tMinX && p.x <= tMaxX && p.y >= tMinY && p.y <= tMaxY);
      if (!hasPoints) continue;

      // Find station range for points in this tile
      let minSta = totalLen, maxSta = 0;
      const stations = [0];
      for (let i = 1; i < pts.length; i++) {
        const dx = pts[i]!.x - pts[i - 1]!.x;
        const dy = pts[i]!.y - pts[i - 1]!.y;
        stations.push(stations[i - 1]! + Math.sqrt(dx * dx + dy * dy));
      }
      for (let i = 0; i < pts.length; i++) {
        if (pts[i]!.x >= tMinX && pts[i]!.x <= tMaxX && pts[i]!.y >= tMinY && pts[i]!.y <= tMaxY) {
          if (stations[i]! < minSta) minSta = stations[i]!;
          if (stations[i]! > maxSta) maxSta = stations[i]!;
        }
      }

      viewports.push({
        sheetNumber: sheetNum++,
        startStation: minSta,
        endStation: maxSta,
        centerX: (tMinX + tMaxX) / 2,
        centerY: (tMinY + tMaxY) / 2,
        rotationDeg: 0, // Grid tiles are always north-up
        scaleFtPerInch: Math.ceil(Math.max(tileW, tileH) * 1.2 / 14),
        tileMinX: tMinX,
        tileMinY: tMinY,
        tileMaxX: tMaxX,
        tileMaxY: tMaxY,
      });
    }
  }

  // Sort detail sheets by startStation so sheet numbers follow the route sequentially
  const indexSheet = viewports[0]!;
  const detailSheets = viewports.slice(1).sort((a, b) => a.startStation - b.startStation);
  // Re-number after sorting
  for (let i = 0; i < detailSheets.length; i++) {
    detailSheets[i]!.sheetNumber = i + 2;
  }

  console.log(`[SheetLayout] ${extentX.toFixed(0)}x${extentY.toFixed(0)} ft extent → ${cols}x${rows} grid → ${detailSheets.length} detail sheets + 1 index`);
  return [indexSheet, ...detailSheets];
}

/**
 * Decode a Google Maps encoded polyline into GPS points.
 */
export function decodeGooglePolyline(encoded: string): GpsPoint[] {
  const points: GpsPoint[] = [];
  let index = 0, lat = 0, lng = 0;

  while (index < encoded.length) {
    let shift = 0, result = 0, byte: number;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);

    shift = 0; result = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);

    points.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return points;
}
