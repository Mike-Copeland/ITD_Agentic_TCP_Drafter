import PDFDocument from 'pdfkit';
import fs from 'fs';
import Drawing from 'dxf-writer';
import * as MUTCD from '../engineering/mutcdPart6.js';
import { ProjectAlignment, generateViewports, decodeGooglePolyline } from '../engineering/GeospatialEngine.js';
import { fetchRoadNetwork, type OsmRoadway } from '../services/osmFetcher.js';
import { fetchItdRoadGeometryAlongRoute, type ItdRoadSegment } from '../services/itdRoadGeometry.js';

// ===================================================================
// DATA INTERFACES
// ===================================================================
export interface Sign {
  sign_code: string;
  distance_ft: number;
  label: string;
}

export interface Blueprint {
  primary_approach: Sign[];
  opposing_approach: Sign[];
  taper: { length_ft: number; device_type: string };
  downstream_taper: { length_ft: number };
  engineering_notes: string;
}

interface CrossStreet {
  name: string;
  position: number; // 0-1 fraction along route
  geometry?: {
    type: 'T-north' | 'T-south' | 'T-east' | 'T-west' | '4-way' | 'Y' | 'offset' | 'roundabout';
    hasSignal: boolean;
    hasStopSign: boolean;
    turnLanes: boolean;
    approachAngle: number;
    legs: number;
    intersectionType?: string; // OSM-derived: roundabout_single, roundabout_multi, interchange_dogbone, etc.
    circulatoryLanes?: number;
  };
}

type Doc = InstanceType<typeof PDFDocument>;

export interface ComplianceCheck {
  rule: string;
  requirement: string;
  actual: string;
  pass: boolean;
}

export interface CorrectionEntry {
  field: string;
  peValue: string;
  correctedValue: string;
  reason: string;
}

export interface GenerationResult {
  taCode: string;
  taDescription: string;
  taperLengthFt: number;
  bufferFt: number;
  deviceType: string;
  totalSheets: number;
  primarySigns: Sign[];
  opposingSigns: Sign[];
  compliance: ComplianceCheck[];
  corrections: CorrectionEntry[];
  dataWarnings: string[];
  roadClassification: string;
  signSpacingA: number;
  signSpacingB: number;
  signSpacingC: number;
}

// ===================================================================
// MATH UTILITIES
// ===================================================================
// ===================================================================
// PROFESSIONAL CAD PLOT STYLES
// ===================================================================
const PLOT = {
  EXISTING_EDGE:    { lineWidth: 0.5,  color: '#666666', dash: null as number[] | null },
  EXISTING_CENTER:  { lineWidth: 0.5,  color: '#CC9900', dash: [4, 4] },
  TTC_DEVICE:       { lineWidth: 1.5,  color: '#FF8C00', dash: null as number[] | null },
  TTC_WORK_AREA:    { lineWidth: 0.25, color: '#FF0000', dash: null as number[] | null },
  TTC_SIGN_LEADER:  { lineWidth: 0.4,  color: '#333333', dash: null as number[] | null },
  BASEMAP_MAJOR:    { lineWidth: 1.5,  color: '#BBBBBB', dash: null as number[] | null },
  BASEMAP_MINOR:    { lineWidth: 0.6,  color: '#DDDDDD', dash: null as number[] | null },
  PRIMARY_EDGE:     { lineWidth: 2.0,  color: '#000000', dash: null as number[] | null },
  PRIMARY_CENTER:   { lineWidth: 1.0,  color: '#CC9900', dash: [8, 6] },
  STATION_TICK:     { lineWidth: 0.4,  color: '#888888', dash: null as number[] | null },
};


function gpsToWebMercatorFt(lat: number, lng: number): { x: number; y: number } {
  const xMeters = (lng * 20037508.34) / 180;
  const latRad = (lat * Math.PI) / 180;
  const yMeters = Math.log(Math.tan(Math.PI / 4 + latRad / 2)) * (20037508.34 / Math.PI);
  return { x: xMeters * 3.28084, y: yMeters * 3.28084 };
}

function haversineDistanceFt(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 20902231;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const aLat = a.lat * Math.PI / 180;
  const bLat = b.lat * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat) * Math.cos(bLat) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

// Delegates to MUTCD module — single source of truth
function getABCSpacing(speedMph: number, terrain?: string, funcClass?: string, gradePercent = 0, aadt = 0, crossStreetCount = 0, roadName = ''): { a: number; b: number; c: number; classification: string } {
  const fcCode = funcClass ? parseInt(funcClass) || 99 : 99;
  return MUTCD.getSignSpacing(speedMph, fcCode, terrain, gradePercent, aadt, crossStreetCount, roadName);
}

// Delegates to MUTCD module — single source of truth
function getBufferSpaceFt(speedMph: number): number {
  return MUTCD.getBufferSpace(speedMph);
}

// Delegates to MUTCD module — single source of truth
function getDeviceSpacing(speedMph: number, taCode = 'TA-10'): { taperSpacingFt: number; tangentSpacingFt: number } {
  return {
    taperSpacingFt: MUTCD.taperDeviceSpacing(speedMph, taCode),
    tangentSpacingFt: MUTCD.tangentDeviceSpacing(speedMph),
  };
}

// Delegates to MUTCD module with ITD override — single source of truth
// Uses MUTCD Table 6H-1 categories: Conventional Road / Freeway or Expressway / Minimum
function getSignSize(speedMph: number, roadName: string, funcClassCode = 99, aadt = 0): string {
  const roadClass = MUTCD.classifyRoad(speedMph, funcClassCode, undefined, aadt, 0, roadName);
  return MUTCD.getITDSignSize(speedMph, roadName, roadClass, funcClassCode, aadt).label;
}

// Determine if a cross-street is a state/US highway (needs enhanced treatment)
function isHighway(name: string): boolean {
  // Match numbered routes (SH-44, US-20, I-84) AND unnumbered highways (Emmett Hwy)
  return /\b(ID|SH|US|I|SR|State Hwy|Highway|Hwy|Interstate)[\s-]*\d+/i.test(name)
    || /\b(Highway|Hwy)\b/i.test(name);
}

// Extract the numeric road identifier for deduplication
function extractRoadNumber(name: string): string {
  const m = name.match(/\b(?:ID|SH|US|I|SR|Highway|Hwy)[\s-]*(\d+)/i);
  return m ? m[1]! : '';
}

// ===================================================================
// PDF DRAWING HELPERS
// ===================================================================
function drawTitleBlock(doc: Doc, sheetNum: number, totalSheets: number, operationType: string, roadName: string) {
  const y0 = 700;
  doc.lineWidth(1.5).strokeColor('black');

  // PE Stamp block (top row)
  const peY = y0;
  const peH = 30;
  doc.lineWidth(1).rect(20, peY, 1184, peH).stroke();
  // PE seal circle
  doc.circle(50, peY + peH / 2, 12).stroke();
  doc.fontSize(3.5).fillColor('black');
  doc.text('PE', 45, peY + peH / 2 - 5, { lineBreak: false });
  doc.text('SEAL', 43, peY + peH / 2 + 1, { lineBreak: false });
  // Signature fields
  doc.fontSize(8).fillColor('#666');
  doc.text('LICENSED PROFESSIONAL ENGINEER:', 75, peY + 5, { lineBreak: false });
  doc.moveTo(260, peY + 14).lineTo(430, peY + 14).stroke(); // signature line
  doc.text('PE NO.:', 440, peY + 5, { lineBreak: false });
  doc.moveTo(480, peY + 14).lineTo(560, peY + 14).stroke();
  doc.text('DATE:', 570, peY + 5, { lineBreak: false });
  doc.moveTo(600, peY + 14).lineTo(700, peY + 14).stroke();
  doc.text('EXP:', 710, peY + 5, { lineBreak: false });
  doc.moveTo(735, peY + 14).lineTo(810, peY + 14).stroke();
  doc.fontSize(7).fillColor('#999');
  doc.text('I hereby certify that this plan was prepared by me or under my direct supervision.', 75, peY + 18, { lineBreak: false });

  // Main title block (bottom row)
  const tbY = peY + peH;
  const tbH = 50;
  doc.lineWidth(1.5).rect(20, tbY, 1184, tbH).stroke();

  // Vertical dividers
  doc.lineWidth(1);
  doc.moveTo(200, tbY).lineTo(200, tbY + tbH).stroke();
  doc.moveTo(350, tbY).lineTo(350, tbY + tbH).stroke();
  doc.moveTo(600, tbY).lineTo(600, tbY + tbH).stroke();
  doc.moveTo(820, tbY).lineTo(820, tbY + tbH).stroke();
  doc.moveTo(1050, tbY).lineTo(1050, tbY + tbH).stroke();

  // Row dividers
  doc.moveTo(200, tbY + 17).lineTo(350, tbY + 17).stroke();
  doc.moveTo(200, tbY + 34).lineTo(350, tbY + 34).stroke();
  doc.moveTo(1050, tbY + 17).lineTo(1204, tbY + 17).stroke();
  doc.moveTo(1050, tbY + 34).lineTo(1204, tbY + 34).stroke();

  doc.fontSize(7).fillColor('black');
  doc.text("REVISIONS", 25, tbY + 4, { width: 170, align: 'center', lineBreak: false });
  doc.text("DESIGNED:", 205, tbY + 5, { width: 140, lineBreak: false });
  doc.text("DETAILED:", 205, tbY + 22, { width: 140, lineBreak: false });
  doc.text("CHECKED:", 205, tbY + 39, { width: 140, lineBreak: false });

  doc.font('Helvetica-Bold').fontSize(11);
  doc.text("IDAHO TRANSPORTATION DEPARTMENT", 355, tbY + 6, { width: 240, align: 'center', lineBreak: false });
  doc.font('Helvetica').fontSize(8);
  if (roadName) doc.text(roadName.toUpperCase(), 355, tbY + 22, { width: 240, align: 'center', lineBreak: false });
  doc.fontSize(7).fillColor('#666').text('TEMPORARY TRAFFIC CONTROL', 355, tbY + 35, { width: 240, align: 'center', lineBreak: false });

  doc.fillColor('black').fontSize(7);
  doc.text("OPERATION:", 605, tbY + 4, { lineBreak: false });
  doc.font('Helvetica-Bold').fontSize(9).text(operationType.toUpperCase(), 605, tbY + 18, { width: 210, align: 'center', lineBreak: false });
  doc.font('Helvetica');

  doc.fontSize(7).text("AI-GENERATED TCP", 825, tbY + 4, { width: 220, align: 'center', lineBreak: false });
  doc.fontSize(8).text("PRELIMINARY", 825, tbY + 18, { width: 220, align: 'center', lineBreak: false });
  doc.fontSize(6).fillColor('#cc0000').text("NOT FOR CONSTRUCTION", 825, tbY + 32, { width: 220, align: 'center', lineBreak: false });

  doc.fillColor('black').fontSize(8);
  doc.text("ENGLISH", 1055, tbY + 4, { width: 140, lineBreak: false });
  doc.fontSize(7).text("STATE OF IDAHO", 1055, tbY + 22, { width: 140, lineBreak: false });
  doc.font('Helvetica-Bold').fontSize(8).text(`SHEET ${sheetNum} OF ${totalSheets}`, 1055, tbY + 39, { width: 140, lineBreak: false });
  doc.font('Helvetica');
}

function drawDimLine(doc: Doc, x1: number, x2: number, y: number, text: string) {
  const aw = 5, ah = 2.5; // arrowhead width and half-height
  doc.lineWidth(0.5).strokeColor('black');
  // Main line (gap in center for text)
  const tw = doc.fontSize(7).widthOfString(text);
  const mid = x1 + (x2 - x1) / 2;
  const gap = tw / 2 + 6;
  if (x2 - x1 > gap * 2) {
    doc.moveTo(x1, y).lineTo(mid - gap, y).stroke();
    doc.moveTo(mid + gap, y).lineTo(x2, y).stroke();
  } else {
    // Short zone: draw continuous line, white mask for text
    doc.moveTo(x1, y).lineTo(x2, y).stroke();
    doc.save().rect(mid - gap + 2, y - 5, (gap - 2) * 2, 10).fill('white').restore();
  }
  // Left arrowhead (filled triangle pointing right)
  doc.save();
  doc.moveTo(x1, y).lineTo(x1 + aw, y - ah).lineTo(x1 + aw, y + ah).closePath().fill('black');
  doc.restore();
  // Right arrowhead (filled triangle pointing left)
  doc.save();
  doc.moveTo(x2, y).lineTo(x2 - aw, y - ah).lineTo(x2 - aw, y + ah).closePath().fill('black');
  doc.restore();
  // Extension lines
  doc.moveTo(x1, y - 6).lineTo(x1, y + 6).stroke();
  doc.moveTo(x2, y - 6).lineTo(x2, y + 6).stroke();
  // Text centered in gap
  doc.fontSize(7).fillColor('black');
  doc.text(text, mid - tw / 2, y - 4, { lineBreak: false });
}

/** Get MUTCD-standard sign face text wrapping per the Standard Highway Signs publication */
function getMutcdSignFaceText(code: string, label: string): string[] {
  // Standard MUTCD sign face text layouts
  switch (code) {
    case 'W20-1': return ['ROAD', 'WORK', 'AHEAD'];
    case 'W20-4': return ['ONE LANE', 'ROAD', 'AHEAD'];
    case 'W20-5': return ['RIGHT', 'LANE', 'CLOSED', 'AHEAD'];
    case 'W20-5R': return ['RIGHT LANE', 'CLOSED', 'AHEAD'];
    case 'W20-5L': return ['LEFT LANE', 'CLOSED', 'AHEAD'];
    case 'W20-7a': return ['FLAGGER', '', 'AHEAD']; // Symbol in middle
    case 'W3-5': {
      // Extract speed from label
      const speedMatch = label.match(/(\d+)\s*MPH/);
      return speedMatch ? ['REDUCED', 'SPEED', speedMatch[1]!, 'AHEAD'] : ['REDUCED', 'SPEED', 'AHEAD'];
    }
    case 'W4-2R': return ['LANE', 'ENDS'];
    case 'W4-2L': return ['LANE', 'ENDS'];
    case 'W2-6': return ['', '', '']; // Roundabout symbol
    case 'W21-5': return ['SHOULDER', 'CLOSED', 'AHEAD'];
    case 'W21-5b': return ['SHOULDER', 'WORK', 'AHEAD'];
    default: {
      // Generic: split label into lines of ~8 chars max
      const words = label.replace(/\n/g, ' ').split(' ');
      const lines: string[] = [];
      let current = '';
      for (const word of words) {
        if (current.length + word.length > 8 && current) {
          lines.push(current.trim());
          current = word;
        } else {
          current += (current ? ' ' : '') + word;
        }
      }
      if (current) lines.push(current.trim());
      return lines;
    }
  }
}

function drawSignDiamond(doc: Doc, x: number, y: number, code: string, label: string) {
  const isRegulatory = /^R\d/.test(code);
  const isGuide = /^G\d/.test(code);
  const isWarning = !isRegulatory && !isGuide;

  doc.lineWidth(1.5).strokeColor('black');
  if (isWarning) {
    // MUTCD warning sign: orange diamond, black border, black legend text
    const sz = 16;
    doc.save().translate(x, y).rotate(45);
    doc.rect(-sz, -sz, sz * 2, sz * 2).fillAndStroke('#FF8C00', 'black');
    doc.rect(-sz + 2, -sz + 2, (sz - 2) * 2, (sz - 2) * 2).stroke(); // inner border per MUTCD
    doc.restore();
    // MUTCD sign face text — proper line wrapping per standard
    const faceLines = getMutcdSignFaceText(code, label);
    const lineH = 4.2;
    const startY = y - (faceLines.length * lineH) / 2;
    doc.font('Helvetica-Bold').fontSize(3.5).fillColor('black');
    faceLines.forEach((line, i) => {
      doc.text(line, x - 14, startY + i * lineH, { width: 28, align: 'center', lineBreak: false });
    });
    doc.font('Helvetica');
  } else if (isGuide) {
    // MUTCD guide sign: green rectangle, white legend, white border
    doc.rect(x - 18, y - 12, 36, 24).fillAndStroke('#006B3F', 'black');
    doc.lineWidth(0.5).strokeColor('white');
    doc.rect(x - 16, y - 10, 32, 20).stroke(); // inner white border
    doc.fontSize(4.5).fillColor('white');
    doc.text(label.replace(/\n/g, ' '), x - 15, y - 5, { width: 30, align: 'center' });
  } else {
    // MUTCD regulatory sign: white rectangle, black border, black legend
    doc.rect(x - 12, y - 14, 24, 28).fillAndStroke('#ffffff', 'black');
    doc.fontSize(4.5).fillColor('black');
    doc.text(label.replace(/\n/g, ' '), x - 10, y - 8, { width: 20, align: 'center' });
  }
  // Code and label below sign
  doc.fontSize(6.5).fillColor('black');
  doc.text(code, x - 45, y + 22, { width: 90, align: 'center', lineBreak: false });
  doc.fontSize(5.5).text(label.replace(/\n/g, ' '), x - 50, y + 31, { width: 100, align: 'center' });
}

// ===================================================================
// MULTI-LANE ROADWAY DRAWING
// Draws N lanes with correct edge lines, lane lines, centerline/median
// Returns { topEdge, bottomEdge, centerY, laneWidth } for positioning
// ===================================================================
interface RoadGeometry {
  topEdge: number;
  bottomEdge: number;
  centerY: number;
  lanePixelW: number;
  totalPixelH: number;
  lanes: number;
}

function drawRoadway(doc: Doc, x1: number, x2: number, centerY: number, ctx: DrawContext): RoadGeometry {
  const lanes = ctx.totalLanes || 2;
  // Dynamic lane width capped at 160px total road height to prevent overflow
  const maxRoadHeight = 160;
  const lanePixelW = Math.min(35, maxRoadHeight / lanes);
  const totalPixelH = lanes * lanePixelW;
  const topEdge = centerY - totalPixelH / 2;
  const bottomEdge = centerY + totalPixelH / 2;

  // Edge lines (solid, thick)
  doc.lineWidth(2).strokeColor('black');
  doc.moveTo(x1, topEdge).lineTo(x2, topEdge).stroke();
  doc.moveTo(x1, bottomEdge).lineTo(x2, bottomEdge).stroke();

  if (lanes <= 2) {
    // 2-lane: dashed centerline
    doc.lineWidth(1).dash(8, { space: 8 }).strokeColor('#333');
    doc.moveTo(x1, centerY).lineTo(x2, centerY).stroke();
    doc.undash();
  } else if (lanes === 3 && ctx.hasTWLTL) {
    // 3-lane with TWLTL: two solid yellow lines with dashed inner
    const turnTop = centerY - lanePixelW / 2;
    const turnBot = centerY + lanePixelW / 2;
    doc.lineWidth(1.5).strokeColor('#CC9900');
    doc.moveTo(x1, turnTop).lineTo(x2, turnTop).stroke();
    doc.moveTo(x1, turnBot).lineTo(x2, turnBot).stroke();
    doc.lineWidth(0.5).dash(6, { space: 6 });
    doc.moveTo(x1, centerY).lineTo(x2, centerY).stroke();
    doc.undash();
    // Label
    doc.save();
    doc.fontSize(5).fillColor('#666');
    doc.text('TWLTL', (x1 + x2) / 2 - 10, centerY - 3, { lineBreak: false });
    doc.restore();
  } else if (ctx.isDivided) {
    // Divided highway: hatched median
    const medW = lanePixelW * 0.6;
    doc.lineWidth(1.5).strokeColor('#CC9900');
    doc.moveTo(x1, centerY - medW / 2).lineTo(x2, centerY - medW / 2).stroke();
    doc.moveTo(x1, centerY + medW / 2).lineTo(x2, centerY + medW / 2).stroke();
    // Hatching inside median
    doc.save();
    doc.rect(x1, centerY - medW / 2, x2 - x1, medW).clip();
    doc.lineWidth(0.3).strokeColor('#CC9900');
    for (let i = x1; i < x2; i += 12) {
      doc.moveTo(i, centerY - medW / 2).lineTo(i + medW, centerY + medW / 2).stroke();
    }
    doc.restore();
  } else {
    // Multi-lane undivided: double yellow centerline
    doc.lineWidth(1).strokeColor('#CC9900');
    doc.moveTo(x1, centerY - 1.5).lineTo(x2, centerY - 1.5).stroke();
    doc.moveTo(x1, centerY + 1.5).lineTo(x2, centerY + 1.5).stroke();
  }

  // Draw lane lines (white dashed) for each lane boundary except center/edge
  doc.lineWidth(0.5).strokeColor('#666').dash(6, { space: 8 });
  const lanesPerDir = ctx.hasTWLTL ? Math.floor((lanes - 1) / 2) : Math.floor(lanes / 2);
  // Top half lanes (opposing direction)
  for (let i = 1; i < lanesPerDir; i++) {
    const y = topEdge + i * lanePixelW;
    doc.moveTo(x1, y).lineTo(x2, y).stroke();
  }
  // Bottom half lanes (primary direction)
  const bottomStart = ctx.hasTWLTL ? centerY + lanePixelW / 2 : centerY;
  for (let i = 1; i < lanesPerDir; i++) {
    const y = bottomStart + i * lanePixelW;
    if (y < bottomEdge - 2) doc.moveTo(x1, y).lineTo(x2, y).stroke();
  }
  doc.undash();

  // Lane count labels
  doc.fontSize(5).fillColor('#999');
  if (lanes > 2) {
    doc.text(`${lanesPerDir} LN`, x1 + 5, bottomEdge - lanePixelW + 2, { lineBreak: false });
    doc.text(`${lanesPerDir} LN`, x1 + 5, topEdge + 2, { lineBreak: false });
    if (ctx.hasTWLTL) doc.text('TURN', x1 + 5, centerY - 3, { lineBreak: false });
  }

  return { topEdge, bottomEdge, centerY, lanePixelW, totalPixelH, lanes };
}

function drawCrosshatch(doc: Doc, x1: number, y1: number, x2: number, y2: number) {
  doc.lineWidth(0.5).strokeColor('black');
  doc.rect(x1, y1, x2 - x1, y2 - y1).stroke();
  doc.save();
  doc.rect(x1, y1, x2 - x1, y2 - y1).clip();
  for (let i = x1 - (y2 - y1) * 2; i < x2 + (y2 - y1) * 2; i += 8) {
    doc.moveTo(i, y1).lineTo(i + (y2 - y1), y2).stroke();
    doc.moveTo(i + (y2 - y1), y1).lineTo(i, y2).stroke();
  }
  doc.restore();
}

// Break-line symbol kept for future use in long-route schematics
// function drawBreakLine(doc: Doc, x: number, y1: number, y2: number) { ... }

function drawFlaggerSymbol(doc: Doc, x: number, y: number, label: string) {
  // Person holding STOP/SLOW paddle
  doc.lineWidth(1.5).strokeColor('#cc0000');
  doc.circle(x, y - 12, 5).stroke(); // head
  doc.moveTo(x, y - 7).lineTo(x, y + 8).stroke(); // body
  doc.moveTo(x - 6, y).lineTo(x + 6, y).stroke(); // arms
  doc.moveTo(x, y + 8).lineTo(x - 5, y + 18).stroke(); // left leg
  doc.moveTo(x, y + 8).lineTo(x + 5, y + 18).stroke(); // right leg
  // Paddle
  doc.moveTo(x + 6, y).lineTo(x + 14, y - 8).stroke();
  doc.rect(x + 10, y - 16, 10, 10).fillAndStroke('#cc0000', 'black');
  doc.fontSize(4).fillColor('white').text("S/S", x + 11, y - 14, { lineBreak: false });
  doc.fillColor('black').fontSize(5).text(label, x - 20, y + 22, { width: 40, align: 'center', lineBreak: false });
}

/** Draw a 28" traffic cone (triangle with stripes) */
function drawCone(doc: Doc, x: number, y: number, size = 5) {
  doc.save();
  // Cone body (triangle)
  doc.moveTo(x, y - size).lineTo(x - size * 0.6, y + size * 0.4).lineTo(x + size * 0.6, y + size * 0.4).closePath();
  doc.fillAndStroke('#FF6600', 'black');
  // Reflective stripe
  doc.lineWidth(0.8).strokeColor('white');
  doc.moveTo(x - size * 0.35, y).lineTo(x + size * 0.35, y).stroke();
  doc.restore();
}

/** Draw a 42" drum (rectangle with diagonal stripes) */
function drawDrum(doc: Doc, x: number, y: number, size = 5) {
  doc.save();
  const w = size * 0.8, h = size * 1.2;
  doc.rect(x - w, y - h, w * 2, h * 2).fillAndStroke('#FF6600', 'black');
  // Reflective stripes (diagonal)
  doc.lineWidth(0.8).strokeColor('white');
  doc.moveTo(x - w, y - h * 0.3).lineTo(x + w, y + h * 0.3).stroke();
  doc.moveTo(x - w, y + h * 0.3).lineTo(x + w, y - h * 0.3).stroke();
  doc.restore();
}

/** Draw a Type III barricade — used in road closure schematics */
function drawBarricade(doc: Doc, x: number, y: number, size = 6) {
  doc.save();
  const w = size * 1.5, h = size;
  // Three horizontal rails with diagonal stripes
  for (let i = 0; i < 3; i++) {
    const ry = y - h + i * (h * 0.8);
    doc.rect(x - w, ry, w * 2, h * 0.5).fillAndStroke('#FF6600', 'black');
    doc.lineWidth(0.5).strokeColor('white');
    doc.moveTo(x - w + i * 3, ry).lineTo(x - w + i * 3 + h * 0.5, ry + h * 0.5).stroke();
  }
  // Legs
  doc.lineWidth(1).strokeColor('black');
  doc.moveTo(x - w * 0.7, y + h * 0.5).lineTo(x - w * 0.7, y + h * 1.2).stroke();
  doc.moveTo(x + w * 0.7, y + h * 0.5).lineTo(x + w * 0.7, y + h * 1.2).stroke();
  doc.restore();
}

/** Draw channelizing device based on work duration */
function drawDevice(doc: Doc, x: number, y: number, duration: string, size = 4) {
  if (/long/i.test(duration)) {
    drawDrum(doc, x, y, size);
  } else {
    drawCone(doc, x, y, size);
  }
}

function drawWatermark(doc: Doc) {
  doc.save();
  doc.fontSize(48).fillColor('#000000').opacity(0.035);
  doc.translate(612, 396);
  doc.rotate(-30);
  doc.text('PRELIMINARY — NOT FOR CONSTRUCTION', -380, -15, { align: 'center', width: 760 });
  doc.restore();
  doc.opacity(1);
}

// ===================================================================
// SHEET: COVER / GENERAL NOTES
// ===================================================================
function drawCoverSheet(doc: Doc, sheetNum: number, totalSheets: number, ctx: DrawContext) {
  doc.addPage({ size: 'tabloid', layout: 'landscape', margin: 0 });

  // Header
  doc.fontSize(20).fillColor('black').text("TEMPORARY TRAFFIC CONTROL PLAN", 0, 40, { align: 'center' });
  doc.fontSize(14).text(ctx.roadName ? ctx.roadName.toUpperCase() : 'IDAHO HIGHWAY', 0, 68, { align: 'center' });
  doc.fontSize(12).text(ctx.operationType.toUpperCase(), 0, 88, { align: 'center' });
  // N.T.S. on cover sheet — right-aligned
  const ntsText = 'ALL SCHEMATICS N.T.S.';
  doc.fontSize(9).fillColor('#cc0000');
  doc.text(ntsText, 1164 - doc.widthOfString(ntsText) - 30, 40, { lineBreak: false });
  doc.fillColor('black');

  // Project Info Box — dynamic height to prevent overflow
  const bx = 50, by = 130, bw = 500, lh = 20;
  // Cross-street names — allow wrapping (dynamic box height accommodates)
  const csStr = ctx.crossStreets.length > 0
    ? ctx.crossStreets.map(c => c.name).join(', ')
    : 'None detected';
  const info = [
    ['Road:', ctx.roadName || 'Not identified'],
    ['Operation:', ctx.operationType],
    ['Speed Limit:', `${ctx.speedMph} MPH (Work Zone: ${ctx.wzSpeedMph} MPH)`],
    ['Lane Width:', `${ctx.laneWidthFt} ft`],
    ['Route Distance:', ctx.routeDistanceFt > 0 ? `${ctx.routeDistanceFt.toLocaleString()} ft (${(ctx.routeDistanceFt / 5280).toFixed(1)} mi)` : 'N/A'],
    ['Start:', ctx.startCoords ? `${ctx.startCoords.lat.toFixed(5)}, ${ctx.startCoords.lng.toFixed(5)}` : 'N/A'],
    ['End:', ctx.endCoords ? `${ctx.endCoords.lat.toFixed(5)}, ${ctx.endCoords.lng.toFixed(5)}` : 'N/A'],
    ['Channelizing:', ctx.blueprint.taper.device_type],
    ['Project Duration:', ctx.duration],
    ['Lane Config:', ctx.totalLanes > 0 ? `${ctx.totalLanes} lanes${ctx.hasTWLTL ? ' (TWLTL)' : ''}${ctx.isDivided ? ' (divided)' : ''}` : 'Unknown'],
    ['Typical App:', `${ctx.taCode} — ${ctx.taDescription}`],
    ['AADT:', ctx.aadt > 0 ? `${ctx.aadt.toLocaleString()} vpd${ctx.truckPct > 0 ? ` (${ctx.truckPct.toFixed(1)}% trucks)` : ''}` : 'N/A'],
    ['Cross-Streets:', csStr],
  ];

  // Build sheet names first so we can size boxes to fit both
  const compatOps = ctx.operationTypes.filter((op: string) => {
    if (op === 'Median Crossover' && ctx.hasTWLTL) return false;
    if (op === 'Median Crossover' && !ctx.isDivided && ctx.totalLanes < 4) return false;
    if (op === 'Double Lane Closure' && ctx.totalLanes < 3) return false;
    return true;
  });
  const sheetNames = [
    'Cover Sheet & General Notes',
    ...compatOps.map((op: string) => {
      const ta = MUTCD.selectTA(op, ctx.totalLanes, parseInt(ctx.funcClass) || 99, ctx.isDivided, ctx.aadt, ctx.terrain);
      return `${ta.code}: ${op}`;
    }),
    'Site-Specific Work Zone Layout',
    ...ctx.crossStreets.map(cs => `Intersection Detail: ${cs.name}`),
    'Traffic Data & Queue Analysis',
    'Special Considerations',
    ...(ctx.geoPlanSheets > 0 ? (ctx.geoPlanSheets === 1 ? ['Geometry Plan'] : Array.from({ length: ctx.geoPlanSheets }, (_, i) => `Geometry Plan (${i + 1}/${ctx.geoPlanSheets})`)) : []),
    'Sign Schedule & Quantities',
  ];

  // Dynamic box height — fits both info rows AND sheet index rows
  const topBoxH = Math.max(240, info.length * lh + 35, sheetNames.length * 16 + 45);
  doc.lineWidth(1).strokeColor('black').rect(bx, by, bw, topBoxH).stroke();
  doc.fontSize(12).text("PROJECT INFORMATION", bx + 10, by + 8, { underline: true });
  let row = by + 30;
  doc.fontSize(9);
  for (const [label, value] of info) {
    doc.font('Helvetica-Bold').text(label!, bx + 10, row, { lineBreak: false });
    const valStr = String(value);
    doc.font('Helvetica').text(valStr, bx + 130, row, { width: bw - 140 });
    // Extra row height if value wraps to multiple lines
    row += (label === 'Cross-Streets:') ? Math.max(1, Math.ceil(valStr.length / 55)) * lh : lh;
  }

  // Sheet Index — height matches info box
  const ix = 600, iy = 130;
  doc.lineWidth(1).rect(ix, iy, 400, topBoxH).stroke();
  doc.font('Helvetica-Bold').fontSize(12).text("SHEET INDEX", ix + 10, iy + 8, { underline: true });
  doc.font('Helvetica').fontSize(9);
  sheetNames.forEach((name, i) => {
    doc.text(`Sheet ${i + 1}: ${name}`, ix + 10, iy + 32 + i * 16, { lineBreak: false });
  });

  // General Notes (left column) — pushed below dynamic info box
  const ny = by + topBoxH + 15;
  const notesBoxH = Math.min(320, 690 - ny); // Fill to 690, protect title block at 700
  doc.lineWidth(1).rect(50, ny, 780, notesBoxH).stroke();
  doc.font('Helvetica-Bold').fontSize(12).fillColor('black').text("GENERAL NOTES", 60, ny + 8, { underline: true });
  doc.font('Helvetica').fontSize(9);
  const notes = [
    '1. All temporary traffic control shall conform to the MUTCD 11th Edition (Dec 2023) and Idaho Supplementary provisions.',
    '2. All work shall comply with ITD Standard Specifications Section 626 — Temporary Traffic Control.',
    '3. The Contractor shall correct traffic control deficiencies within one hour of receiving notification (Section 626.03).',
    `4. All warning signs shall be ${getSignSize(ctx.speedMph, ctx.roadName)} diamond. ${isHighway(ctx.roadName) ? 'ITD requires 48" minimum on State/US Highways.' : ''}`,
    '5. Channelizing devices shall be 28-inch minimum height traffic cones for short-term operations, or 42-inch drums for long-term operations.',
    '6. Flagger certification required per ITD TCOC standards. Flaggers shall wear high-visibility safety apparel (ANSI/ISEA 107 Class 3).',
    '7. At night, flagger stations shall be illuminated. Retroreflective devices shall be used on all channelizing devices.',
    '8. All channelizing devices shall be crashworthy per MUTCD Section 6K.01 and NCHRP 350/MASH standards.',
    '9. Buffer spaces shall be maintained clear of all equipment, workers, and materials.',
    '10. All advance warning signs shall be removed or covered when the work zone is not active.',
    '11. The Contractor shall maintain access to all intersecting roads, driveways, and properties at all times unless otherwise approved.',
    `12. Posted Speed Limit: ${ctx.speedMph} MPH. Work Zone Speed: ${ctx.wzSpeedMph} MPH.`,
    `13. Taper Length: ${ctx.taperLengthFt} ft (${ctx.blueprint.taper.device_type}). Downstream Taper: ${ctx.blueprint.downstream_taper.length_ft} ft.`,
    `14. Minimum longitudinal buffer space: ${getBufferSpaceFt(ctx.speedMph)} ft (per MUTCD 11th Ed. Table 6B-2 for ${ctx.speedMph} MPH).`,
    `15. SINGLE PHASE OPERATION. All work shall be completed within a single traffic control setup.`,
  ];
  // Conditional notes with dynamic numbering
  let noteNum = 16;
  if (/mountainous|rolling/i.test(ctx.terrain)) {
    notes.push(`${noteNum++}. MOUNTAINOUS/ROLLING TERRAIN: Reduced sight distance conditions may exist. Additional advance warning signs or PCMS may be required. Verify flagger sight distance meets Table 6B-2 minimum (${getBufferSpaceFt(ctx.speedMph)} ft for ${ctx.speedMph} MPH).`);
  }
  if (ctx.routeDistanceFt > 5280) {
    notes.push(`${noteNum++}. LONG WORK ZONE (${(ctx.routeDistanceFt / 5280).toFixed(1)} mi): Place W20-1 "ROAD WORK AHEAD" repeater signs at 1-mile intervals within the activity area per MUTCD 6C.04.`);
  }
  if (ctx.crashCount >= 10) {
    notes.push(`${noteNum++}. HIGH CRASH LOCATION (${ctx.crashCount} crashes): ENHANCED MEASURES REQUIRED — Deploy PCMS, speed feedback signs, and/or law enforcement presence. Document enhanced measures in field TCP log.`);
  }
  let noteY = ny + 30;
  for (const note of notes) {
    doc.text(note, 60, noteY, { width: 760 });
    noteY += note.length > 90 ? 24 : 15;
    if (noteY > ny + notesBoxH - 10) break;
  }

  // Symbology Legend (right column) — same height as notes
  const lx = 850, ly = ny;
  doc.lineWidth(1).rect(lx, ly, 324, notesBoxH).stroke();
  doc.font('Helvetica-Bold').fontSize(12).fillColor('black').text("LEGEND", lx + 10, ly + 8, { underline: true });
  doc.font('Helvetica');
  let legendY = ly + 34;
  const legendStep = 28;

  // Warning sign (orange diamond)
  doc.save().translate(lx + 22, legendY + 6).rotate(45);
  doc.rect(-7, -7, 14, 14).fillAndStroke('#FF8C00', 'black');
  doc.restore();
  doc.fontSize(9).fillColor('black').text('WARNING SIGN (W-Series)', lx + 55, legendY + 2, { lineBreak: false });
  doc.fontSize(7).fillColor('#666').text('Orange diamond — Advance warning', lx + 55, legendY + 12, { lineBreak: false });
  legendY += legendStep;

  // Regulatory sign (white rectangle)
  doc.lineWidth(1).rect(lx + 15, legendY, 14, 16).fillAndStroke('#ffffff', 'black');
  doc.fontSize(9).fillColor('black').text('REGULATORY SIGN (R-Series)', lx + 55, legendY + 2, { lineBreak: false });
  doc.fontSize(7).fillColor('#666').text('White rectangle — Speed limit, etc.', lx + 55, legendY + 12, { lineBreak: false });
  legendY += legendStep;

  // Guide sign (green rectangle)
  doc.rect(lx + 15, legendY, 14, 12).fillAndStroke('#006B3F', 'black');
  doc.fontSize(9).fillColor('black').text('GUIDE SIGN (G-Series)', lx + 55, legendY + 2, { lineBreak: false });
  doc.fontSize(7).fillColor('#666').text('Green rectangle — END ROAD WORK', lx + 55, legendY + 12, { lineBreak: false });
  legendY += legendStep;

  // Channelizing devices (cone + drum)
  drawCone(doc, lx + 18, legendY + 6, 5);
  drawDrum(doc, lx + 30, legendY + 6, 4);
  doc.fontSize(9).fillColor('black').text('CHANNELIZING DEVICE', lx + 55, legendY + 2, { lineBreak: false });
  doc.fontSize(7).fillColor('#666').text('Cone (28") short-term | Drum (42") long-term', lx + 55, legendY + 12, { lineBreak: false });
  legendY += legendStep;

  // Flagger
  doc.circle(lx + 22, legendY + 2, 4).fillAndStroke('#cc0000', 'black');
  doc.moveTo(lx + 22, legendY + 6).lineTo(lx + 22, legendY + 14).stroke();
  doc.moveTo(lx + 18, legendY + 9).lineTo(lx + 26, legendY + 9).stroke();
  doc.fontSize(9).fillColor('black').text('FLAGGER STATION', lx + 55, legendY + 2, { lineBreak: false });
  doc.fontSize(7).fillColor('#666').text('TCOC certified, Class 3 apparel', lx + 55, legendY + 12, { lineBreak: false });
  legendY += legendStep;

  // Work area (crosshatch)
  doc.lineWidth(0.5).strokeColor('#cc0000');
  doc.rect(lx + 14, legendY, 16, 12).stroke();
  for (let hx = 0; hx < 16; hx += 5) {
    doc.moveTo(lx + 14 + hx, legendY + 12).lineTo(lx + 14 + hx + 12, legendY).stroke();
  }
  doc.fontSize(9).fillColor('black').text('WORK AREA', lx + 55, legendY + 2, { lineBreak: false });
  doc.fontSize(7).fillColor('#666').text('Crosshatched zone — No traffic', lx + 55, legendY + 12, { lineBreak: false });
  legendY += legendStep;

  // Arrow board
  doc.lineWidth(1).strokeColor('black');
  doc.rect(lx + 12, legendY + 1, 20, 10).fillAndStroke('#333', 'black');
  doc.fontSize(4).fillColor('#FFAA00').text('>>>>', lx + 14, legendY + 3, { lineBreak: false });
  doc.fontSize(9).fillColor('black').text('ARROW BOARD (Type A)', lx + 55, legendY + 2, { lineBreak: false });
  doc.fontSize(7).fillColor('#666').text('Required for multi-lane closures', lx + 55, legendY + 12, { lineBreak: false });
  legendY += legendStep;

  // Dimension line
  doc.lineWidth(0.5).strokeColor('black');
  doc.moveTo(lx + 12, legendY + 6).lineTo(lx + 34, legendY + 6).stroke();
  doc.save();
  doc.moveTo(lx + 12, legendY + 6).lineTo(lx + 16, legendY + 4).lineTo(lx + 16, legendY + 8).closePath().fill('black');
  doc.restore();
  doc.save();
  doc.moveTo(lx + 34, legendY + 6).lineTo(lx + 30, legendY + 4).lineTo(lx + 30, legendY + 8).closePath().fill('black');
  doc.restore();
  doc.fontSize(9).fillColor('black').text('DIMENSION LINE', lx + 55, legendY + 2, { lineBreak: false });
  doc.fontSize(7).fillColor('#666').text('Distances in feet', lx + 55, legendY + 12, { lineBreak: false });
  legendY += legendStep;

  // Edge line / centerline
  doc.lineWidth(2).strokeColor('black');
  doc.moveTo(lx + 12, legendY + 4).lineTo(lx + 34, legendY + 4).stroke();
  doc.lineWidth(1).dash(4, { space: 4 }).strokeColor('#CC9900');
  doc.moveTo(lx + 12, legendY + 12).lineTo(lx + 34, legendY + 12).stroke();
  doc.undash();
  doc.fontSize(9).fillColor('black').text('EDGE LINE / CENTERLINE', lx + 55, legendY + 2, { lineBreak: false });
  doc.fontSize(7).fillColor('#666').text('Solid = edge, Dashed = center', lx + 55, legendY + 12, { lineBreak: false });

  drawWatermark(doc);
  drawTitleBlock(doc, sheetNum, totalSheets, ctx.operationType, ctx.roadName);
}

// ===================================================================
// SHEET: TYPICAL APPLICATION (TA-10)
// ===================================================================
function drawTASheet(doc: Doc, sheetNum: number, totalSheets: number, ctx: DrawContext) {
  doc.addPage({ size: 'tabloid', layout: 'landscape', margin: 0 });

  const spacing = getABCSpacing(ctx.speedMph, ctx.terrain, ctx.funcClass, 0, 0, 0, ctx.roadName);
  const bufferFt = getBufferSpaceFt(ctx.speedMph);
  const taTitle = `${ctx.taCode}: ${ctx.taDescription.toUpperCase()}`;
  doc.fontSize(14).fillColor('black').text(`TYPICAL APPLICATION — ${taTitle}`, 0, 20, { align: 'center' });
  doc.fontSize(8).text(`MUTCD 11th Edition | ${spacing.classification} | A=${spacing.a}' B=${spacing.b}' C=${spacing.c}' | Buffer: ${bufferFt}' min (Table 6B-2)`, 0, 38, { align: 'center' });
  if (ctx.totalLanes > 0) {
    doc.fontSize(7).text(`${ctx.totalLanes}-lane road${ctx.hasTWLTL ? ' with center turn lane' : ''}${ctx.isDivided ? ' (divided)' : ''}`, 0, 50, { align: 'center' });
  }
  // N.T.S. label — Fix 6
  doc.fontSize(9).fillColor('#cc0000').text('SCHEMATIC — NOT TO SCALE (N.T.S.)', 900, 20, { lineBreak: false });
  doc.fillColor('black');

  const roadCL = 355;
  const roadL = 30, roadR = 1194;
  const isTwoWayFlagger = ['TA-10', 'TA-11'].includes(ctx.taCode);
  const isMultiLaneClosure = ['TA-30', 'TA-31', 'TA-33', 'TA-34', 'TA-37', 'TA-38'].includes(ctx.taCode);
  const isShoulder = ['TA-5', 'TA-22', 'TA-23'].includes(ctx.taCode);
  const isMedianCrossover = ctx.taCode === 'TA-18';
  const isMobileOps = ['TA-17', 'TA-35'].includes(ctx.taCode);
  const isRoadClosure = ctx.taCode === 'TA-13';
  const isDoubleLane = ctx.taCode === 'TA-37';

  // Zone boundaries adapt based on TA type
  // Multi-lane/divided: no opposing warning area (opposing traffic unaffected)
  // Shoulder: shorter taper, no lane closure
  // Zone boundaries — compressed work area, wider warning/transition/buffer
  const zones = (isTwoWayFlagger || isRoadClosure) ? {
    priWarningStart: 40, priWarningEnd: 300,
    transitionStart: 300, transitionEnd: 390,
    bufferStart: 390, bufferEnd: 460,
    activityStart: 460, activityEnd: 600, // Compressed work area
    dnBufferStart: 600, dnBufferEnd: 670,
    dnTransitionStart: 670, dnTransitionEnd: 720,
    terminationStart: 720, terminationEnd: 760,
    oppWarningStart: 760, oppWarningEnd: 1180,
  } : {
    // Multi-lane/shoulder: single-direction layout — more room for signs + longer taper
    priWarningStart: 40, priWarningEnd: 360,
    transitionStart: 360, transitionEnd: 530,  // Longer merging taper
    bufferStart: 530, bufferEnd: 600,
    activityStart: 600, activityEnd: 800, // Compressed work area
    dnBufferStart: 800, dnBufferEnd: 850,
    dnTransitionStart: 850, dnTransitionEnd: 920, // Downstream taper
    terminationStart: 920, terminationEnd: 980,
    oppWarningStart: 980, oppWarningEnd: 1180, // END ROAD WORK area
  };

  // Roadway — lane-aware drawing
  const road = drawRoadway(doc, roadL, roadR, roadCL, ctx);
  const roadY1 = road.topEdge;
  const roadY2 = road.bottomEdge;

  // Zone labels — positioned ABOVE signs to avoid interference
  doc.fontSize(8).fillColor('#333');
  const zoneLabelY = roadY1 - 240;
  doc.lineWidth(0.5).strokeColor('#999');

  const drawZoneLabel = (x1: number, x2: number, label1: string, label2?: string) => {
    doc.rect(x1, zoneLabelY, x2 - x1, 25).stroke();
    if (label2) {
      doc.text(label1, x1 + 2, zoneLabelY + 2, { width: x2 - x1 - 4, align: 'center', lineBreak: false });
      doc.text(label2, x1 + 2, zoneLabelY + 12, { width: x2 - x1 - 4, align: 'center', lineBreak: false });
    } else {
      doc.text(label1, x1 + 2, zoneLabelY + 4, { width: x2 - x1 - 4, align: 'center', lineBreak: false });
    }
  };

  drawZoneLabel(zones.priWarningStart, zones.priWarningEnd, 'ADVANCE', 'WARNING AREA');
  drawZoneLabel(zones.transitionStart, zones.transitionEnd, isMobileOps ? 'SHADOW' : isRoadClosure ? 'CLOSURE' : isTwoWayFlagger ? 'TRANSITION' : 'MERGING TAPER');
  drawZoneLabel(zones.bufferStart, zones.bufferEnd, isMobileOps ? 'SPACING' : 'BUFFER');
  drawZoneLabel(zones.activityStart, zones.activityEnd, isMobileOps ? 'MOVING WORK' : isRoadClosure ? 'CLOSED AREA' : 'ACTIVITY AREA');
  drawZoneLabel(zones.dnBufferStart, zones.dnBufferEnd, 'BUFFER');
  drawZoneLabel(zones.dnTransitionStart, zones.dnTransitionEnd, isTwoWayFlagger ? 'TRANS.' : 'DN TAPER');
  drawZoneLabel(zones.terminationStart, zones.terminationEnd, 'TERM.');
  if (isTwoWayFlagger || isRoadClosure) {
    drawZoneLabel(zones.oppWarningStart, zones.oppWarningEnd, 'ADVANCE', 'WARNING AREA');
  } else {
    drawZoneLabel(zones.oppWarningStart, zones.oppWarningEnd, 'END ROAD', 'WORK AREA');
  }

  // === TA-SPECIFIC SCHEMATIC ELEMENTS ===

  if (isTwoWayFlagger) {
    // TA-10: Flagger taper (short, closes entire opposing lane)
    doc.lineWidth(1).strokeColor('black');
    doc.moveTo(zones.transitionStart, roadY2).lineTo(zones.transitionEnd, roadCL + 3).stroke();
    for (let i = 0; i <= 8; i++) {
      const cx = zones.transitionStart + (i / 8) * (zones.transitionEnd - zones.transitionStart);
      const cy = roadY2 - (i / 8) * (roadY2 - roadCL - 3);
      drawDevice(doc, cx, cy, ctx.duration, 3);
    }
    // Work area fills opposing lane
    drawCrosshatch(doc, zones.activityStart, roadCL + 3, zones.activityEnd, roadY2 - 3);
    // Downstream taper
    doc.moveTo(zones.dnTransitionStart, roadCL + 3).lineTo(zones.dnTransitionEnd, roadY2).stroke();
    for (let i = 0; i <= 5; i++) {
      const cx = zones.dnTransitionStart + (i / 5) * (zones.dnTransitionEnd - zones.dnTransitionStart);
      const cy = roadCL + 3 + (i / 5) * (roadY2 - roadCL - 3);
      drawDevice(doc, cx, cy, ctx.duration, 3);
    }
    // Flaggers at both ends
    drawFlaggerSymbol(doc, zones.transitionStart - 15, roadY2 + 15, 'FLAGGER');
    drawFlaggerSymbol(doc, zones.dnBufferEnd + 15, roadY1 - 25, 'FLAGGER');
  } else if (isMultiLaneClosure) {
    // TA-30/31/33/35: Merging taper (shifts traffic left, right lane closed)
    // Taper: diagonal from right edge to right lane line
    const closedLaneTop = roadCL + (ctx.hasTWLTL ? road.lanePixelW / 2 : 0);
    const closedLaneBot = roadY2;
    doc.lineWidth(1).strokeColor('black');
    // Merging taper — angled line from right edge to lane line
    doc.moveTo(zones.transitionStart, closedLaneBot).lineTo(zones.transitionEnd, closedLaneTop).stroke();
    for (let i = 0; i <= 10; i++) {
      const cx = zones.transitionStart + (i / 10) * (zones.transitionEnd - zones.transitionStart);
      const cy = closedLaneBot - (i / 10) * (closedLaneBot - closedLaneTop);
      drawDevice(doc, cx, cy, ctx.duration, 3);
    }
    // Work area in closed lane
    drawCrosshatch(doc, zones.activityStart, closedLaneTop, zones.activityEnd, closedLaneBot - 3);
    // Channelizing devices along tangent (closed lane boundary)
    doc.lineWidth(0.5).strokeColor('black');
    const tangentSpacing = Math.max(40, ctx.speedMph * 2);
    for (let x = zones.activityStart; x <= zones.activityEnd; x += tangentSpacing) {
      drawDevice(doc, x, closedLaneTop, ctx.duration, 2.5);
    }
    // Downstream taper (shorter, shifts back to right)
    doc.lineWidth(1);
    doc.moveTo(zones.dnTransitionStart, closedLaneTop).lineTo(zones.dnTransitionEnd, closedLaneBot).stroke();
    for (let i = 0; i <= 5; i++) {
      const cx = zones.dnTransitionStart + (i / 5) * (zones.dnTransitionEnd - zones.dnTransitionStart);
      const cy = closedLaneTop + (i / 5) * (closedLaneBot - closedLaneTop);
      drawDevice(doc, cx, cy, ctx.duration, 3);
    }
    // Arrow board (Type A for multi-lane)
    const abX = zones.transitionStart - 30;
    doc.lineWidth(1).strokeColor('#CC6600');
    doc.rect(abX - 15, closedLaneBot - 18, 30, 12).fillAndStroke('#333', 'black');
    doc.fontSize(4).fillColor('#FFAA00');
    doc.text('>>>>', abX - 12, closedLaneBot - 16, { lineBreak: false });
    doc.fillColor('black').fontSize(5);
    doc.text('ARROW', abX - 12, closedLaneBot + 0, { lineBreak: false });
    doc.text('BOARD', abX - 12, closedLaneBot + 7, { lineBreak: false });
  } else if (isShoulder) {
    // TA-22/23: Shoulder work — taper into shoulder, traffic stays in lane
    const shoulderTop = roadY2;
    const shoulderBot = roadY2 + 15;
    // Shoulder area
    doc.lineWidth(0.5).strokeColor('#999');
    doc.moveTo(roadL, shoulderBot).lineTo(roadR, shoulderBot).stroke();
    doc.fontSize(5).fillColor('#666').text('SHOULDER', roadL + 10, shoulderTop + 2, { lineBreak: false });
    // Work in shoulder
    drawCrosshatch(doc, zones.activityStart, shoulderTop + 1, zones.activityEnd, shoulderBot - 1);
    // Shoulder taper (0.33 * L, short)
    doc.lineWidth(1).strokeColor('black');
    doc.moveTo(zones.transitionStart, shoulderBot).lineTo(zones.transitionEnd, shoulderTop).stroke();
    for (let i = 0; i <= 4; i++) {
      const cx = zones.transitionStart + (i / 4) * (zones.transitionEnd - zones.transitionStart);
      const cy = shoulderBot - (i / 4) * (shoulderBot - shoulderTop);
      drawDevice(doc, cx, cy, ctx.duration, 2.5);
    }
  } else if (isMedianCrossover) {
    // TA-18: Median crossover — traffic diverted through median to opposing lanes
    const medianY = roadCL;
    const oppLaneTop = roadY1;
    const oppLaneBot = medianY - (ctx.isDivided ? 5 : 0);
    // Crossover taper — traffic shifts from right side to left (opposing) side
    doc.lineWidth(1.5).strokeColor('black');
    // Upstream crossover: from primary lane across median to opposing lane
    doc.moveTo(zones.transitionStart, roadY2).quadraticCurveTo(zones.transitionEnd - 30, medianY, zones.transitionEnd, oppLaneTop + 5).stroke();
    doc.moveTo(zones.transitionStart, medianY).quadraticCurveTo(zones.transitionEnd - 30, oppLaneTop + 10, zones.transitionEnd, oppLaneTop).stroke();
    // Traffic runs in opposing lanes through work zone
    doc.lineWidth(0.5).dash(6, { space: 4 }).strokeColor('#0066cc');
    doc.moveTo(zones.activityStart, oppLaneTop + (oppLaneBot - oppLaneTop) / 2).lineTo(zones.activityEnd, oppLaneTop + (oppLaneBot - oppLaneTop) / 2).stroke();
    doc.undash();
    doc.fontSize(5).fillColor('#0066cc').text('TRAFFIC IN OPPOSING LANES', zones.activityStart + 20, oppLaneTop + 3, { lineBreak: false });
    // Work area fills primary lanes
    drawCrosshatch(doc, zones.activityStart, medianY + 3, zones.activityEnd, roadY2 - 3);
    // Downstream crossover: traffic returns from opposing to primary lanes
    doc.lineWidth(1.5).strokeColor('black');
    doc.moveTo(zones.dnTransitionStart, oppLaneTop + 5).quadraticCurveTo(zones.dnTransitionStart + 30, medianY, zones.dnTransitionEnd, roadY2).stroke();
    doc.moveTo(zones.dnTransitionStart, oppLaneTop).quadraticCurveTo(zones.dnTransitionStart + 30, oppLaneTop + 10, zones.dnTransitionEnd, medianY).stroke();
    // Channelizing devices along crossover tapers
    for (let i = 0; i <= 8; i++) {
      const frac = i / 8;
      const cx = zones.transitionStart + frac * (zones.transitionEnd - zones.transitionStart);
      const cy = roadY2 - frac * (roadY2 - oppLaneTop - 5);
      drawDevice(doc, cx, cy, ctx.duration, 3);
    }
    for (let i = 0; i <= 6; i++) {
      const frac = i / 6;
      const cx = zones.dnTransitionStart + frac * (zones.dnTransitionEnd - zones.dnTransitionStart);
      const cy = oppLaneTop + 5 + frac * (roadY2 - oppLaneTop - 5);
      drawDevice(doc, cx, cy, ctx.duration, 3);
    }
    // Median barrier/delineation label
    doc.fontSize(5).fillColor('#666').text('MEDIAN', zones.activityStart + 5, medianY - 3, { lineBreak: false });
  } else if (isMobileOps) {
    // TA-17/35: Mobile operations — shadow vehicle with TMA, moving work vehicle
    doc.lineWidth(1.5).strokeColor('black');
    // Work vehicle (in activity area)
    const wvX = zones.activityStart + 40, wvW = 50, wvH = 16;
    doc.rect(wvX, roadY2 - wvH - 3, wvW, wvH).fillAndStroke('#FFD700', 'black');
    doc.fontSize(4).fillColor('black').text('WORK', wvX + 5, roadY2 - wvH + 1, { lineBreak: false });
    doc.text('VEHICLE', wvX + 5, roadY2 - wvH + 6, { lineBreak: false });
    // Shadow vehicle with TMA (behind work vehicle)
    const svX = zones.transitionStart + 20, svW = 40;
    doc.rect(svX, roadY2 - wvH - 3, svW, wvH).fillAndStroke('#FF6600', 'black');
    doc.fontSize(4).fillColor('white').text('SHADOW', svX + 3, roadY2 - wvH + 1, { lineBreak: false });
    doc.text('+ TMA', svX + 3, roadY2 - wvH + 6, { lineBreak: false });
    // Arrow board on shadow vehicle
    doc.rect(svX + svW - 18, roadY2 - wvH - 12, 16, 8).fillAndStroke('#333', 'black');
    doc.fontSize(3).fillColor('#FFAA00').text('>>>>', svX + svW - 16, roadY2 - wvH - 10, { lineBreak: false });
    doc.fontSize(5).fillColor('black').text('ARROW BOARD', svX + svW + 2, roadY2 - wvH - 10, { lineBreak: false });
    // Direction arrow showing movement
    doc.lineWidth(1).strokeColor('#0066cc');
    doc.moveTo(zones.activityStart + 10, roadCL - 5).lineTo(zones.activityEnd - 10, roadCL - 5).stroke();
    doc.moveTo(zones.activityEnd - 15, roadCL - 8).lineTo(zones.activityEnd - 10, roadCL - 5).stroke();
    doc.moveTo(zones.activityEnd - 15, roadCL - 2).lineTo(zones.activityEnd - 10, roadCL - 5).stroke();
    doc.fontSize(5).fillColor('#0066cc').text('DIRECTION OF TRAVEL >>>', zones.activityStart + 15, roadCL - 14, { lineBreak: false });
    // Note
    doc.fontSize(5).fillColor('#666').text('MOVING OPERATION', zones.activityStart + 5, roadY2 + 3, { lineBreak: false });
  } else if (isRoadClosure) {
    // TA-13: Road closure — barriers across road, detour signs
    doc.lineWidth(2).strokeColor('#cc0000');
    // Barrier across road (primary approach)
    const barX = zones.transitionEnd;
    doc.moveTo(barX, roadY1).lineTo(barX, roadY2).stroke();
    doc.moveTo(barX + 3, roadY1).lineTo(barX + 3, roadY2).stroke();
    // Barrier across road (opposing approach)
    const barX2 = zones.dnTransitionStart;
    doc.moveTo(barX2, roadY1).lineTo(barX2, roadY2).stroke();
    doc.moveTo(barX2 + 3, roadY1).lineTo(barX2 + 3, roadY2).stroke();
    // Crosshatch entire work zone
    drawCrosshatch(doc, barX + 5, roadY1 + 3, barX2 - 3, roadY2 - 3);
    // ROAD CLOSED signs
    doc.lineWidth(1).strokeColor('black');
    doc.rect(barX - 30, roadY2 + 10, 35, 18).fillAndStroke('#ffffff', 'black');
    doc.fontSize(4).fillColor('#cc0000').text('R11-2', barX - 28, roadY2 + 13, { lineBreak: false });
    doc.text('ROAD', barX - 28, roadY2 + 19, { lineBreak: false });
    doc.text('CLOSED', barX - 28, roadY2 + 25, { lineBreak: false });
    // DETOUR arrow
    doc.rect(barX + 10, roadY2 + 10, 35, 18).fillAndStroke('#FF8C00', 'black');
    doc.fontSize(4).fillColor('black').text('M4-9', barX + 12, roadY2 + 13, { lineBreak: false });
    doc.text('DETOUR', barX + 12, roadY2 + 19, { lineBreak: false });
    doc.text('→', barX + 30, roadY2 + 17, { lineBreak: false });
    // Type III barricades at closure point
    drawBarricade(doc, barX - 5, roadY1 - 5, 5);
    drawBarricade(doc, barX + 5, roadY1 - 5, 5);
    doc.fontSize(5).fillColor('#cc0000').text('ROAD CLOSED', zones.activityStart + 20, roadCL - 5, { lineBreak: false });
  } else if (isDoubleLane) {
    // TA-37: Double lane closure — two staggered merging tapers
    const closedLaneTop = roadCL;
    const closedLaneBot = roadY2;
    const midLane = roadCL + (roadY2 - roadCL) / 2;
    doc.lineWidth(1).strokeColor('black');
    // First taper (right lane) — starts earlier
    doc.moveTo(zones.transitionStart, closedLaneBot).lineTo(zones.transitionStart + (zones.transitionEnd - zones.transitionStart) * 0.6, midLane).stroke();
    // Second taper (middle lane) — starts later, staggered
    const stagger = (zones.transitionEnd - zones.transitionStart) * 0.5;
    doc.moveTo(zones.transitionStart + stagger, midLane).lineTo(zones.transitionEnd, closedLaneTop).stroke();
    // Work area (two lanes)
    drawCrosshatch(doc, zones.activityStart, closedLaneTop + 3, zones.activityEnd, closedLaneBot - 3);
    // Channelizing devices along both tapers
    for (let i = 0; i <= 6; i++) {
      const frac = i / 6;
      const cx1 = zones.transitionStart + frac * (zones.transitionEnd - zones.transitionStart) * 0.6;
      const cy1 = closedLaneBot - frac * (closedLaneBot - midLane);
      drawDevice(doc, cx1, cy1, ctx.duration, 3);
    }
    for (let i = 0; i <= 6; i++) {
      const frac = i / 6;
      const cx2 = zones.transitionStart + stagger + frac * (zones.transitionEnd - zones.transitionStart - stagger);
      const cy2 = midLane - frac * (midLane - closedLaneTop);
      drawDevice(doc, cx2, cy2, ctx.duration, 3);
    }
    // Two arrow boards
    doc.rect(zones.transitionStart - 20, closedLaneBot - 18, 16, 8).fillAndStroke('#333', 'black');
    doc.fontSize(3).fillColor('#FFAA00').text('>>>', zones.transitionStart - 18, closedLaneBot - 16, { lineBreak: false });
    doc.rect(zones.transitionStart + stagger - 20, midLane - 18, 16, 8).fillAndStroke('#333', 'black');
    doc.fontSize(3).fillColor('#FFAA00').text('>>>', zones.transitionStart + stagger - 18, midLane - 16, { lineBreak: false });
    doc.fontSize(5).fillColor('black').text('2 ARROW BOARDS REQ\'D', zones.transitionStart - 25, closedLaneBot + 3, { lineBreak: false });
    // Downstream taper
    doc.lineWidth(1).strokeColor('black');
    doc.moveTo(zones.dnTransitionStart, closedLaneTop).lineTo(zones.dnTransitionEnd, closedLaneBot).stroke();
  }

  // Work area label (shared)
  const waLabelY = isMobileOps ? roadCL + 5 : isRoadClosure ? roadCL - 5 : isMedianCrossover ? roadCL + 17 : (isShoulder ? roadY2 + 5 : (isTwoWayFlagger ? roadCL + 17 : roadCL + 10));
  const waX1 = zones.activityStart;
  const waX2 = zones.activityEnd;
  doc.save();
  doc.fontSize(8);
  const waW = doc.widthOfString("WORK AREA");
  doc.rect(waX1 + (waX2 - waX1) / 2 - waW / 2 - 5, waLabelY - 3, waW + 10, 14).fill('white');
  doc.restore();
  doc.fillColor('black').fontSize(8).text("WORK AREA", waX1, waLabelY, { width: waX2 - waX1, align: 'center', lineBreak: false });

  // Break squiggle in work area — indicates section not fully depicted
  const breakX = (waX1 + waX2) / 2;
  const breakY1 = roadY1 + 3;
  const breakY2 = roadY2 - 3;
  doc.lineWidth(1.2).strokeColor('#666');
  const zigW = 4, zigSteps = Math.floor((breakY2 - breakY1) / 6);
  doc.moveTo(breakX - zigW, breakY1);
  for (let i = 0; i < zigSteps; i++) {
    const yy = breakY1 + (i + 0.5) * (breakY2 - breakY1) / zigSteps;
    doc.lineTo(breakX + (i % 2 === 0 ? zigW : -zigW), yy);
  }
  doc.lineTo(breakX - zigW, breakY2).stroke();

  // END ROAD WORK signs — orange rectangle at BOTH ends (primary downstream + opposing downstream)
  const drawEndRoadWork = (ex: number, ey: number) => {
    doc.lineWidth(1).strokeColor('black');
    doc.rect(ex - 18, ey, 36, 18).fillAndStroke('#FF8C00', 'black');
    doc.fontSize(4).fillColor('black');
    doc.text('END ROAD', ex - 18, ey + 3, { width: 36, align: 'center', lineBreak: false });
    doc.text('WORK', ex - 18, ey + 10, { width: 36, align: 'center', lineBreak: false });
    doc.fontSize(3.5);
    doc.text('G20-2', ex - 18, ey + 22, { width: 36, align: 'center', lineBreak: false });
  };
  // Primary downstream (right side, below road)
  drawEndRoadWork(zones.terminationEnd - 5, roadY2 + 16);
  // Opposing downstream (left side, above road) — only for two-way operations
  if (isTwoWayFlagger) {
    drawEndRoadWork(zones.priWarningStart - 5, roadY1 - 50);
  }
  doc.fillColor('black');

  // === SHARED: Signs, dimensions, notes ===

  // Primary approach signs
  const priSigns = ctx.blueprint.primary_approach;
  const priCount = priSigns.length;
  const priStep = priCount > 1 ? (zones.priWarningEnd - zones.priWarningStart - 40) / (priCount - 1) : 0;
  priSigns.forEach((sign, i) => {
    const x = zones.priWarningStart + 20 + i * priStep;
    const staggerY = i % 2 === 0 ? 0 : 60;
    drawSignDiamond(doc, x, roadY2 + 70 + staggerY, sign.sign_code, sign.label);
    if (i < priCount - 1) {
      // Show inter-sign distance (distance between consecutive signs), not cumulative
      const interDist = sign.distance_ft - priSigns[i + 1]!.distance_ft;
      drawDimLine(doc, x, zones.priWarningStart + 20 + (i + 1) * priStep, roadY2 + 52, `${Math.abs(interDist)} FT`);
    }
  });

  // Opposing/downstream signs — drawn RIGHT-TO-LEFT (opposing traffic direction)
  if (isTwoWayFlagger) {
    const oppSigns = [...ctx.blueprint.opposing_approach].sort((a, b) => b.distance_ft - a.distance_ft);
    if (ctx.speedMph !== ctx.wzSpeedMph && !oppSigns.some(s => s.sign_code === 'W3-5')) {
      oppSigns.push({ sign_code: 'W3-5', distance_ft: 350, label: `REDUCED SPEED ${ctx.wzSpeedMph} MPH AHEAD` });
    }
    const oppCount = oppSigns.length;
    const oppStep = oppCount > 1 ? (zones.oppWarningEnd - zones.oppWarningStart - 40) / (oppCount - 1) : 0;
    oppSigns.forEach((sign, i) => {
      const x = zones.oppWarningEnd - 20 - i * oppStep; // Start at far right, move left
      const staggerY = i % 2 === 0 ? 0 : -60;
      drawSignDiamond(doc, x, roadY1 - 145 + staggerY, sign.sign_code, sign.label);
      if (i < oppCount - 1) {
        const interDist = sign.distance_ft - oppSigns[i + 1]!.distance_ft;
        drawDimLine(doc, x - oppStep, x, roadY1 - 115, `${Math.abs(interDist)} FT`);
      }
    });
  }

  // Speed signs — W3-5 is already in the sign array, only draw R2-1 separately
  if (ctx.speedMph !== ctx.wzSpeedMph) {
    doc.lineWidth(1).strokeColor('black');
    // R2-1 SPEED LIMIT (white regulatory rectangle)
    const slX = zones.bufferStart;
    doc.rect(slX - 8, roadY2 + 60, 16, 24).fillAndStroke('#ffffff', 'black');
    doc.fontSize(3.5).fillColor('black').text('R2-1', slX - 6, roadY2 + 62, { lineBreak: false });
    doc.fontSize(3).text('SPEED', slX - 6, roadY2 + 68, { lineBreak: false });
    doc.text('LIMIT', slX - 6, roadY2 + 72, { lineBreak: false });
    doc.fontSize(7).font('Helvetica-Bold').text(`${ctx.wzSpeedMph}`, slX - 6, roadY2 + 76, { lineBreak: false });
    doc.font('Helvetica');
  }

  // Dimension lines — capped at 545 to stay above notes box at 585
  const dimY = Math.min(roadY2 + 100, 545);
  const taperLabel = isTwoWayFlagger ? `FLAGGER TAPER: ${ctx.taperLengthFt} FT` : `MERGING TAPER: ${ctx.taperLengthFt} FT`;
  drawDimLine(doc, zones.transitionStart, zones.transitionEnd, dimY, taperLabel);
  drawDimLine(doc, zones.bufferStart, zones.bufferEnd, dimY + 15, `BUFFER: ${bufferFt} FT`);
  drawDimLine(doc, zones.activityStart, zones.activityEnd, dimY, 'WORK AREA');
  if (isTwoWayFlagger) {
    drawDimLine(doc, zones.dnBufferStart, zones.dnBufferEnd, dimY + 15, `BUFFER: ${bufferFt} FT`);
  }
  drawDimLine(doc, zones.dnTransitionStart, zones.dnTransitionEnd, dimY, `DN TAPER: ${ctx.blueprint.downstream_taper.length_ft} FT`);

  // Direction arrows
  doc.fillColor('#444').fontSize(7);
  doc.text("PRIMARY APPROACH >>>", 40, dimY + 8, { lineBreak: false });
  if (isTwoWayFlagger) {
    doc.text("<<< OPPOSING APPROACH", 1040, roadY1 - 155, { lineBreak: false });
  } else {
    doc.text("TRAFFIC FLOW >>>", roadL + 5, roadY1 + 3, { lineBreak: false });
  }

  // Cross-streets
  if (ctx.crossStreets.length > 0) {
    doc.fillColor('black').fontSize(8);
    doc.text(`INTERSECTIONS WITHIN WORK ZONE: ${ctx.crossStreets.map(c => c.name).join(', ')}`, 40, dimY + 18, { width: 1140, lineBreak: false });
    doc.fontSize(7).text('See intersection detail sheets for cross-street signage requirements.', 40, dimY + 30, { lineBreak: false });
  }

  // Notes box — locked at Y=585 to stay above title block at Y=700
  const notesBoxY = 585;
  doc.lineWidth(0.5).rect(40, notesBoxY, 400, 90).stroke();
  doc.fontSize(9).fillColor('black');
  doc.font('Helvetica-Bold').text('NOTES:', 45, notesBoxY + 5);
  doc.font('Helvetica').fontSize(8);
  doc.text(`Speed: ${ctx.speedMph} MPH | WZ Speed: ${ctx.wzSpeedMph} MPH | Lanes: ${ctx.totalLanes || '2'} | Width: ${ctx.laneWidthFt} ft`, 45, notesBoxY + 18, { width: 390 });
  doc.text(`Taper: ${ctx.taperLengthFt} ft ${isTwoWayFlagger ? '(flagger)' : '(merging)'} | DN Taper: ${ctx.blueprint.downstream_taper.length_ft} ft | ${ctx.blueprint.taper.device_type}`, 45, notesBoxY + 30, { width: 390 });
  doc.text(`Route: ${ctx.routeDistanceFt > 0 ? ctx.routeDistanceFt.toLocaleString() + ' ft' : 'N/A'} | Spacing: A=${spacing.a}' B=${spacing.b}' C=${spacing.c}' | Buffer: ${bufferFt}' (6B-2)`, 45, notesBoxY + 42, { width: 390 });
  if (isMultiLaneClosure) doc.text('Arrow board (Type A) required at merging taper approach.', 45, notesBoxY + 54, { width: 390 });
  if (/mountainous|rolling/i.test(ctx.terrain)) {
    doc.font('Helvetica-Bold').fillColor('#cc0000');
    doc.text(`TERRAIN: ${ctx.terrain.toUpperCase()} — Verify flagger sight distance >= ${getBufferSpaceFt(ctx.speedMph)} ft.`, 45, notesBoxY + 54, { width: 390 });
    doc.font('Helvetica').fillColor('black');
  }
  if (ctx.routeDistanceFt > 5280) {
    doc.fillColor('#CC6600');
    doc.text(`LONG ZONE: ${(ctx.routeDistanceFt / 5280).toFixed(1)} mi — Place W20-1 repeaters at 1-mi intervals.`, 45, notesBoxY + 66, { width: 390 });
    doc.fillColor('black');
  }
  if (ctx.bridges && ctx.bridges.length > 0) {
    doc.fillColor('#cc0000').fontSize(7);
    doc.text(`BRIDGE(S): ${ctx.bridges.length} structure(s) within limits. NO DEVICES ON BRIDGE DECK WITHOUT APPROVAL.`, 460, notesBoxY + 66, { width: 390 });
    doc.fillColor('black');
  }

  drawWatermark(doc);
  drawTitleBlock(doc, sheetNum, totalSheets, ctx.operationType, ctx.roadName);
}

// ===================================================================
// SHEET: SITE-SPECIFIC LAYOUT
// ===================================================================
function drawSiteLayoutSheet(doc: Doc, sheetNum: number, totalSheets: number, ctx: DrawContext) {
  doc.addPage({ size: 'tabloid', layout: 'landscape', margin: 0 });

  doc.fontSize(14).fillColor('black').text("SITE-SPECIFIC WORK ZONE LAYOUT", 0, 25, { align: 'center' });
  if (ctx.roadName) doc.fontSize(10).text(ctx.roadName.toUpperCase(), 0, 45, { align: 'center' });

  const imgX = 312, imgY = 120, imgW = 600, imgH = 400;

  if (ctx.staticMapBase64) {
    try {
      doc.image(Buffer.from(ctx.staticMapBase64, 'base64'), imgX, imgY, { width: imgW, height: imgH });
    } catch {
      doc.rect(imgX, imgY, imgW, imgH).stroke();
      doc.fontSize(12).text("SATELLITE IMAGE UNAVAILABLE", imgX + 150, imgY + 190);
    }
  } else {
    doc.rect(imgX, imgY, imgW, imgH).stroke();
    doc.fontSize(12).text("NO SATELLITE IMAGE PROVIDED", imgX + 150, imgY + 190);
  }

  // Coordinate legend
  if (ctx.startCoords && ctx.endCoords) {
    doc.fillColor('black').fontSize(8);
    const ly = imgY + imgH + 10;
    doc.text(`START (S): ${ctx.startCoords.lat.toFixed(5)}, ${ctx.startCoords.lng.toFixed(5)}`, imgX, ly, { width: imgW / 2, align: 'left' });
    doc.text(`END (E): ${ctx.endCoords.lat.toFixed(5)}, ${ctx.endCoords.lng.toFixed(5)}`, imgX + imgW / 2, ly, { width: imgW / 2, align: 'right' });
    if (ctx.routeDistanceFt > 0) {
      doc.text(`Route: ${ctx.routeDistanceFt.toLocaleString()} ft (${(ctx.routeDistanceFt / 5280).toFixed(1)} mi)${ctx.roadName ? ' | ' + ctx.roadName : ''}`, imgX, ly + 12, { width: imgW, align: 'center' });
    }
  }

  // Cross-street list (with bounding box)
  let disclaimerY = imgY + imgH + 125;
  if (ctx.crossStreets.length > 0) {
    const csY = imgY + imgH + 45;
    const boxHeight = 25 + ctx.crossStreets.length * 15;
    doc.lineWidth(0.5).strokeColor('#999').rect(imgX, csY - 10, imgW, boxHeight).stroke();
    doc.fontSize(9).fillColor('black').font('Helvetica-Bold');
    doc.text('INTERSECTIONS WITHIN WORK ZONE:', imgX + 10, csY);
    doc.font('Helvetica').fontSize(8);
    ctx.crossStreets.forEach((cs, i) => {
      doc.text(`${i + 1}. ${cs.name} — See Sheet ${4 + i} for detail`, imgX + 20, csY + 16 + i * 14, { lineBreak: false });
    });
    disclaimerY = Math.max(disclaimerY, csY - 10 + boxHeight + 10);
  }

  doc.fillColor('#666').fontSize(7);
  doc.text("Route polyline and markers provided by Google Maps Platform. Verify on-site before construction.", imgX, disclaimerY, { width: imgW, align: 'center' });

  // North Arrow (inside map, upper-left with white BG mask)
  const naX = imgX + 20, naY = imgY + 20;
  doc.save();
  doc.fillOpacity(0.8).fillColor('white').rect(naX - 10, naY - 5, 25, 65).fill();
  doc.restore();
  doc.lineWidth(1.5).strokeColor('black');
  doc.moveTo(naX, naY + 40).lineTo(naX, naY).stroke();
  doc.save();
  doc.moveTo(naX, naY).lineTo(naX - 6, naY + 12).lineTo(naX + 6, naY + 12).closePath().fill('black');
  doc.restore();
  doc.font('Helvetica-Bold').fontSize(12).fillColor('black');
  doc.text('N', naX - 5, naY + 44, { lineBreak: false });
  doc.font('Helvetica');

  // Scale Bar (inside map, lower-left with white BG mask)
  if (ctx.routeDistanceFt > 0) {
    const sbX = imgX + 20, sbY = imgY + imgH - 30;
    // Calculate scale: imgW pixels represents routeDistanceFt
    const ftPerPx = ctx.routeDistanceFt / imgW;
    // Choose a round scale increment
    const rawBarFt = ftPerPx * 100; // 100px bar
    const scaleIncrements = [50, 100, 200, 500, 1000, 2000, 5000];
    const barFt = scaleIncrements.find(s => s >= rawBarFt * 0.8) || rawBarFt;
    const barPx = barFt / ftPerPx;

    doc.save();
    doc.fillOpacity(0.8).fillColor('white').rect(sbX - 5, sbY - 5, barPx + 40, 30).fill();
    doc.restore();

    doc.lineWidth(1).strokeColor('black');
    doc.moveTo(sbX, sbY).lineTo(sbX + barPx, sbY).stroke();
    // End ticks
    doc.moveTo(sbX, sbY - 5).lineTo(sbX, sbY + 5).stroke();
    doc.moveTo(sbX + barPx, sbY - 5).lineTo(sbX + barPx, sbY + 5).stroke();
    // Midpoint tick
    doc.moveTo(sbX + barPx / 2, sbY - 3).lineTo(sbX + barPx / 2, sbY + 3).stroke();
    // Labels
    doc.fontSize(6).fillColor('black');
    doc.text('0', sbX - 2, sbY + 7, { lineBreak: false });
    doc.text(`${barFt} FT`, sbX + barPx - 10, sbY + 7, { lineBreak: false });
    doc.fontSize(5).fillColor('#666');
    doc.text(`SCALE: 1" ≈ ${Math.round(ftPerPx * 72)} FT`, sbX, sbY + 18, { lineBreak: false });
  }

  // Project info sidebar (aligned to map top)
  const siX = 30, siY = imgY;
  doc.lineWidth(0.5).strokeColor('#999').rect(siX, siY, 260, 200).stroke();
  doc.font('Helvetica-Bold').fontSize(10).fillColor('black');
  doc.text('SITE INFORMATION', siX + 10, siY + 10);
  doc.font('Helvetica').fontSize(8);
  const siteInfo = [
    `Road: ${ctx.roadName || 'Not identified'}`,
    `TA: ${ctx.taCode} — ${ctx.taDescription}`,
    `Speed: ${ctx.speedMph} MPH | WZ: ${ctx.wzSpeedMph} MPH`,
    `Lanes: ${ctx.totalLanes || 'Unknown'}${ctx.isDivided ? ' (Divided)' : ''}${ctx.hasTWLTL ? ' (TWLTL)' : ''}`,
    `Taper: ${ctx.taperLengthFt} ft | Buffer: ${getBufferSpaceFt(ctx.speedMph)} ft`,
    `Devices: ${ctx.blueprint.taper.device_type}`,
    `Route: ${ctx.routeDistanceFt > 0 ? ctx.routeDistanceFt.toLocaleString() + ' ft' : 'N/A'}`,
    `Cross-Streets: ${ctx.crossStreets.length}`,
    `Sign Size: ${getSignSize(ctx.speedMph, ctx.roadName)}`,
  ];
  siteInfo.forEach((line, i) => {
    doc.text(line, siX + 10, siY + 30 + i * 16, { width: 240, lineBreak: false });
  });

  drawWatermark(doc);
  drawTitleBlock(doc, sheetNum, totalSheets, ctx.operationType, ctx.roadName);
}

// ===================================================================
// SHEET: INTERSECTION DETAIL (ENGINEERING-GRADE GEOMETRY)
// ===================================================================
// ===================================================================
// ROUNDABOUT DRAWING UTILITY
// ===================================================================
function drawRoundabout(doc: Doc, cx: number, cy: number, radius: number, legs: number, _ctx: DrawContext) {
  const legAngles = legs === 3 ? [0, 120, 240] :
    legs === 5 ? [0, 72, 144, 216, 288] :
    [0, 90, 180, 270]; // default 4-leg

  // Outer circle (edge of circulatory roadway)
  doc.lineWidth(2).strokeColor('black');
  doc.circle(cx, cy, radius).stroke();

  // Inner circle (central island)
  const innerR = radius * 0.45;
  doc.lineWidth(1.5).strokeColor('black');
  doc.circle(cx, cy, innerR).stroke();
  // Hatch the central island
  doc.lineWidth(0.5).strokeColor('#999');
  for (let a = 0; a < 360; a += 15) {
    const rad = a * Math.PI / 180;
    doc.moveTo(cx + innerR * 0.3 * Math.cos(rad), cy + innerR * 0.3 * Math.sin(rad))
       .lineTo(cx + innerR * 0.9 * Math.cos(rad), cy + innerR * 0.9 * Math.sin(rad)).stroke();
  }

  // Circulatory roadway (between inner and outer)
  doc.lineWidth(0.5).dash(4, { space: 4 }).strokeColor('#666');
  const midR = (radius + innerR) / 2;
  doc.circle(cx, cy, midR).stroke();
  doc.undash();

  // Approach legs
  const legLen = radius * 1.8;
  doc.lineWidth(2).strokeColor('black');
  for (const angle of legAngles) {
    const rad = (angle - 90) * Math.PI / 180; // -90 to start from top
    const outerX = cx + radius * Math.cos(rad);
    const outerY = cy + radius * Math.sin(rad);
    const farX = cx + legLen * Math.cos(rad);
    const farY = cy + legLen * Math.sin(rad);

    // Road edges (two lines for each leg)
    const perpRad = rad + Math.PI / 2;
    const halfW = radius * 0.18; // Scales with radius: 80r=14px, 120r=21px
    doc.moveTo(outerX + halfW * Math.cos(perpRad), outerY + halfW * Math.sin(perpRad))
       .lineTo(farX + halfW * Math.cos(perpRad), farY + halfW * Math.sin(perpRad)).stroke();
    doc.moveTo(outerX - halfW * Math.cos(perpRad), outerY - halfW * Math.sin(perpRad))
       .lineTo(farX - halfW * Math.cos(perpRad), farY - halfW * Math.sin(perpRad)).stroke();

    // Splitter island (triangle at entry)
    const splitterLen = radius * 0.25; // Scales with radius
    const splitterBase = cx + (radius + splitterLen) * Math.cos(rad);
    const splitterBaseY = cy + (radius + splitterLen) * Math.sin(rad);
    doc.lineWidth(1).strokeColor('#666');
    doc.moveTo(outerX + halfW * 0.3 * Math.cos(perpRad), outerY + halfW * 0.3 * Math.sin(perpRad))
       .lineTo(splitterBase, splitterBaseY)
       .lineTo(outerX - halfW * 0.3 * Math.cos(perpRad), outerY - halfW * 0.3 * Math.sin(perpRad)).stroke();

    // Yield triangle at entry (scaled with radius)
    const yieldHW = radius * 0.05;
    const yieldLen = radius * 0.06;
    doc.lineWidth(0.8).strokeColor('#cc0000');
    const yieldX = outerX + 3 * Math.cos(rad);
    const yieldY = outerY + 3 * Math.sin(rad);
    doc.moveTo(yieldX - yieldHW * Math.cos(perpRad), yieldY - yieldHW * Math.sin(perpRad))
       .lineTo(yieldX + yieldHW * Math.cos(perpRad), yieldY + yieldHW * Math.sin(perpRad))
       .lineTo(yieldX + yieldLen * Math.cos(rad), yieldY + yieldLen * Math.sin(rad))
       .closePath().stroke();
  }

  // Circulation arrows (curved arrows showing traffic flow)
  doc.lineWidth(1).strokeColor('#0066cc');
  for (let i = 0; i < 4; i++) {
    const startAngle = i * 90 + 20;
    const endAngle = i * 90 + 70;
    const arrowR = midR;
    const sRad = (startAngle - 90) * Math.PI / 180;
    // Draw arc segment
    doc.moveTo(cx + arrowR * Math.cos(sRad), cy + arrowR * Math.sin(sRad));
    // Approximate arc with line segments
    for (let a = startAngle + 5; a <= endAngle; a += 5) {
      const r = (a - 90) * Math.PI / 180;
      doc.lineTo(cx + arrowR * Math.cos(r), cy + arrowR * Math.sin(r));
    }
    doc.stroke();
    // Arrowhead
    const tipRad = (endAngle - 90) * Math.PI / 180;
    const tipX = cx + arrowR * Math.cos(tipRad);
    const tipY = cy + arrowR * Math.sin(tipRad);
    doc.save();
    doc.moveTo(tipX, tipY)
       .lineTo(tipX - 4 * Math.cos(tipRad + 0.5), tipY - 4 * Math.sin(tipRad + 0.5))
       .lineTo(tipX - 4 * Math.cos(tipRad - 0.5), tipY - 4 * Math.sin(tipRad - 0.5))
       .closePath().fill('#0066cc');
    doc.restore();
  }

  // Label
  doc.fontSize(6).fillColor('#666');
  doc.text('ROUNDABOUT', cx - 25, cy - 4, { width: 50, align: 'center', lineBreak: false });
}

function drawIntersectionSheet(doc: Doc, sheetNum: number, totalSheets: number, ctx: DrawContext, cs: CrossStreet) {
  doc.addPage({ size: 'tabloid', layout: 'landscape', margin: 0 });

  doc.fontSize(14).fillColor('black').text(`INTERSECTION DETAIL: ${cs.name.toUpperCase()}`, 0, 25, { align: 'center' });
  doc.fontSize(9).text(`${ctx.roadName || 'Main Road'} at ${cs.name} — Approximate Position: ${Math.round(cs.position * 100)}% along route`, 0, 45, { align: 'center' });

  const cx = 612, cy = 340;
  const mainLen = 450, crossLen = 250;
  const geo = cs.geometry || { type: '4-way', hasSignal: false, hasStopSign: false, turnLanes: false, approachAngle: 0, legs: 4 };

  // Normalize geo.type to lowercase for case-insensitive matching
  const geoType = (geo.type || '4-way').toLowerCase();
  const hasNorth = geoType === 't-north' || geoType === 't-west' || geoType === '4-way' || geoType === 'y' || !geoType.startsWith('t-');
  const hasSouth = geoType === 't-south' || geoType === 't-east' || geoType === '4-way' || geoType === 'y' || !geoType.startsWith('t-');

  // Geometry type label
  const geoLabel = geoType === '4-way' ? '4-WAY INTERSECTION' :
    geoType.startsWith('t-') ? `T-INTERSECTION (${geoType.replace('t-', '').toUpperCase()})` :
    geoType === 'y' ? 'Y-INTERSECTION' : geoType === 'roundabout' ? 'ROUNDABOUT / CIRCULAR INTERSECTION' : 'INTERSECTION';
  doc.fontSize(8).fillColor('#666').text(geoLabel, 0, 60, { align: 'center' });

  // === ROUNDABOUT: Use circular template ===
  if (geo.type === 'roundabout') {
    const roundaboutR = 120; // Scaled up proportionally with intersection sizing
    drawRoundabout(doc, cx, cy, roundaboutR, geo.legs || 4, ctx);

    // Title and classification
    doc.fontSize(10).fillColor('black');
    doc.text(ctx.roadName || 'MAIN ROAD', cx + roundaboutR * 2 + 20, cy - 5, { lineBreak: false });
    doc.fontSize(9);
    doc.text(cs.name.toUpperCase(), cx - 60, cy - roundaboutR * 2 - 25, { width: 120, align: 'center', lineBreak: false });

    // Work zone overlay (shade one quadrant)
    doc.save();
    doc.lineWidth(0.5).strokeColor('#cc0000');
    const wzStartAngle = 0, wzEndAngle = 90;
    for (let a = wzStartAngle; a <= wzEndAngle; a += 3) {
      const r = (a - 90) * Math.PI / 180;
      const innerR = roundaboutR * 0.45;
      doc.moveTo(cx + innerR * Math.cos(r), cy + innerR * Math.sin(r))
         .lineTo(cx + roundaboutR * Math.cos(r), cy + roundaboutR * Math.sin(r)).stroke();
    }
    doc.restore();
    doc.fontSize(5).fillColor('#cc0000').text('WORK ZONE', cx + roundaboutR * 0.5, cy - roundaboutR * 0.5, { lineBreak: false });

    // Advance warning signs on each approach leg
    const legAngles = geo.legs === 3 ? [0, 120, 240] : [0, 90, 180, 270];
    legAngles.forEach((angle) => {
      const rad = (angle - 90) * Math.PI / 180;
      const signDist = roundaboutR * 1.7; // Tightened to stay above notes box at Y=550
      const sx = cx + signDist * Math.cos(rad);
      const sy = cy + signDist * Math.sin(rad);
      drawSignDiamond(doc, sx, sy, 'W20-1', 'ROAD WORK\nAHEAD');
      // W2-6 Roundabout Ahead on each approach
      const w26x = cx + (signDist - 40) * Math.cos(rad);
      const w26y = cy + (signDist - 40) * Math.sin(rad);
      drawSignDiamond(doc, w26x, w26y, 'W2-6', 'ROUNDABOUT\nAHEAD');
    });

    // Notes — positioned below scaled roundabout
    const noteX = 50, noteY = 550;
    doc.lineWidth(0.5).rect(noteX, noteY, 1120, 130).stroke();
    doc.font('Helvetica-Bold').fontSize(10).fillColor('black').text('ROUNDABOUT TRAFFIC CONTROL NOTES:', noteX + 10, noteY + 6);
    doc.font('Helvetica').fontSize(9);
    const rbNotes = [
      `1. CIRCULAR INTERSECTION — Use TA-52/53/54 per MUTCD Chapter 6P, not linear TAs.`,
      `2. Place W2-6 "ROUNDABOUT AHEAD" on ALL approach legs at min ${getABCSpacing(ctx.speedMph, ctx.terrain, ctx.funcClass).a} ft.`,
      `3. Device spacing in circulatory roadway: ${Math.round(ctx.speedMph / 2)} ft max (1/2 × S per TA-53 Note 8).`,
      `4. Maintain YIELD (R1-2) at all entries. Cover inapplicable signs during construction.`,
      `5. Flaggers at entries must coordinate to prevent conflicting movements.`,
      `6. Maintain truck turning radius through work zone. WB-67 swept path recommended.`,
      `7. Cover WRONG WAY / DO NOT ENTER signs that become inapplicable per TA-52 Note 5.`,
      `8. ${ctx.crashCount >= 10 ? 'HIGH CRASH (' + ctx.crashCount + '): Deploy PCMS + law enforcement.' : 'Monitor speeds. Deploy speed feedback signs if warranted.'}`,
    ];
    rbNotes.forEach((n, i) => doc.text(n, noteX + 10, noteY + 20 + i * 13, { width: 1100 }));

    drawWatermark(doc);
    drawTitleBlock(doc, sheetNum, totalSheets, ctx.operationType, ctx.roadName);
    return;
  }

  // === DOG-BONE INTERCHANGE: Two roundabouts + bridge ===
  if (geo.intersectionType === 'interchange_dogbone') {
    const r1x = cx - 150, r2x = cx + 150;
    const rR = 80; // Scaled proportionally with standard intersection sizing
    doc.fontSize(14).fillColor('black').text('DOG-BONE INTERCHANGE', 0, 25, { align: 'center' });
    doc.fontSize(8).fillColor('#666').text('Two roundabouts connected by bridge overpass', 0, 60, { align: 'center' });

    // Draw both roundabouts
    drawRoundabout(doc, r1x, cy, rR, geo.legs || 4, ctx);
    drawRoundabout(doc, r2x, cy, rR, geo.legs || 4, ctx);

    // Bridge connecting segment (1.5× scaled)
    doc.lineWidth(3).strokeColor('black');
    doc.rect(r1x + rR, cy - 18, r2x - r1x - 2 * rR, 36).stroke();
    doc.lineWidth(1).strokeColor('#999');
    doc.moveTo(r1x + rR, cy).lineTo(r2x - rR, cy).dash(4, { space: 4 }).stroke();
    doc.undash();
    doc.fontSize(5).fillColor('#666').text('BRIDGE / OVERPASS', cx - 30, cy - 3, { lineBreak: false });

    // Labels
    doc.fontSize(7).fillColor('black');
    doc.text('ROUNDABOUT 1', r1x - 30, cy + rR + 15, { width: 60, align: 'center', lineBreak: false });
    doc.text('ROUNDABOUT 2', r2x - 30, cy + rR + 15, { width: 60, align: 'center', lineBreak: false });
    doc.fontSize(9).text(cs.name.toUpperCase(), cx - 60, cy - rR * 2 - 30, { width: 120, align: 'center', lineBreak: false });
    doc.text(ctx.roadName || 'MAIN ROAD', cx + 200, cy - 5, { lineBreak: false });

    // Notes
    const noteX = 50, noteY = 550;
    doc.lineWidth(0.5).rect(noteX, noteY, 1120, 130).stroke();
    doc.font('Helvetica-Bold').fontSize(10).fillColor('black').text('DOG-BONE INTERCHANGE TRAFFIC CONTROL NOTES:', noteX + 10, noteY + 6);
    doc.font('Helvetica').fontSize(9);
    const dbNotes = [
      '1. DOG-BONE INTERCHANGE requires INDEPENDENT traffic control at EACH roundabout.',
      '2. Decompose work zone: Approach legs, Roundabout 1, Bridge, Roundabout 2.',
      '3. Flaggers at each entry MUST coordinate — one direction released at a time.',
      '4. Bridge requires positive protection per MUTCD 6M.02 (temporary barriers).',
      '5. Use TA-52/53/54 for circulatory work, NOT standard linear TAs.',
      '6. Cover WRONG WAY / DO NOT ENTER signs that become inapplicable each phase.',
      '7. Multi-phase staging required — cannot close entire corridor without detour.',
      '8. Maintain pedestrian crossings or provide ADA-compliant alternate routes.',
    ];
    dbNotes.forEach((n, i) => doc.text(n, noteX + 10, noteY + 20 + i * 13, { width: 1100 }));

    drawWatermark(doc);
    drawTitleBlock(doc, sheetNum, totalSheets, ctx.operationType, ctx.roadName);
    return;
  }

  // Main road (horizontal)
  const intRoad = drawRoadway(doc, cx - mainLen / 2, cx + mainLen / 2, cy, ctx);
  const mainHW = intRoad.totalPixelH / 2;
  const crossHW = Math.round((geo.turnLanes ? 30 : 20) * 1.5); // 1.5× scale for visual weight
  const R = Math.round((isHighway(cs.name) ? 35 : 20) * 1.5); // Corner radius scaled

  // 1. MASKING: Erase the mainline edge lines where the cross streets enter
  doc.lineWidth(6).strokeColor('#ffffff'); // 6px to safely overlap 4px curb returns
  if (hasNorth) doc.moveTo(cx - crossHW - R, cy - mainHW).lineTo(cx + crossHW + R, cy - mainHW).stroke();
  if (hasSouth) doc.moveTo(cx - crossHW - R, cy + mainHW).lineTo(cx + crossHW + R, cy + mainHW).stroke();

  // MASKING: Erase the mainline centerlines inside the intersection box
  if (hasNorth || hasSouth) {
    doc.rect(cx - crossHW - 2, cy - mainHW + 2, (crossHW * 2) + 4, (mainHW * 2) - 4).fill('#ffffff');
  }

  // 2. DRAW CURB RETURNS & CROSS STREET EDGES (heavy CAD weight)
  doc.lineWidth(4).strokeColor('black');
  if (hasNorth) {
    // Left North curb
    doc.moveTo(cx - crossHW, cy - crossLen)
       .lineTo(cx - crossHW, cy - mainHW - R)
       .quadraticCurveTo(cx - crossHW, cy - mainHW, cx - crossHW - R, cy - mainHW).stroke();
    // Right North curb
    doc.moveTo(cx + crossHW, cy - crossLen)
       .lineTo(cx + crossHW, cy - mainHW - R)
       .quadraticCurveTo(cx + crossHW, cy - mainHW, cx + crossHW + R, cy - mainHW).stroke();
  }
  if (hasSouth) {
    // Left South curb
    doc.moveTo(cx - crossHW, cy + crossLen)
       .lineTo(cx - crossHW, cy + mainHW + R)
       .quadraticCurveTo(cx - crossHW, cy + mainHW, cx - crossHW - R, cy + mainHW).stroke();
    // Right South curb
    doc.moveTo(cx + crossHW, cy + crossLen)
       .lineTo(cx + crossHW, cy + mainHW + R)
       .quadraticCurveTo(cx + crossHW, cy + mainHW, cx + crossHW + R, cy + mainHW).stroke();
  }

  // 3. DRAW CROSS STREET CENTERLINES (scaled weight)
  doc.lineWidth(1.5).strokeColor('#CC9900');
  if (hasNorth) {
    doc.moveTo(cx - 1.5, cy - crossLen).lineTo(cx - 1.5, cy - mainHW).stroke();
    doc.moveTo(cx + 1.5, cy - crossLen).lineTo(cx + 1.5, cy - mainHW).stroke();
  }
  if (hasSouth) {
    doc.moveTo(cx - 1.5, cy + mainHW).lineTo(cx - 1.5, cy + crossLen).stroke();
    doc.moveTo(cx + 1.5, cy + mainHW).lineTo(cx + 1.5, cy + crossLen).stroke();
  }

  // 4. STOP BARS & CROSSWALKS
  if (geo.hasSignal || isHighway(cs.name)) {
    doc.lineWidth(5).strokeColor('black');
    if (hasNorth) doc.moveTo(cx - crossHW, cy - mainHW - R).lineTo(cx, cy - mainHW - R).stroke();
    if (hasSouth) doc.moveTo(cx, cy + mainHW + R).lineTo(cx + crossHW, cy + mainHW + R).stroke();

    doc.lineWidth(2).dash(6, { space: 6 }).strokeColor('#666');
    const cwOffset = R + 10;
    if (hasNorth) {
      doc.moveTo(cx - crossHW, cy - mainHW - cwOffset).lineTo(cx + crossHW, cy - mainHW - cwOffset).stroke();
      doc.moveTo(cx - crossHW, cy - mainHW - cwOffset - 10).lineTo(cx + crossHW, cy - mainHW - cwOffset - 10).stroke();
    }
    if (hasSouth) {
      doc.moveTo(cx - crossHW, cy + mainHW + cwOffset).lineTo(cx + crossHW, cy + mainHW + cwOffset).stroke();
      doc.moveTo(cx - crossHW, cy + mainHW + cwOffset + 10).lineTo(cx + crossHW, cy + mainHW + cwOffset + 10).stroke();
    }
    doc.undash();
  } else {
    doc.lineWidth(2).strokeColor('black');
    if (hasNorth) doc.moveTo(cx - crossHW, cy - mainHW - 5).lineTo(cx, cy - mainHW - 5).stroke();
    if (hasSouth) doc.moveTo(cx, cy + mainHW + 5).lineTo(cx + crossHW, cy + mainHW + 5).stroke();
  }

  // 5. TRAFFIC CONTROL SYMBOLS
  if (geo.hasSignal) {
    doc.lineWidth(1).strokeColor('black');
    const sigY = hasNorth ? cy - mainHW - R - 25 : cy + mainHW + 5;
    doc.rect(cx + crossHW + 8, sigY, 12, 22).fillAndStroke('#333', 'black');
    doc.circle(cx + crossHW + 14, sigY + 4, 3).fillAndStroke('#ff0000', '#333');
    doc.circle(cx + crossHW + 14, sigY + 11, 3).fillAndStroke('#ffcc00', '#333');
    doc.circle(cx + crossHW + 14, sigY + 18, 3).fillAndStroke('#00cc00', '#333');
    doc.fontSize(5).fillColor('#cc0000').text('SIGNAL', cx + crossHW + 22, sigY + 8, { lineBreak: false });
  } else if (geo.hasStopSign) {
    const drawStop = (x: number, y: number) => {
      doc.save().translate(x, y).rotate(22.5);
      doc.moveTo(7, 0);
      for (let i = 1; i <= 8; i++) doc.lineTo(7 * Math.cos(i * Math.PI / 4), 7 * Math.sin(i * Math.PI / 4));
      doc.fillAndStroke('#cc0000', '#660000');
      doc.restore();
      doc.fontSize(3).fillColor('white').text('STOP', x - 4.5, y - 1.5, { lineBreak: false });
    };
    if (hasNorth) drawStop(cx - crossHW - 12, cy - mainHW - R - 10);
    if (hasSouth) drawStop(cx + crossHW + 12, cy + mainHW + R + 10);
  }

  if (geo.turnLanes) {
    doc.fontSize(5).fillColor('#0066cc');
    if (hasNorth) doc.text('TURN LANE', cx + crossHW + 5, cy - mainHW - 20, { lineBreak: false });
    // Draw turn arrow
    doc.lineWidth(0.5).strokeColor('#0066cc');
    const ty = hasNorth ? cy - mainHW - 15 : cy + mainHW + 15;
    const dir = hasNorth ? 1 : -1;
    doc.moveTo(cx + crossHW + 3, ty).lineTo(cx + crossHW + 3, ty + 10 * dir).stroke();
    doc.moveTo(cx + crossHW + 3, ty + 10 * dir).lineTo(cx + crossHW, ty + 5 * dir).stroke();
    doc.moveTo(cx + crossHW + 3, ty + 10 * dir).lineTo(cx + crossHW + 6, ty + 5 * dir).stroke();
  }

  // Labels
  doc.fontSize(10).fillColor('black');
  doc.text(ctx.roadName || 'MAIN ROAD', cx + mainLen / 2 + 10, cy - 5, { lineBreak: false });
  doc.fontSize(9);
  if (hasNorth) {
    doc.text(cs.name.toUpperCase(), cx - 60, cy - crossLen - 15, { width: 120, align: 'center', lineBreak: false });
  } else {
    doc.text(cs.name.toUpperCase(), cx - 60, cy + crossLen + 5, { width: 120, align: 'center', lineBreak: false });
  }

  doc.fontSize(6).fillColor('#444');
  doc.text('>>> PRIMARY', cx - mainLen / 2, cy + mainHW + 8, { lineBreak: false });
  doc.text('OPPOSING <<<', cx + mainLen / 2 - 60, cy - mainHW - 14, { lineBreak: false });

  // 6. ADVANCE WARNING SIGNS — full series for flagger operations (spaced 75px apart)
  const isFlagOp = ['TA-10', 'TA-11'].includes(ctx.taCode);
  if (hasNorth) {
    drawSignDiamond(doc, cx - crossHW - 60, cy - crossLen + 20, 'W20-1', 'ROAD WORK\nAHEAD');
    if (isFlagOp) {
      drawSignDiamond(doc, cx - crossHW - 60, cy - crossLen + 95, 'W20-4', 'ONE LANE\nROAD AHEAD');
      drawSignDiamond(doc, cx - crossHW - 60, cy - crossLen + 170, 'W20-7a', 'FLAGGER\nAHEAD');
    }
  }
  if (hasSouth) {
    drawSignDiamond(doc, cx + crossHW + 60, cy + crossLen - 20, 'W20-1', 'ROAD WORK\nAHEAD');
    if (isFlagOp) {
      drawSignDiamond(doc, cx + crossHW + 60, cy + crossLen - 95, 'W20-4', 'ONE LANE\nROAD AHEAD');
      drawSignDiamond(doc, cx + crossHW + 60, cy + crossLen - 170, 'W20-7a', 'FLAGGER\nAHEAD');
    }
  }

  // Stop bars on mainline (always present at signalized intersections or highways)
  doc.lineWidth(4).strokeColor('black');
  doc.moveTo(cx - mainLen / 2 + 20, cy + mainHW - 2).lineTo(cx - crossHW - R - 5, cy + mainHW - 2).stroke();
  doc.moveTo(cx + crossHW + R + 5, cy - mainHW + 2).lineTo(cx + mainLen / 2 - 20, cy - mainHW + 2).stroke();

  // Determine intersection significance
  const isHwy = isHighway(cs.name);
  const isDriveway = /chevron|gas|station|driveway|parking|lot/i.test(cs.name) && !/state\s*park|national|public|forest|county/i.test(cs.name);
  const intType = isHwy ? 'STATE/US HIGHWAY INTERSECTION' : isDriveway ? 'COMMERCIAL ACCESS POINT' : 'LOCAL ROAD INTERSECTION';

  // Notes for this intersection — classification as subtitle
  const noteX = 50, noteY = 560;
  doc.lineWidth(0.5).rect(noteX, noteY, 530, 120).stroke();
  doc.font('Helvetica-Bold').fontSize(10).fillColor(isHwy ? '#cc0000' : 'black');
  doc.text(`${intType} — TRAFFIC CONTROL NOTES`, noteX + 10, noteY + 6);
  doc.font('Helvetica').fontSize(9).fillColor('black');

  const intNotes = isHwy ?[
    `1. THIS IS A STATE/US HIGHWAY INTERSECTION — requires enhanced traffic control measures.`,
    `2. Place W20-1 "ROAD WORK AHEAD" signs on ${cs.name} approaches at minimum ${getABCSpacing(ctx.speedMph, ctx.terrain, ctx.funcClass).a} ft from intersection.`,
    `3. CONSIDER ADDITIONAL FLAGGER at this intersection to manage cross-traffic from ${cs.name}.`,
    `4. Coordinate with ITD Traffic Operations if ${cs.name} carries significant traffic volume.`,
    `5. Sight distance at this intersection must accommodate ${ctx.speedMph} MPH mainline AND cross-street traffic.`,
    '6. Do not place channelizing devices where they block cross-street sight triangles.',
    '7. Consider advance warning signs on cross-street at greater distances due to higher approach speeds.',
  ] :[
    `1. Place W20-1 "ROAD WORK AHEAD" signs on ${cs.name} approaches at minimum ${getABCSpacing(ctx.speedMph, ctx.terrain, ctx.funcClass).a} ft from intersection.`,
    '2. Maintain access to and from cross-street at all times unless otherwise approved.',
    '3. If cross-street traffic volume is significant, consider an additional flagger at this intersection.',
    '4. Cross-street signing shall be covered or removed when work zone is not active.',
    `5. Sight distance at this intersection must accommodate ${ctx.speedMph} MPH mainline traffic.`,
    '6. Do not place channelizing devices where they block cross-street sight triangles.',
  ];
  intNotes.forEach((n, i) => doc.text(n, noteX + 10, noteY + 22 + i * 16, { width: 510 }));

  // Sign detail for this intersection
  doc.lineWidth(0.5).rect(600, noteY, 400, 120).stroke();
  doc.font('Helvetica-Bold').fontSize(10).text('SIGNS REQUIRED AT THIS INTERSECTION:', 610, noteY + 6);
  doc.font('Helvetica').fontSize(9);
  const signQty = (hasNorth ? 1 : 0) + (hasSouth ? 1 : 0);
  doc.text(`W20-1 "ROAD WORK AHEAD" — Qty: ${signQty} (one per cross-street approach)`, 610, noteY + 28, { width: 380 });
  const intSignSize = getSignSize(ctx.speedMph, ctx.roadName);
  doc.text(`Sign Size: ${intSignSize} diamond${isHighway(ctx.roadName) ? ' (ITD State/US Highway minimum)' : ''}`, 610, noteY + 44, { width: 380 });
  doc.text(`Mounting: Post-mounted, 7 ft minimum height to bottom of sign`, 610, noteY + 60, { width: 380 });
  if (isHwy) {
    doc.font('Helvetica-Bold').fillColor('#cc0000');
    doc.text(`ENHANCED: Consider W20-4 "ONE LANE ROAD AHEAD" on ${cs.name} approaches`, 610, noteY + 80, { width: 380 });
    doc.text(`ENHANCED: Additional flagger may be required per MUTCD 6H.01`, 610, noteY + 96, { width: 380 });
    doc.fillColor('black');
  }

  drawWatermark(doc);
  drawTitleBlock(doc, sheetNum, totalSheets, ctx.operationType, ctx.roadName);
}

// ===================================================================
// SHEET: TRAFFIC DATA & QUEUE ANALYSIS
// ===================================================================
function drawQueueAnalysisSheet(doc: Doc, sheetNum: number, totalSheets: number, ctx: DrawContext) {
  doc.addPage({ size: 'tabloid', layout: 'landscape', margin: 0 });

  doc.fontSize(14).fillColor('black').text('TRAFFIC DATA & QUEUE ANALYSIS', 0, 25, { align: 'center' });
  doc.fontSize(9).text(`${ctx.roadName || 'Project Road'} — ${ctx.operationType}`, 0, 45, { align: 'center' });

  const topH = 220, botH = 150; // Force identical row heights

  // Traffic Data Box
  const tdX = 50, tdY = 80;
  doc.lineWidth(1).rect(tdX, tdY, 520, topH).stroke();
  doc.font('Helvetica-Bold').fontSize(12).text('TRAFFIC DATA', tdX + 10, tdY + 10, { underline: true });
  doc.font('Helvetica').fontSize(9);

  const aadtStr = ctx.aadt > 0 ? ctx.aadt.toLocaleString() : 'Not available';
  const truckStr = ctx.truckPct > 0 ? `${ctx.truckPct.toFixed(1)}%` : 'Not available';
  const peakHourVol = ctx.aadt > 0 ? Math.round(ctx.aadt * 0.09) : 0; // K-factor ~9%
  const peakDirVol = peakHourVol > 0 ? Math.round(peakHourVol * 0.6) : 0; // D-factor ~60%
  const truckVol = ctx.aadt > 0 && ctx.truckPct > 0 ? Math.round(ctx.aadt * ctx.truckPct / 100) : 0;

  const tdRows: [string, string][] = [
    ['AADT (Annual Average Daily Traffic):', aadtStr],
    ['Truck Percentage:', truckStr],
    ['Estimated Daily Truck Volume:', truckVol > 0 ? truckVol.toLocaleString() : 'N/A'],
    ['Estimated Peak Hour Volume (K=0.09):', peakHourVol > 0 ? peakHourVol.toLocaleString() + ' vph' : 'N/A'],
    ['Estimated Peak Directional Volume (D=0.60):', peakDirVol > 0 ? peakDirVol.toLocaleString() + ' vph' : 'N/A'],
    ['Functional Classification:', ctx.funcClass || 'Not available'],
    ['Terrain:', ctx.terrain || 'Not available'],
    ['Number of Lanes:', ctx.totalLanes > 0 ? `${ctx.totalLanes}` : 'Not available'],
    ['Speed Limit:', `${ctx.speedMph} MPH`],
    ['Work Zone Speed:', `${ctx.wzSpeedMph} MPH`],
  ];
  let tdRow = tdY + 28;
  for (const [label, value] of tdRows) {
    doc.font('Helvetica-Bold').text(label, tdX + 10, tdRow, { continued: true, lineBreak: false });
    doc.font('Helvetica').text(` ${value}`, { lineBreak: false });
    tdRow += 16;
  }

  // Queue Length Analysis Box
  const qaX = 600, qaY = 80;
  doc.lineWidth(1).rect(qaX, qaY, 570, topH).stroke();
  doc.font('Helvetica-Bold').fontSize(12).fillColor('black').text('QUEUE LENGTH ESTIMATE', qaX + 10, qaY + 10, { underline: true });
  doc.font('Helvetica').fontSize(9);

  if (ctx.aadt > 0 && peakDirVol > 0) {
    // Simplified HCM queue analysis
    // Work zone capacity: ~1,400 pcphpl for flagging, ~1,600 for lane closure with merge
    const isFlagging = ctx.taCode === 'TA-10';
    const wzCapacity = isFlagging ? 1400 : 1600;
    const demandVol = peakDirVol;
    const vcRatio = demandVol / wzCapacity;
    // Average vehicle length = 25 ft (mix of cars and trucks)
    const avgVehLen = 25 + (ctx.truckPct > 0 ? ctx.truckPct * 0.3 : 5);

    let queueLenFt = 0;
    let delayPerVeh = 0;
    if (vcRatio >= 1.0) {
      // Oversaturated: queue grows at (demand - capacity) vehicles per hour
      const queueGrowthRate = demandVol - wzCapacity; // veh/hr
      const analysisHr = 1; // 1-hour peak
      queueLenFt = Math.round(queueGrowthRate * analysisHr * avgVehLen);
      delayPerVeh = Math.round((queueLenFt / avgVehLen) / wzCapacity * 3600); // seconds
    } else if (vcRatio > 0.7) {
      // Near-capacity: some delay
      delayPerVeh = Math.round(30 * (vcRatio - 0.7) / 0.3); // 0-30 sec range
      queueLenFt = Math.round(delayPerVeh * demandVol / 3600 * avgVehLen);
    }

    const qaRows: [string, string][] = [
      ['Analysis Method:', 'HCM Simplified Queue Estimation'],
      ['Work Zone Capacity:', `${wzCapacity.toLocaleString()} pcphpl (${isFlagging ? 'flagging operation' : 'lane closure/merge'})`],
      ['Peak Directional Demand:', `${demandVol.toLocaleString()} vph`],
      ['Volume/Capacity Ratio:', vcRatio.toFixed(2)],
      ['', ''],
      ['Estimated Queue Length:', queueLenFt > 0 ? `${queueLenFt.toLocaleString()} ft (${(queueLenFt / 5280).toFixed(2)} mi)` : 'Minimal (free-flow conditions)'],
      ['Estimated Delay Per Vehicle:', delayPerVeh > 0 ? `${delayPerVeh} seconds` : 'Minimal'],
      ['', ''],
    ];
    let qaRow = qaY + 28;
    for (const [label, value] of qaRows) {
      if (!label && !value) { qaRow += 6; continue; }
      doc.font('Helvetica-Bold').text(label, qaX + 10, qaRow, { continued: true, lineBreak: false });
      doc.font('Helvetica').text(` ${value}`, { lineBreak: false });
      qaRow += 16;
    }

    // Capacity assessment
    doc.font('Helvetica-Bold').fontSize(9);
    if (vcRatio >= 1.0) {
      doc.fillColor('#cc0000').text('WARNING: DEMAND EXCEEDS CAPACITY', qaX + 10, qaRow + 5, { lineBreak: false });
      doc.font('Helvetica').fontSize(7).fillColor('#cc0000');
      doc.text('Consider off-peak work hours, phased operations, or detour routes.', qaX + 10, qaRow + 20, { width: 550 });
      doc.text('Queue management plan required per MUTCD Section 6C.14.', qaX + 10, qaRow + 32, { width: 550 });
    } else if (vcRatio > 0.85) {
      doc.fillColor('#CC6600').text('CAUTION: NEAR-CAPACITY CONDITIONS', qaX + 10, qaRow + 5, { lineBreak: false });
      doc.font('Helvetica').fontSize(7).fillColor('#CC6600');
      doc.text('Monitor queue lengths during peak hours. Have contingency plan ready.', qaX + 10, qaRow + 20, { width: 550 });
    } else {
      doc.fillColor('#006B3F').text('ADEQUATE CAPACITY', qaX + 10, qaRow + 5, { lineBreak: false });
      doc.font('Helvetica').fontSize(7).fillColor('#006B3F');
      doc.text('Expected minimal delays under normal conditions.', qaX + 10, qaRow + 20, { width: 550 });
    }
    doc.fillColor('black');
  } else {
    doc.fontSize(9).fillColor('#666').text('AADT data not available — queue analysis cannot be performed.', qaX + 10, qaY + 35, { width: 550 });
    doc.text('Obtain traffic counts before construction to assess capacity impacts.', qaX + 10, qaY + 50, { width: 550 });
  }

  // Crash History Box
  const chX = 50, chY = 320;
  doc.lineWidth(1).rect(chX, chY, 520, botH).stroke();
  doc.font('Helvetica-Bold').fontSize(12).fillColor('black').text('CRASH HISTORY', chX + 10, chY + 10, { underline: true });
  doc.font('Helvetica').fontSize(9);
  if (ctx.crashCount > 0) {
    doc.text(`Crashes within project limits (ITD database): ${ctx.crashCount}`, chX + 10, chY + 30);
    if (ctx.crashCount >= 10) {
      doc.font('Helvetica-Bold').fillColor('#cc0000');
      doc.text('HIGH CRASH LOCATION — Enhanced traffic control measures recommended.', chX + 10, chY + 50);
      doc.font('Helvetica').fontSize(7).fillColor('black');
      doc.text('Consider additional advance warning signs, enhanced delineation, and law enforcement presence.', chX + 10, chY + 68, { width: 500 });
      doc.text('Speed feedback signs may be warranted per ITD policy.', chX + 10, chY + 80, { width: 500 });
    } else if (ctx.crashCount >= 5) {
      doc.fillColor('#CC6600');
      doc.text('Moderate crash history — exercise caution during setup and removal.', chX + 10, chY + 50);
      doc.fillColor('black');
    } else {
      doc.text('Low crash history at this location.', chX + 10, chY + 50);
    }
  } else {
    doc.text('No crash data available from ITD database for this location.', chX + 10, chY + 30);
  }

  // Bridge Data Box
  const brX = 600, brY = 320;
  doc.lineWidth(1).rect(brX, brY, 570, botH).stroke();
  doc.font('Helvetica-Bold').fontSize(12).fillColor('black').text('BRIDGE & STRUCTURE DATA', brX + 10, brY + 10, { underline: true });
  doc.font('Helvetica').fontSize(9);
  if (ctx.bridges && ctx.bridges.length > 0) {
    doc.text(`Bridges/structures within project limits: ${ctx.bridges.length}`, brX + 10, brY + 30);
    let brRow = brY + 48;
    ctx.bridges.slice(0, 4).forEach((br: any, i: number) => {
      const name = br.STRUCTURE_NAME || br.name || `Structure ${i + 1}`;
      const len = br.STRUCTURE_LENGTH || br.length || 'N/A';
      const width = br.DECK_WIDTH || br.width || 'N/A';
      doc.text(`${i + 1}. ${name} — Length: ${len} ft, Deck Width: ${width} ft`, brX + 10, brRow, { width: 550, lineBreak: false });
      brRow += 14;
    });
    doc.fontSize(7).fillColor('#cc0000');
    doc.text('NOTE: No work zone devices shall be placed on bridge decks without approval.', brX + 10, brRow + 5, { width: 550 });
    doc.fillColor('black');
  } else {
    doc.text('No bridges or structures identified within project limits.', brX + 10, brY + 30);
  }

  // Work Window Recommendations
  const wwX = 50, wwY = 490;
  doc.lineWidth(1).rect(wwX, wwY, 1120, 120).stroke();
  doc.font('Helvetica-Bold').fontSize(12).fillColor('black').text('RECOMMENDED WORK WINDOWS', wwX + 10, wwY + 10, { underline: true });
  doc.font('Helvetica').fontSize(9);
  if (ctx.aadt > 0) {
    const isHighVol = ctx.aadt > 5000;
    const isMedVol = ctx.aadt > 1500;
    const windows = isHighVol ? [
      'DAYTIME (Off-Peak): 9:00 AM — 3:00 PM weekdays (avoid AM/PM peak hours)',
      'NIGHTTIME: 8:00 PM — 6:00 AM (preferred for minimal traffic impact)',
      'WEEKEND: Saturday 6:00 AM — Sunday 6:00 PM (reduced volume)',
      `Peak hour volume (~${peakHourVol} vph) may cause significant delays — coordinate with ITD Traffic Operations.`,
    ] : isMedVol ? [
      'DAYTIME: 7:00 AM — 5:00 PM weekdays (moderate traffic expected)',
      'Extended hours acceptable with traffic management plan',
      'Monitor queue lengths during peak commute periods',
    ] : [
      'DAYTIME: Standard work hours acceptable (low traffic volume)',
      'No peak-hour restrictions anticipated',
      `Low AADT (${ctx.aadt}) — minimal traffic impact expected`,
    ];
    windows.forEach((w, i) => {
      doc.text(`• ${w}`, wwX + 10, wwY + 28 + i * 14, { width: 1100 });
    });
  } else {
    doc.text('• Obtain traffic counts to determine optimal work windows.', wwX + 10, wwY + 28);
    doc.text('• Default: Avoid AM peak (7-9 AM) and PM peak (4-6 PM) on arterial roads.', wwX + 10, wwY + 42);
  }

  // Disclaimer
  doc.fontSize(7).fillColor('#999');
  doc.text('Queue estimates are approximate and based on simplified HCM methodology. Actual conditions may vary. Field verification required.', 50, 620, { width: 1120, align: 'center' });

  drawWatermark(doc);
  drawTitleBlock(doc, sheetNum, totalSheets, ctx.operationType, ctx.roadName);
}

// ===================================================================
// SHEET: SPECIAL CONSIDERATIONS
// ===================================================================
function drawSpecialConsiderationsSheet(doc: Doc, sheetNum: number, totalSheets: number, ctx: DrawContext) {
  doc.addPage({ size: 'tabloid', layout: 'landscape', margin: 0 });

  doc.fontSize(14).fillColor('black').text('SPECIAL CONSIDERATIONS', 0, 25, { align: 'center' });
  doc.fontSize(9).text(`${ctx.roadName || 'Project Road'} — ${ctx.operationType}`, 0, 45, { align: 'center' });

  const col1X = 50, col2X = 610, colW = 530;
  let leftY = 80, rightY = 80;

  // Reusable box drawing function
  const drawConsBox = (x: number, y: number, title: string, notes: string[]) => {
    const titleH = 30;
    const notesH = notes.length * 18 + 15;
    const totalH = titleH + notesH;
    doc.lineWidth(1).rect(x, y, colW, totalH).stroke();
    doc.font('Helvetica-Bold').fontSize(12).fillColor('black').text(title, x + 15, y + 12, { underline: true });
    doc.font('Helvetica').fontSize(10);
    notes.forEach((n, i) => doc.text(n, x + 15, y + 35 + i * 18, { width: colW - 30 }));
    return y + totalH + 20;
  };

  // LEFT COLUMN
  leftY = drawConsBox(col1X, leftY, 'NIGHT OPERATIONS', [
    '• All advance warning signs shall be retroreflective or illuminated per MUTCD 6F.02.',
    '• Flagger stations shall be illuminated with min 5 foot-candles at ground level.',
    '• Channelizing devices shall have retroreflective sheeting visible from min 1,000 ft.',
    '• Arrow boards shall operate in flashing mode during nighttime operations.',
    `• ${ctx.speedMph >= 55 ? 'HIGH-SPEED ROAD: Consider additional flashing beacons on warning signs.' : 'Standard nighttime delineation requirements apply.'}`,
  ]);

  const isUrban = ctx.funcClass ? parseInt(ctx.funcClass) >= 5 : ctx.speedMph <= 35;
  leftY = drawConsBox(col1X, leftY, 'PEDESTRIAN & BICYCLE ACCOMMODATIONS', isUrban ? [
    '• Maintain ADA-compliant pedestrian access through or around the work zone.',
    '• Provide temporary pedestrian signs (R9-9, R9-11) if sidewalks are impacted.',
    '• Temporary pedestrian pathway shall be minimum 60 inches wide with detectable edges.',
    '• Curb ramps and level landings required at all pedestrian crossings per ADA.',
    '• If bicycle lane is impacted, provide SHARE THE ROAD signs and 4-ft min bicycle space.',
  ] : [
    '• Rural location — pedestrian traffic expected to be minimal.',
    '• If pedestrians or bicyclists observed, provide safe passage with flagger assistance.',
    '• No sidewalk closures anticipated.',
    `• ${ctx.speedMph >= 55 ? 'High-speed road — pedestrian/bicycle access not recommended.' : 'Maintain shoulder access for bicyclists where feasible.'}`,
  ]);

  // RIGHT COLUMN
  rightY = drawConsBox(col2X, rightY, 'EMERGENCY VEHICLE ACCESS', [
    '• Emergency vehicle access shall be maintained at all times per MUTCD 6C.01.',
    '• Channelizing devices shall be moveable to allow passage within 3 minutes.',
    '• Notify local fire, EMS, and law enforcement of schedule prior to start of work.',
    `• ${ctx.crossStreets.length > 0 ? `Maintain access to all ${ctx.crossStreets.length} intersecting roads for emergency vehicles.` : 'No cross-street access restrictions identified.'}`,
  ]);

  const terrainStr = ctx.terrain || 'unknown';
  rightY = drawConsBox(col2X, rightY, 'ENVIRONMENTAL & SEASONAL', [
    `• Terrain: ${terrainStr.charAt(0).toUpperCase() + terrainStr.slice(1)}${/rolling|mountainous/i.test(terrainStr) ? ' — reduced sight distance may require advance warning.' : '.'}`,
    '• Winter ops: Ensure all temporary signs and devices visible above snow.',
    '• Wet/icy conditions: Increase advance warning distances and reduce WZ speed.',
    '• Wildlife corridor: If wildlife crossing signs exist, maintain visibility.',
  ]);

  rightY = drawConsBox(col2X, rightY, 'UTILITY COORDINATION', [
    '• Contact Dig Line (811) minimum 2 business days before excavation.',
    '• Verify location of overhead utilities before positioning high-profile equipment.',
    '• Maintain clearance from utility poles — do not attach signs to infrastructure.',
  ]);

  drawWatermark(doc);
  drawTitleBlock(doc, sheetNum, totalSheets, ctx.operationType, ctx.roadName);
}

// ===================================================================
// SHEET: GEOMETRY PLAN (True Road Shape from GPS Polyline)
// ===================================================================
function drawGeometryPlanSheet(
  doc: Doc, sheetNum: number, totalSheets: number, ctx: DrawContext,
  alignment: ProjectAlignment, viewportIndex: number, viewportTotal: number,
  viewportStartSta: number, viewportEndSta: number,
  basemapRoads: OsmRoadway[] = [],
  itdSegments: ItdRoadSegment[] = [],
  isIndexSheet = false,
  allViewports: import('../engineering/GeospatialEngine.js').Viewport[] = [],
) {
  doc.addPage({ size: 'tabloid', layout: 'landscape', margin: 0 });

  const vpLabel = viewportTotal > 1 ? (isIndexSheet ? ' — INDEX' : ` — SHEET ${viewportIndex} OF ${viewportTotal}`) : '';
  doc.fontSize(12).fillColor('black').text(`GEOMETRY PLAN${vpLabel}`, 0, 20, { align: 'center' });
  if (isIndexSheet) {
    doc.fontSize(8).text(`${ctx.roadName || 'Project Road'} — FULL PROJECT OVERVIEW — SEE DETAIL SHEETS FOR ENLARGED VIEWS`, 0, 36, { align: 'center' });
  } else {
    doc.fontSize(8).text(`${ctx.roadName || 'Project Road'} — STA ${ProjectAlignment.formatStation(viewportStartSta)} to STA ${ProjectAlignment.formatStation(viewportEndSta)}`, 0, 36, { align: 'center' });
  }

  // Page drawing area
  const pageLeft = 60, pageRight = 1164, pageTop = 55, pageBot = 680;
  const pageCx = (pageLeft + pageRight) / 2;
  const pageCy = (pageTop + pageBot) / 2;
  const pageW = pageRight - pageLeft;

  // Calculate viewport transform
  const midSta = (viewportStartSta + viewportEndSta) / 2;
  const midPt = alignment.getCoordinatesAtStation(midSta);
  const coverageFt = viewportEndSta - viewportStartSta;
  // Zoom out to ensure BOTH start and end pins are visible with margin for signs
  const scaleFtPerPt = coverageFt * 1.6 / (pageW * 0.75);

  const rotation = -midPt.heading + 90;
  const rotRad = rotation * Math.PI / 180;
  const toPage = (ux: number, uy: number) => {
    const dx = ux - midPt.x;
    const dy = uy - midPt.y;
    const rx = dx * Math.cos(rotRad) - dy * Math.sin(rotRad);
    const ry = dx * Math.sin(rotRad) + dy * Math.cos(rotRad);
    return { px: pageCx + rx / scaleFtPerPt, py: pageCy - ry / scaleFtPerPt };
  };

  const drawUtmPolyline = (pts: { x: number; y: number }[]) => {
    if (pts.length < 2) return;
    const page = pts.map(p => toPage(p.x, p.y));
    doc.moveTo(page[0]!.px, page[0]!.py);
    for (let i = 1; i < page.length; i++) doc.lineTo(page[i]!.px, page[i]!.py);
    doc.stroke();
  };

  // === FIX 2: CLIPPING MASK (prevents PDFKit page-break on overflows) ===
  doc.save();
  doc.rect(pageLeft, pageTop, pageRight - pageLeft, pageBot - pageTop).clip();

  // === PREPARE ROAD GEOMETRIES ===
  const halfW = (ctx.totalLanes || 2) * ctx.laneWidthFt / 2;
  const leftEdge = alignment.getOffsetPolyline(-halfW);
  const rightEdge = alignment.getOffsetPolyline(halfW);
  const centerline = alignment.getUtmPoints();

  // Prevent miter spikes on tight roundabout geometry
  doc.lineJoin('round');
  doc.lineCap('round');

  // =========================================================
  // Z-INDEX LAYER 1: BASEMAP ROADS (drawn as actual roadways with edge lines)
  // =========================================================
  // Pavement fill first (light grey)
  doc.strokeColor('#e8e8e8');
  for (const seg of itdSegments) {
    if (seg.nodes.length < 2) continue;
    doc.lineWidth(5);
    drawUtmPolyline(seg.nodes.map(n => alignment.projectGps(n)));
  }
  for (const road of basemapRoads) {
    if (road.nodes.length < 2) continue;
    const h = ((road as any).highway || '').toLowerCase();
    doc.lineWidth(/motorway|trunk|primary|secondary/.test(h) ? 4 : 2.5);
    drawUtmPolyline(road.nodes.map(n => alignment.projectGps(n)));
  }
  // Edge lines (darker, thinner — on top of pavement)
  doc.strokeColor('#BBBBBB');
  for (const seg of itdSegments) {
    if (seg.nodes.length < 2) continue;
    doc.lineWidth(0.5);
    drawUtmPolyline(seg.nodes.map(n => alignment.projectGps(n)));
  }
  for (const road of basemapRoads) {
    if (road.nodes.length < 2) continue;
    doc.lineWidth(0.3);
    drawUtmPolyline(road.nodes.map(n => alignment.projectGps(n)));
  }

  // Primary road pavement fill
  if (rightEdge.length > 1 && leftEdge.length > 1) {
    const rPage = rightEdge.map(p => toPage(p.x, p.y));
    const lPage = leftEdge.map(p => toPage(p.x, p.y));
    doc.save();
    doc.moveTo(rPage[0]!.px, rPage[0]!.py);
    rPage.forEach(p => doc.lineTo(p.px, p.py));
    [...lPage].reverse().forEach(p => doc.lineTo(p.px, p.py));
    doc.closePath().fill('#f5f5f5');
    doc.restore();
  }

  // =========================================================
  // Z-INDEX LAYER 3: PRIMARY EDGES + CENTERLINE (drawn LAST — always visible)
  // =========================================================
  doc.lineWidth(PLOT.PRIMARY_EDGE.lineWidth).strokeColor(PLOT.PRIMARY_EDGE.color);
  drawUtmPolyline(leftEdge);
  drawUtmPolyline(rightEdge);

  doc.lineWidth(PLOT.PRIMARY_CENTER.lineWidth).strokeColor(PLOT.PRIMARY_CENTER.color);
  doc.dash(PLOT.PRIMARY_CENTER.dash![0]!, { space: PLOT.PRIMARY_CENTER.dash![1] });
  drawUtmPolyline(centerline);
  doc.undash();

  // Restore CAD line join/cap
  doc.lineJoin('miter');
  doc.lineCap('butt');

  // =========================================================
  // FIX E: DRAW CROSS-STREETS ON GEOMETRY PLAN
  // Short perpendicular road stubs at each intersection
  // =========================================================
  for (const cs of ctx.crossStreets) {
    const sta = cs.position * alignment.totalLengthFt;
    if (sta < viewportStartSta - 50 || sta > viewportEndSta + 50) continue;
    const pt = alignment.getCoordinatesAtStation(sta);
    const pg = toPage(pt.x, pt.y);
    if (pg.px < pageLeft - 10 || pg.px > pageRight + 10) continue;

    // Determine cross-street direction from geometry type (case-insensitive)
    const geo = cs.geometry;
    const csGeoType = (geo?.type || '4-way').toLowerCase();
    const perpRad = (pt.heading + 90) * Math.PI / 180;

    // Cross-street road stub length (in real-world feet, scaled to page)
    const stubLenFt = Math.max(150, halfW * 4);
    const stubWidthFt = 24; // Typical 2-lane cross-street width

    // Draw cross-street on both sides unless T-intersection
    const drawNorth = csGeoType === '4-way' || csGeoType === 't-north' || csGeoType === 't-east' || csGeoType === 'y' || !csGeoType.startsWith('t-');
    const drawSouth = csGeoType === '4-way' || csGeoType === 't-south' || csGeoType === 't-west' || csGeoType === 'y' || !csGeoType.startsWith('t-');

    // Cross-street edge lines (thicker for visual weight)
    doc.lineWidth(1.2).strokeColor('#888888');
    const crossHalfW = stubWidthFt / 2;

    if (drawNorth) {
      // North/East leg — perpendicular from main road edge outward
      const startR = halfW; // Flush with road edge — no gap
      const endR = halfW + stubLenFt;
      // Left edge of cross-street
      const s1 = toPage(pt.x + startR * Math.sin(perpRad) - crossHalfW * Math.cos(perpRad),
                         pt.y + startR * Math.cos(perpRad) + crossHalfW * Math.sin(perpRad));
      const e1 = toPage(pt.x + endR * Math.sin(perpRad) - crossHalfW * Math.cos(perpRad),
                         pt.y + endR * Math.cos(perpRad) + crossHalfW * Math.sin(perpRad));
      // Right edge
      const s2 = toPage(pt.x + startR * Math.sin(perpRad) + crossHalfW * Math.cos(perpRad),
                         pt.y + startR * Math.cos(perpRad) - crossHalfW * Math.sin(perpRad));
      const e2 = toPage(pt.x + endR * Math.sin(perpRad) + crossHalfW * Math.cos(perpRad),
                         pt.y + endR * Math.cos(perpRad) - crossHalfW * Math.sin(perpRad));
      doc.moveTo(s1.px, s1.py).lineTo(e1.px, e1.py).stroke();
      doc.moveTo(s2.px, s2.py).lineTo(e2.px, e2.py).stroke();
      // Centerline (dashed)
      doc.lineWidth(0.4).strokeColor('#CC9900').dash(3, { space: 3 });
      const sc = toPage(pt.x + startR * Math.sin(perpRad), pt.y + startR * Math.cos(perpRad));
      const ec = toPage(pt.x + endR * Math.sin(perpRad), pt.y + endR * Math.cos(perpRad));
      doc.moveTo(sc.px, sc.py).lineTo(ec.px, ec.py).stroke();
      doc.undash();
    }

    if (drawSouth) {
      // South/West leg — opposite direction
      const startR = halfW; // Flush — no gap
      const endR = halfW + stubLenFt;
      const s1 = toPage(pt.x - startR * Math.sin(perpRad) - crossHalfW * Math.cos(perpRad),
                         pt.y - startR * Math.cos(perpRad) + crossHalfW * Math.sin(perpRad));
      const e1 = toPage(pt.x - endR * Math.sin(perpRad) - crossHalfW * Math.cos(perpRad),
                         pt.y - endR * Math.cos(perpRad) + crossHalfW * Math.sin(perpRad));
      const s2 = toPage(pt.x - startR * Math.sin(perpRad) + crossHalfW * Math.cos(perpRad),
                         pt.y - startR * Math.cos(perpRad) - crossHalfW * Math.sin(perpRad));
      const e2 = toPage(pt.x - endR * Math.sin(perpRad) + crossHalfW * Math.cos(perpRad),
                         pt.y - endR * Math.cos(perpRad) - crossHalfW * Math.sin(perpRad));
      doc.lineWidth(0.8).strokeColor('#888888');
      doc.moveTo(s1.px, s1.py).lineTo(e1.px, e1.py).stroke();
      doc.moveTo(s2.px, s2.py).lineTo(e2.px, e2.py).stroke();
      doc.lineWidth(0.4).strokeColor('#CC9900').dash(3, { space: 3 });
      const sc = toPage(pt.x - startR * Math.sin(perpRad), pt.y - startR * Math.cos(perpRad));
      const ec = toPage(pt.x - endR * Math.sin(perpRad), pt.y - endR * Math.cos(perpRad));
      doc.moveTo(sc.px, sc.py).lineTo(ec.px, ec.py).stroke();
      doc.undash();
    }
  }

  // =========================================================
  // PLOT TCP DEVICES (signs, work zone, flaggers)
  // =========================================================

  // ---------------------------------------------------------
  // WORK ZONE: Contrasting shading with distinct boundary
  // The physical space where construction/maintenance occurs.
  // Sits inside the closed lane(s), starting AFTER the upstream
  // buffer space and ending BEFORE the downstream buffer/taper.
  // ---------------------------------------------------------
  const bufferFt = getBufferSpaceFt(ctx.speedMph);
  const wzStartSta = ctx.taperLengthFt + bufferFt;
  const wzEndSta = alignment.totalLengthFt - ctx.blueprint.downstream_taper.length_ft - bufferFt;
  if (wzEndSta > wzStartSta) {
    const wzPoly = alignment.getWorkZonePolygon(wzStartSta, wzEndSta, -halfW, 0);
    if (wzPoly.length > 2) {
      const wzPage = wzPoly.map(p => toPage(p.x, p.y));

      // Contrasting orange fill (clearly distinct from grey road)
      doc.save();
      doc.moveTo(wzPage[0]!.px, wzPage[0]!.py);
      wzPage.forEach(p => doc.lineTo(p.px, p.py));
      doc.closePath();
      doc.fillOpacity(0.25).fill('#FF6600');
      doc.restore();

      // Bold boundary outline around work zone
      doc.save();
      doc.lineWidth(1.5).strokeColor('#cc0000');
      doc.moveTo(wzPage[0]!.px, wzPage[0]!.py);
      wzPage.forEach(p => doc.lineTo(p.px, p.py));
      doc.closePath().stroke();
      doc.restore();

      // "WORK AREA" label — only on detail sheets, not index
      if (isIndexSheet) {
        // Skip the rotated label on index — add legend instead
      } else {
      const visWzStart = Math.max(wzStartSta, viewportStartSta);
      const visWzEnd = Math.min(wzEndSta, viewportEndSta);
      const wzMidSta = (visWzStart + visWzEnd) / 2;
      const wzMidPt = alignment.getCoordinatesAtStation(wzMidSta);
      const wzMidPg = toPage(wzMidPt.x, wzMidPt.y);
      doc.save();
      doc.translate(wzMidPg.px, wzMidPg.py);
      doc.rotate(-(wzMidPt.heading - 90)); // Rotate to follow road
      doc.rect(-28, -5, 56, 10).fill('white');
      doc.font('Helvetica-Bold').fontSize(6).fillColor('#cc0000');
      doc.text('WORK AREA', -26, -3, { width: 52, align: 'center', lineBreak: false });
      doc.font('Helvetica');
      doc.restore();
    }
    } // end else (detail sheet only — no WORK AREA label on index)
  }

  // === TCP DEVICES — only on detail sheets, NOT the index overview ===
  if (!isIndexSheet) {
  // Signs placed AT-SCALE at their exact station on the road shoulder
  // No leader lines — signs dropped where they belong

  // Primary approach signs (right shoulder)
  const visiblePrimary = ctx.blueprint.primary_approach
    .map(sign => ({ ...sign, sta: Math.max(0, ctx.taperLengthFt - sign.distance_ft) }))
    .filter(s => s.sta >= viewportStartSta && s.sta <= viewportEndSta)
    .sort((a, b) => a.sta - b.sta);
  for (const sign of visiblePrimary) {
    const pt = alignment.getCoordinatesAtStation(sign.sta);
    // Place on right shoulder — offset perpendicular from road edge
    const perpRad = (pt.heading + 90) * Math.PI / 180;
    const signOffsetFt = halfW + 15; // 15 ft beyond road edge
    const sx = pt.x + signOffsetFt * Math.sin(perpRad);
    const sy = pt.y + signOffsetFt * Math.cos(perpRad);
    const pg = toPage(sx, sy);
    // Draw sign diamond at-scale (small, proportional to map)
    const signSizePx = Math.max(10, 18 / scaleFtPerPt);
    doc.save().translate(pg.px, pg.py).rotate(45);
    doc.rect(-signSizePx / 2, -signSizePx / 2, signSizePx, signSizePx).fillAndStroke('#FF8C00', '#000');
    doc.restore();
    // Sign code label — rotated to follow road WITH WHITE MASK
    doc.save();
    doc.translate(pg.px, pg.py);
    doc.rotate(-(pt.heading - 90));
    doc.rect(-18, signSizePx / 2 + 1, 36, 9).fill('white');
    doc.fontSize(6).fillColor('black');
    doc.text(sign.sign_code, -16, signSizePx / 2 + 2, { width: 32, align: 'center', lineBreak: false });
    doc.restore();
  }

  // Opposing approach signs (left shoulder)
  const visibleOpposing = ctx.blueprint.opposing_approach
    .map(sign => ({ ...sign, sta: Math.min(alignment.totalLengthFt, alignment.totalLengthFt - ctx.blueprint.downstream_taper.length_ft + sign.distance_ft) }))
    .filter(s => s.sta >= viewportStartSta && s.sta <= viewportEndSta)
    .sort((a, b) => a.sta - b.sta);
  for (const sign of visibleOpposing) {
    const pt = alignment.getCoordinatesAtStation(sign.sta);
    const perpRad = (pt.heading - 90) * Math.PI / 180;
    const signOffsetFt = halfW + 15;
    const sx = pt.x + signOffsetFt * Math.sin(perpRad);
    const sy = pt.y + signOffsetFt * Math.cos(perpRad);
    const pg = toPage(sx, sy);
    const signSizePx = Math.max(10, 18 / scaleFtPerPt);
    doc.save().translate(pg.px, pg.py).rotate(45);
    doc.rect(-signSizePx / 2, -signSizePx / 2, signSizePx, signSizePx).fillAndStroke('#FF8C00', '#000');
    doc.restore();
    doc.save();
    doc.translate(pg.px, pg.py);
    doc.rotate(-(pt.heading - 90));
    doc.rect(-18, signSizePx / 2 + 1, 36, 9).fill('white');
    doc.fontSize(6).fillColor('black');
    doc.text(sign.sign_code, -16, signSizePx / 2 + 2, { width: 32, align: 'center', lineBreak: false });
    doc.restore();
  }

  // Flagger positions (TA-10) — only draw if station falls within this viewport
  if (['TA-10', 'TA-11'].includes(ctx.taCode)) {
    const fSta1 = ctx.taperLengthFt;
    if (fSta1 >= viewportStartSta && fSta1 <= viewportEndSta) {
      const fPt1 = alignment.getCoordinatesAtStation(fSta1);
      const fPerp1 = (fPt1.heading + 90) * Math.PI / 180;
      const f1x = fPt1.x + (halfW + 8) * Math.sin(fPerp1);
      const f1y = fPt1.y + (halfW + 8) * Math.cos(fPerp1);
      const fg1 = toPage(f1x, f1y);
      doc.lineWidth(PLOT.TTC_DEVICE.lineWidth).strokeColor('#cc0000');
      doc.circle(fg1.px, fg1.py, 3).fillAndStroke('#cc0000', '#660000');
      doc.lineWidth(0.4).strokeColor('#333');
      doc.moveTo(fg1.px, fg1.py).lineTo(fg1.px + 30, fg1.py - 12).stroke();
      doc.fontSize(7).fillColor('#cc0000').text('FLAGGER', fg1.px + 15, fg1.py - 20, { lineBreak: false });
    }

    const dnSta = alignment.totalLengthFt - ctx.blueprint.downstream_taper.length_ft;
    if (dnSta >= viewportStartSta && dnSta <= viewportEndSta) {
      const fPt2 = alignment.getCoordinatesAtStation(dnSta);
      const fPerp2 = (fPt2.heading - 90) * Math.PI / 180;
      const f2x = fPt2.x + (halfW + 8) * Math.sin(fPerp2);
      const f2y = fPt2.y + (halfW + 8) * Math.cos(fPerp2);
      const fg2 = toPage(f2x, f2y);
      doc.lineWidth(PLOT.TTC_DEVICE.lineWidth).strokeColor('#cc0000');
      doc.circle(fg2.px, fg2.py, 3).fillAndStroke('#cc0000', '#660000');
      doc.lineWidth(0.4).strokeColor('#333');
      doc.moveTo(fg2.px, fg2.py).lineTo(fg2.px - 30, fg2.py - 12).stroke();
      doc.fontSize(7).fillColor('#cc0000').text('FLAGGER', fg2.px - 45, fg2.py - 20, { lineBreak: false });
    }
  }

  } // end if (!isIndexSheet) — TCP devices/signs/flaggers

  // === END CLIPPING ===
  doc.restore();

  // === INDEX SHEET: Draw numbered grid overlay ===
  if (isIndexSheet && allViewports.length > 1) {
    doc.lineWidth(0.6).strokeColor('#0066cc');
    for (const vp of allViewports) {
      if (vp.isIndexSheet || !vp.tileMinX) continue;
      // Only label tiles that have enough road coverage to generate a sheet
      if ((vp.endStation - vp.startStation) < 500) continue;
      // Draw tile rectangle
      const tlPg = toPage(vp.tileMinX, vp.tileMaxY!); // top-left
      const brPg = toPage(vp.tileMaxX!, vp.tileMinY!); // bottom-right
      const tw = brPg.px - tlPg.px;
      const th = brPg.py - tlPg.py;
      doc.rect(tlPg.px, tlPg.py, tw, th).stroke();
      // Sheet number label — at TOP of tile box (not blocking the road)
      const cx = tlPg.px + tw / 2;
      const labelY = tlPg.py - 2;
      doc.rect(cx - 30, labelY - 14, 60, 16).fill('white');
      doc.lineWidth(0.5).rect(cx - 30, labelY - 14, 60, 16).stroke();
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#0066cc');
      doc.text(`PAGE ${vp.sheetNumber}`, cx - 28, labelY - 11, { width: 56, align: 'center', lineBreak: false });
      doc.font('Helvetica');
    }
    // Legend
    doc.fontSize(8).fillColor('#0066cc');
    doc.text('GRID TILES — SEE NUMBERED SHEETS FOR DETAIL', pageLeft, pageBot - 8, { width: pageRight - pageLeft, align: 'center', lineBreak: false });
    // Work area legend for index sheet
    doc.save();
    doc.fillOpacity(0.25).rect(pageLeft + 10, pageBot - 25, 14, 10).fill('#FF6600');
    doc.restore();
    doc.fontSize(7).fillColor('#333').text('= WORK AREA', pageLeft + 28, pageBot - 23, { lineBreak: false });
  }

  // Helper: draw text with white bounding box mask (used by both index and detail sheets)
  const drawMaskedText = (text: string, x: number, y: number, w: number, fontSize: number, color: string, bold = false) => {
    const h = fontSize + 2;
    doc.rect(x, y - 1, w, h).fill('white');
    if (bold) doc.font('Helvetica-Bold');
    doc.fontSize(fontSize).fillColor(color);
    doc.text(text, x, y, { width: w, align: 'center', lineBreak: false });
    if (bold) doc.font('Helvetica');
  };

  // Station ticks, road labels, cross-street labels — detail sheets only
  if (!isIndexSheet) {
  // Station tick marks (Professional CAD — perpendicular to tangent, STATION_TICK style)
  doc.lineWidth(PLOT.STATION_TICK.lineWidth).strokeColor(PLOT.STATION_TICK.color);
  for (let sta = Math.ceil(viewportStartSta / 100) * 100; sta <= viewportEndSta; sta += 100) {
    const pt = alignment.getCoordinatesAtStation(sta);
    const pg = toPage(pt.x, pt.y);
    if (pg.px < pageLeft - 10 || pg.px > pageRight + 10) continue;
    const perpRad = (pt.heading + 90) * Math.PI / 180;
    const isMajor = sta % 500 === 0;
    const tickScaledFt = isMajor ? 15 : 8; // Physical feet
    const tx = Math.sin(perpRad) / scaleFtPerPt * tickScaledFt;
    const ty = -Math.cos(perpRad) / scaleFtPerPt * tickScaledFt;
    doc.moveTo(pg.px - tx, pg.py - ty).lineTo(pg.px + tx, pg.py + ty).stroke();
    if (isMajor) {
      // Station label offset from centerline, rotated to match bearing
      doc.save();
      doc.translate(pg.px + tx * 1.5, pg.py + ty * 1.5);
      doc.rotate(-(pt.heading - 90)); // Rotate text to follow road
      doc.fontSize(4.5).fillColor('#555');
      doc.text(ProjectAlignment.formatStation(sta), -18, -3, { width: 36, align: 'center', lineBreak: false });
      doc.restore();
    }
  }

  // === ROAD LABELS + INTERSECTION SIGNS (CAD-standard collision avoidance) ===

  // Main road label — offset to bottom-left quarter of alignment (away from intersections)
  const mainLabelSta = viewportStartSta + (viewportEndSta - viewportStartSta) * 0.15;
  const mainLabelPt = alignment.getCoordinatesAtStation(mainLabelSta);
  const mainPerpRad = (mainLabelPt.heading + 90) * Math.PI / 180;
  const mainLx = toPage(mainLabelPt.x, mainLabelPt.y).px + Math.sin(mainPerpRad) / scaleFtPerPt * (halfW + 80);
  const mainLy = toPage(mainLabelPt.x, mainLabelPt.y).py - Math.cos(mainPerpRad) / scaleFtPerPt * (halfW + 80);
  const mainRoadText = (ctx.roadName || 'MAIN ROAD').toUpperCase();
  drawMaskedText(mainRoadText, mainLx - 50, mainLy - 4, 100, 7, '#333', true);
  // Leader from road edge to label
  const mainEdgePg = toPage(mainLabelPt.x, mainLabelPt.y);
  doc.lineWidth(0.4).strokeColor('#999');
  doc.moveTo(mainEdgePg.px + Math.sin(mainPerpRad) / scaleFtPerPt * halfW,
             mainEdgePg.py - Math.cos(mainPerpRad) / scaleFtPerPt * halfW)
     .lineTo(mainLx, mainLy).stroke();

  // =========================================================
  // CROSS-STREET LABELS WITH 2D COLLISION AVOIDANCE
  // =========================================================
  const csLeaderOffset = 80;
  const placedLabels: { px: number; py: number }[] = [];

  for (let csIdx = 0; csIdx < ctx.crossStreets.length; csIdx++) {
    const cs = ctx.crossStreets[csIdx]!;
    const sta = cs.position * alignment.totalLengthFt;
    if (sta < viewportStartSta - 50 || sta > viewportEndSta + 50) continue;
    const pt = alignment.getCoordinatesAtStation(sta);
    const pg = toPage(pt.x, pt.y);
    if (pg.px < pageLeft - 10 || pg.px > pageRight + 10) continue;

    const side = csIdx % 2 === 0 ? 1 : -1;
    const lx = pg.px + side * csLeaderOffset;
    let ly = pg.py - side * 20;

    // 2D Collision Resolution — push labels apart until no overlap
    for (let attempts = 0; attempts < 6; attempts++) {
      let collided = false;
      for (const p of placedLabels) {
        if (Math.abs(lx - p.px) < 90 && Math.abs(ly - p.py) < 40) {
          ly = p.py + (side === 1 ? -40 : 40);
          collided = true;
          break;
        }
      }
      if (!collided) break;
    }
    // Bounds check — keep labels on the page
    ly = Math.max(pageTop + 20, Math.min(pageBot - 20, ly));
    placedLabels.push({ px: lx, py: ly });

    // Thick leader line from intersection point to callout box
    doc.lineWidth(1.2).strokeColor('#000');
    doc.moveTo(pg.px, pg.py).lineTo(lx, ly).stroke();
    doc.circle(pg.px, pg.py, 2).fillAndStroke('#000', '#000');

    // Unified white callout box (name + sign diamond + code) — enlarged for readability
    const boxW = 100, boxH = 46;
    const boxLeft = lx - boxW / 2;
    const boxTop = ly - boxH / 2;
    doc.lineWidth(0.8).rect(boxLeft, boxTop, boxW, boxH).fillAndStroke('white', 'black');

    // Street name
    const nameText = cs.name.length > 18 ? cs.name.substring(0, 16).toUpperCase() + '...' : cs.name.toUpperCase();
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#0066cc');
    doc.text(nameText, boxLeft + 2, boxTop + 4, { width: boxW - 4, align: 'center', lineBreak: false });

    // Sign diamond + code inside the box
    const isRoundabout = cs.geometry?.type === 'roundabout';
    const signCode = isRoundabout ? 'W2-6' : 'W20-1';
    doc.save().translate(lx - (isRoundabout ? 15 : 0), boxTop + 22).rotate(45);
    doc.rect(-7, -7, 14, 14).fillAndStroke('#FF8C00', 'black');
    doc.restore();
    doc.font('Helvetica-Bold').fontSize(7).fillColor('black');
    doc.text(signCode, boxLeft + 2, boxTop + 34, { width: boxW - 4, align: 'center', lineBreak: false });

    if (isRoundabout) {
      doc.save().translate(lx + 10, boxTop + 18);
      doc.moveTo(0, -5).lineTo(5, 4).lineTo(-5, 4).closePath().fillAndStroke('#ffffff', '#cc0000');
      doc.restore();
      doc.fontSize(4).fillColor('#cc0000');
      doc.text('R1-2', lx + 6, boxTop + 25, { width: 20, lineBreak: false });
    }
    doc.font('Helvetica');
  }

  } // end if (!isIndexSheet) — station ticks, labels, cross-street callouts

  // Start/End pin markers — only on index sheet, or detail sheets at the actual start/end of the route
  if (isIndexSheet) {
    // Index: always show both pins
    if (ctx.startCoords) {
      const sp = alignment.projectGps(ctx.startCoords);
      const spg = toPage(sp.x, sp.y);
      doc.circle(spg.px, spg.py, 7).fillAndStroke('#22c55e', '#166534');
      drawMaskedText('START', spg.px - 20, spg.py - 18, 40, 7, '#166534', true);
    }
    if (ctx.endCoords) {
      const ep = alignment.projectGps(ctx.endCoords);
      const epg = toPage(ep.x, ep.y);
      doc.circle(epg.px, epg.py, 7).fillAndStroke('#ef4444', '#991b1b');
      drawMaskedText('END', epg.px - 15, epg.py - 18, 30, 7, '#991b1b', true);
    }
  } else {
    // Detail sheets: only show START on sheet containing station 0, END on sheet containing last station
    if (viewportStartSta <= 50) {
      const sp = alignment.getCoordinatesAtStation(0);
      const spg = toPage(sp.x, sp.y);
      doc.circle(spg.px, spg.py, 7).fillAndStroke('#22c55e', '#166534');
      drawMaskedText('START', spg.px - 20, spg.py - 18, 40, 7, '#166534', true);
    }
    if (viewportEndSta >= alignment.totalLengthFt - 50) {
      const ep = alignment.getCoordinatesAtStation(alignment.totalLengthFt);
      const epg = toPage(ep.x, ep.y);
      doc.circle(epg.px, epg.py, 7).fillAndStroke('#ef4444', '#991b1b');
      drawMaskedText('END', epg.px - 15, epg.py - 18, 30, 7, '#991b1b', true);
    }
  }

  // Scale bar
  const sbX = pageLeft + 20, sbY = pageBot + 8;
  const scaleBarFt = Math.round(coverageFt / 8 / 50) * 50 || 100;
  const scaleBarPx = scaleBarFt / scaleFtPerPt;
  doc.lineWidth(1).strokeColor('black');
  doc.moveTo(sbX, sbY).lineTo(sbX + scaleBarPx, sbY).stroke();
  doc.moveTo(sbX, sbY - 3).lineTo(sbX, sbY + 3).stroke();
  doc.moveTo(sbX + scaleBarPx, sbY - 3).lineTo(sbX + scaleBarPx, sbY + 3).stroke();
  doc.fontSize(5).fillColor('black');
  doc.text('0', sbX - 3, sbY + 5, { lineBreak: false });
  doc.text(`${scaleBarFt} FT`, sbX + scaleBarPx - 10, sbY + 5, { lineBreak: false });
  doc.fontSize(4).fillColor('#999');
  doc.text(`UTM Zone ${alignment.utmZoneNumber}N | NAD83 | US Survey Feet`, sbX + scaleBarPx + 15, sbY + 1, { lineBreak: false });

  // North arrow
  const naX = pageRight - 30, naY = pageTop + 20;
  doc.save();
  doc.translate(naX, naY).rotate(-rotation);
  doc.lineWidth(1.5).strokeColor('black');
  doc.moveTo(0, 12).lineTo(0, -12).stroke();
  doc.moveTo(0, -12).lineTo(-4, -5).lineTo(4, -5).closePath().fill('black');
  doc.restore();
  doc.font('Helvetica-Bold').fontSize(7).fillColor('black');
  doc.text('N', naX - 3, naY - 22, { lineBreak: false });
  doc.font('Helvetica');

  // Disclaimer
  doc.fontSize(4).fillColor('#aaa');
  doc.text('SCHEMATIC LEVEL ACCURACY (~5m). NOT FOR SURVEY-GRADE STAKING.', pageLeft, pageBot + 18, { width: pageW, align: 'center', lineBreak: false });

  drawWatermark(doc);
  drawTitleBlock(doc, sheetNum, totalSheets, ctx.operationType, ctx.roadName);
}

// ===================================================================
// SHEET: SIGN SCHEDULE
// ===================================================================
function drawSignScheduleSheet(doc: Doc, sheetNum: number, totalSheets: number, ctx: DrawContext) {
  doc.addPage({ size: 'tabloid', layout: 'landscape', margin: 0 });

  doc.fontSize(14).fillColor('black').text("SIGN SCHEDULE & QUANTITIES", 0, 25, { align: 'center' });

  // Build sign inventory
  const signList: { code: string; description: string; size: string; qty: number; location: string }[] = [];

  // Primary approach signs
  for (const sign of ctx.blueprint.primary_approach) {
    signList.push({ code: sign.sign_code, description: sign.label, size: getSignSize(ctx.speedMph, ctx.roadName), qty: 1, location: `Primary approach, ${sign.distance_ft} ft from work area` });
  }
  // Opposing approach signs
  for (const sign of ctx.blueprint.opposing_approach) {
    signList.push({ code: sign.sign_code, description: sign.label, size: getSignSize(ctx.speedMph, ctx.roadName), qty: 1, location: `Opposing approach, ${sign.distance_ft} ft from work area` });
  }
  // Speed reduction signs
  if (ctx.speedMph !== ctx.wzSpeedMph) {
    signList.push({ code: 'W3-5', description: `REDUCED SPEED ${ctx.wzSpeedMph} MPH AHEAD`, size: getSignSize(ctx.speedMph, ctx.roadName), qty: 2, location: 'Both approaches, before transition area' });
    signList.push({ code: 'R2-1', description: `SPEED LIMIT ${ctx.wzSpeedMph}`, size: '24" x 30"', qty: 2, location: 'Both approaches, at buffer area' });
  }
  // END ROAD WORK
  signList.push({ code: 'G20-2', description: 'END ROAD WORK', size: '36" x 18"', qty: 2, location: 'Both approaches, termination area' });
  // Long work zone repeater signs (>1 mile)
  if (ctx.routeDistanceFt > 5280) {
    const repeaterCount = Math.floor(ctx.routeDistanceFt / 5280); // One set per mile
    signList.push({ code: 'W20-1', description: 'ROAD WORK AHEAD (Repeater)', size: getSignSize(ctx.speedMph, ctx.roadName), qty: repeaterCount * 2, location: `Within activity area, at 1-mile intervals (${repeaterCount} sets × 2 per set)` });
  }
  // Cross-street W20-1 signs — size matches mainline speed requirements
  const csSignSize = getSignSize(ctx.speedMph, ctx.roadName);
  const isDw = (n: string) => /chevron|gas|station|access|driveway|parking|lot/i.test(n) && !/state\s*park|national|public/i.test(n);
  for (const cs of ctx.crossStreets) {
    const qty = isDw(cs.name) ? 1 : 2;
    signList.push({ code: 'W20-1', description: 'ROAD WORK AHEAD', size: csSignSize, qty, location: `${cs.name} (${isDw(cs.name) ? 'at access point' : 'both approaches'})` });
  }

  // Draw table
  const tx = 50, ty = 60, colW = [60, 180, 80, 50, 550];
  const headers = ['CODE', 'DESCRIPTION', 'SIZE', 'QTY', 'LOCATION'];
  const rowH = 28;

  // Header row
  doc.lineWidth(1).strokeColor('black');
  let hx = tx;
  doc.rect(tx, ty, colW.reduce((a, b) => a + b, 0), rowH).fillAndStroke('#e0e0e0', 'black');
  doc.fillColor('black').font('Helvetica-Bold').fontSize(9);
  headers.forEach((h, i) => {
    doc.text(h, hx + 4, ty + 9, { width: colW[i]! - 8, lineBreak: false });
    hx += colW[i]!;
  });

  // Data rows
  doc.font('Helvetica').fontSize(9);
  signList.forEach((sign, rowIdx) => {
    const ry = ty + rowH + rowIdx * rowH;
    let rx = tx;
    const bgColor = rowIdx % 2 === 0 ? '#e8e8e8' : '#ffffff';
    doc.rect(tx, ry, colW.reduce((a, b) => a + b, 0), rowH).fillAndStroke(bgColor, '#ccc');
    doc.fillColor('black');
    const vals = [sign.code, sign.description, sign.size, String(sign.qty), sign.location];
    vals.forEach((v, i) => {
      doc.text(v, rx + 4, ry + 10, { width: colW[i]! - 8, lineBreak: false });
      rx += colW[i]!;
    });
  });

  // Totals
  const totalY = ty + rowH + signList.length * rowH + 40;
  doc.font('Helvetica-Bold').fontSize(9).fillColor('black');
  // Channelizing device calculations — MUTCD 1V/2V formula
  const devSpacing = getDeviceSpacing(ctx.speedMph, ctx.taCode);
  const tangentLen = ctx.routeDistanceFt > 0 ? ctx.routeDistanceFt : 500;
  const taperDevices = Math.ceil(ctx.taperLengthFt / devSpacing.taperSpacingFt) + 1;
  const dnDevices = Math.ceil(ctx.blueprint.downstream_taper.length_ft / devSpacing.taperSpacingFt) + 1;
  const tangentDevices = Math.ceil(tangentLen / devSpacing.tangentSpacingFt);
  const totalDevices = taperDevices + tangentDevices + dnDevices;

  doc.text(`TOTAL SIGNS: ${signList.reduce((a, s) => a + s.qty, 0)}`, tx, totalY);
  doc.text(`CHANNELIZING DEVICES: ${ctx.blueprint.taper.device_type} — ${ctx.taperLengthFt} ft taper + ${tangentLen.toLocaleString()} ft tangent + ${ctx.blueprint.downstream_taper.length_ft} ft dn taper`, tx, totalY + 16);

  doc.font('Helvetica').fontSize(7);
  doc.text(`Device Spacing (MUTCD 11th Ed. 1V/2V): ${devSpacing.taperSpacingFt} ft in taper (1 x ${ctx.speedMph}), ${devSpacing.tangentSpacingFt} ft in tangent (2 x ${ctx.speedMph})`, tx, totalY + 36);
  doc.text(`Upstream Taper: ${taperDevices} | Work Area Tangent (${tangentLen.toLocaleString()} ft): ${tangentDevices} | Downstream: ${dnDevices}`, tx, totalY + 48);
  doc.font('Helvetica-Bold').text(`TOTAL CHANNELIZING DEVICES: ${totalDevices} minimum`, tx, totalY + 62);

  drawWatermark(doc);
  drawTitleBlock(doc, sheetNum, totalSheets, ctx.operationType, ctx.roadName);
}

// ===================================================================
// CONTEXT OBJECT — passed to all sheet functions
// ===================================================================
interface DrawContext {
  blueprint: Blueprint;
  staticMapBase64: string | null;
  startCoords: { lat: number; lng: number } | null;
  endCoords: { lat: number; lng: number } | null;
  speedMph: number;
  wzSpeedMph: number;
  laneWidthFt: number;
  operationType: string;
  routeDistanceFt: number;
  roadName: string;
  crossStreets: CrossStreet[];
  taperLengthFt: number;
  terrain: string;
  funcClass: string;
  mainRoadNumber: string;
  taCode: string;
  taDescription: string;
  totalLanes: number;
  hasTWLTL: boolean;
  isDivided: boolean;
  isMultiLane: boolean;
  aadt: number;
  truckPct: number;
  crashCount: number;
  bridges: any[];
  duration: string;
  operationTypes: string[];
  geoPlanSheets: number;
}

// ===================================================================
// DXF GENERATOR (ENGINEERING-GRADE — mirrors PDF TA schematic)
// ===================================================================
export function generateDXF(
  blueprint: Blueprint, dxfPath: string, speedMph = 65, laneWidthFt = 12, operationType = 'Single Lane Closure',
  startCoords: { lat: number; lng: number } | null = null, routeDistanceFt = 0,
  roadName = '', crossStreets: CrossStreet[] = [], terrain = '', funcClass = '',
  totalLanes = 0, taCode = 'TA-10', taperLengthFt = 100, wzSpeedMph = 55,
): void {
  const origin = startCoords ? gpsToWebMercatorFt(startCoords.lat, startCoords.lng) : { x: 0, y: 0 };
  const ox = origin.x, oy = origin.y;

  const d = new Drawing();
  d.setUnits('Feet');

  // Standard CAD layers
  d.addLayer('L-ROAD-EDGE',   Drawing.ACI.WHITE,   'CONTINUOUS');
  d.addLayer('L-ROAD-CNTR',   Drawing.ACI.YELLOW,  'CONTINUOUS');
  d.addLayer('L-ROAD-LANE',   Drawing.ACI.WHITE,   'CONTINUOUS');
  d.addLayer('L-TTC-WORK',    Drawing.ACI.RED,     'CONTINUOUS');
  d.addLayer('L-TTC-TAPER',   Drawing.ACI.MAGENTA, 'CONTINUOUS');
  d.addLayer('L-TTC-BUFFER',  Drawing.ACI.YELLOW,  'CONTINUOUS');
  d.addLayer('L-TTC-DEVICE',  Drawing.ACI.MAGENTA, 'CONTINUOUS');
  d.addLayer('L-TTC-SIGN',    Drawing.ACI.GREEN,   'CONTINUOUS');
  d.addLayer('L-TTC-FLAGGER', Drawing.ACI.RED,     'CONTINUOUS');
  d.addLayer('L-XSTREET',     Drawing.ACI.CYAN,    'CONTINUOUS');
  d.addLayer('L-ANNO-TEXT',   Drawing.ACI.CYAN,    'CONTINUOUS');
  d.addLayer('L-ANNO-DIMS',   Drawing.ACI.WHITE,   'CONTINUOUS');
  d.addLayer('L-GEO-REF',     Drawing.ACI.YELLOW,  'CONTINUOUS');
  d.addLayer('L-TITLE',       Drawing.ACI.WHITE,   'CONTINUOUS');

  // Lane geometry
  const lanes = totalLanes || 2;
  const halfRoad = (lanes * laneWidthFt) / 2;
  const isDivided = ['TA-33', 'TA-35'].includes(taCode);
  const hasTWLTL = lanes === 3 || lanes === 5;

  // Zone layout (linear schematic in real-world feet)
  const bufferFt = getBufferSpaceFt(speedMph);
  const dnTaperFt = blueprint.downstream_taper.length_ft || 50;
  const spacing = getABCSpacing(speedMph, terrain, funcClass, 0, 0, 0, roadName);
  const deviceSpacing = getDeviceSpacing(speedMph, taCode);
  const workZoneFt = routeDistanceFt > 0 ? Math.min(routeDistanceFt, 10000) : 400;

  // Linear stations (distance from upstream end)
  // Signs go at their MUTCD distances from the taper
  const maxSignDist = Math.max(...blueprint.primary_approach.map(s => s.distance_ft), spacing.a);
  const roadStart = 0;
  const taperStart = maxSignDist + 100;
  const taperEnd = taperStart + taperLengthFt;
  const workStart = taperEnd + bufferFt;
  const workEnd = workStart + workZoneFt;
  const dnTaperEnd = workEnd + dnTaperFt;
  const maxOppDist = blueprint.opposing_approach.length > 0
    ? Math.max(...blueprint.opposing_approach.map(s => s.distance_ft), spacing.a)
    : spacing.a;
  const roadEnd = dnTaperEnd + maxOppDist + 200;

  // === GEO REFERENCE ===
  if (startCoords) {
    d.setActiveLayer('L-GEO-REF');
    d.drawText(ox, oy + halfRoad + 80, 8, 0, `GEO ORIGIN: ${startCoords.lat.toFixed(6)}, ${startCoords.lng.toFixed(6)} (EPSG:3857 ft)`);
    d.drawText(ox, oy + halfRoad + 65, 6, 0, `Datum: NAD83 | Units: US Survey Feet`);
  }

  // === ROAD EDGES ===
  d.setActiveLayer('L-ROAD-EDGE');
  d.drawLine(ox + roadStart, oy + halfRoad, ox + roadEnd, oy + halfRoad);
  d.drawLine(ox + roadStart, oy - halfRoad, ox + roadEnd, oy - halfRoad);

  // === LANE LINES ===
  if (lanes <= 2) {
    // 2-lane: centerline (dashed in reality, solid in DXF — annotate)
    d.setActiveLayer('L-ROAD-CNTR');
    d.drawLine(ox + roadStart, oy, ox + roadEnd, oy);
  } else if (hasTWLTL) {
    // TWLTL: double yellow bounding center turn lane
    const turnHW = laneWidthFt / 2;
    d.setActiveLayer('L-ROAD-CNTR');
    d.drawLine(ox + roadStart, oy + turnHW, ox + roadEnd, oy + turnHW);
    d.drawLine(ox + roadStart, oy - turnHW, ox + roadEnd, oy - turnHW);
    d.setActiveLayer('L-ANNO-TEXT');
    d.drawText(ox + roadStart + 20, oy - 2, 4, 0, 'TWLTL');
  } else if (isDivided) {
    // Divided: median gap
    const medW = laneWidthFt; // assume median = 1 lane width
    d.setActiveLayer('L-ROAD-CNTR');
    d.drawLine(ox + roadStart, oy + medW / 2, ox + roadEnd, oy + medW / 2);
    d.drawLine(ox + roadStart, oy - medW / 2, ox + roadEnd, oy - medW / 2);
  } else {
    // Multi-lane undivided: centerline + lane lines
    d.setActiveLayer('L-ROAD-CNTR');
    d.drawLine(ox + roadStart, oy, ox + roadEnd, oy);
    d.setActiveLayer('L-ROAD-LANE');
    const lanesPerDir = Math.floor(lanes / 2);
    for (let i = 1; i < lanesPerDir; i++) {
      d.drawLine(ox + roadStart, oy - i * laneWidthFt, ox + roadEnd, oy - i * laneWidthFt);
      d.drawLine(ox + roadStart, oy + i * laneWidthFt, ox + roadEnd, oy + i * laneWidthFt);
    }
  }

  // === WORK ZONE (hatched rectangle on closed lane) ===
  d.setActiveLayer('L-TTC-WORK');
  d.drawRect(ox + workStart, oy - halfRoad, ox + workEnd, oy);
  // Crosshatch lines inside work zone
  const hatchStep = 40;
  for (let hx = workStart; hx < workEnd; hx += hatchStep) {
    const x1 = Math.max(hx, workStart);
    const x2 = Math.min(hx + halfRoad, workEnd);
    d.drawLine(ox + x1, oy - halfRoad, ox + x2, oy);
  }
  d.setActiveLayer('L-ANNO-TEXT');
  d.drawText(ox + workStart + (workZoneFt / 2) - 40, oy - halfRoad / 2 - 3, 6, 0, 'WORK ZONE');

  // === UPSTREAM TAPER ===
  d.setActiveLayer('L-TTC-TAPER');
  d.drawLine(ox + taperStart, oy - halfRoad, ox + taperEnd, oy);

  // === DOWNSTREAM TAPER ===
  d.drawLine(ox + workEnd, oy, ox + dnTaperEnd, oy - halfRoad);

  // === BUFFER SPACE ===
  d.setActiveLayer('L-TTC-BUFFER');
  // Buffer zone markers (dashed-style boundary lines)
  d.drawLine(ox + taperEnd, oy - halfRoad - 5, ox + taperEnd, oy + halfRoad + 5);
  d.drawLine(ox + workStart, oy - halfRoad - 5, ox + workStart, oy + halfRoad + 5);

  // === CHANNELIZING DEVICES ===
  d.setActiveLayer('L-TTC-DEVICE');
  // Taper devices
  const numTaperDevices = Math.max(2, Math.floor(taperLengthFt / deviceSpacing.taperSpacingFt));
  for (let i = 0; i <= numTaperDevices; i++) {
    const frac = i / numTaperDevices;
    const dx = taperStart + frac * taperLengthFt;
    const dy = -halfRoad + frac * halfRoad; // linear interpolation from edge to center
    d.drawCircle(ox + dx, oy + dy, 1.5);
  }
  // Tangent devices along work zone edge (centerline side)
  for (let tx = workStart; tx <= workEnd; tx += deviceSpacing.tangentSpacingFt) {
    d.drawCircle(ox + tx, oy, 1.5);
  }
  // Downstream taper devices
  const numDnDevices = Math.max(2, Math.floor(dnTaperFt / deviceSpacing.taperSpacingFt));
  for (let i = 0; i <= numDnDevices; i++) {
    const frac = i / numDnDevices;
    const dx = workEnd + frac * dnTaperFt;
    const dy = frac * (-halfRoad); // center back to edge
    d.drawCircle(ox + dx, oy + dy, 1.5);
  }

  // === PRIMARY APPROACH SIGNS (right shoulder, US driving) ===
  d.setActiveLayer('L-TTC-SIGN');
  const signOffset = halfRoad + 12; // 12 ft offset from road edge (shoulder)
  blueprint.primary_approach.forEach((sign) => {
    const sx = taperStart - sign.distance_ft;
    // Sign diamond symbol (rotated square)
    const sz = 4;
    d.drawPolyline([
      [ox + sx, oy - signOffset - sz],
      [ox + sx + sz, oy - signOffset],
      [ox + sx, oy - signOffset + sz],
      [ox + sx - sz, oy - signOffset],
    ], true);
    d.setActiveLayer('L-ANNO-TEXT');
    d.drawText(ox + sx - 15, oy - signOffset - sz - 12, 5, 0, sign.sign_code);
    d.drawText(ox + sx - 25, oy - signOffset - sz - 20, 4, 0, sign.label);
    d.setActiveLayer('L-TTC-SIGN');
  });

  // === OPPOSING APPROACH SIGNS (right shoulder for opposing traffic = top edge) ===
  if (blueprint.opposing_approach.length > 0) {
    blueprint.opposing_approach.forEach((sign) => {
      const sx = dnTaperEnd + sign.distance_ft;
      const sz = 4;
      d.drawPolyline([
        [ox + sx, oy + signOffset - sz],
        [ox + sx + sz, oy + signOffset],
        [ox + sx, oy + signOffset + sz],
        [ox + sx - sz, oy + signOffset],
      ], true);
      d.setActiveLayer('L-ANNO-TEXT');
      d.drawText(ox + sx - 15, oy + signOffset + sz + 5, 5, 0, sign.sign_code);
      d.drawText(ox + sx - 25, oy + signOffset + sz + 13, 4, 0, sign.label);
      d.setActiveLayer('L-TTC-SIGN');
    });
  }

  // === FLAGGER SYMBOLS (TA-10 only) ===
  if (taCode === 'TA-10') {
    d.setActiveLayer('L-TTC-FLAGGER');
    // Upstream flagger at taper start
    d.drawCircle(ox + taperStart, oy + halfRoad + 8, 3);
    d.drawLine(ox + taperStart, oy + halfRoad + 5, ox + taperStart, oy + halfRoad + 11);
    d.setActiveLayer('L-ANNO-TEXT');
    d.drawText(ox + taperStart - 15, oy + halfRoad + 15, 5, 0, 'FLAGGER');
    // Downstream flagger at work zone end
    d.setActiveLayer('L-TTC-FLAGGER');
    d.drawCircle(ox + workEnd + 20, oy + halfRoad + 8, 3);
    d.drawLine(ox + workEnd + 20, oy + halfRoad + 5, ox + workEnd + 20, oy + halfRoad + 11);
    d.setActiveLayer('L-ANNO-TEXT');
    d.drawText(ox + workEnd + 5, oy + halfRoad + 15, 5, 0, 'FLAGGER');
  }

  // === ARROW BOARD (TA-30/31/33/35) ===
  if (['TA-30', 'TA-31', 'TA-33', 'TA-35'].includes(taCode)) {
    d.setActiveLayer('L-TTC-DEVICE');
    const abX = taperStart + taperLengthFt * 0.3; // Arrow board ~30% into taper
    d.drawRect(ox + abX - 6, oy - halfRoad - 10, ox + abX + 6, oy - halfRoad - 4);
    d.setActiveLayer('L-ANNO-TEXT');
    d.drawText(ox + abX - 18, oy - halfRoad - 18, 4, 0, 'ARROW BOARD');
  }

  // === DIMENSION LINES ===
  d.setActiveLayer('L-ANNO-DIMS');
  const dimY = oy - halfRoad - 35;
  // Taper length
  d.drawLine(ox + taperStart, dimY, ox + taperEnd, dimY);
  d.drawLine(ox + taperStart, dimY - 3, ox + taperStart, dimY + 3);
  d.drawLine(ox + taperEnd, dimY - 3, ox + taperEnd, dimY + 3);
  d.drawText(ox + taperStart + (taperLengthFt / 2) - 20, dimY + 5, 5, 0, `TAPER: ${taperLengthFt} FT`);
  // Buffer
  d.drawLine(ox + taperEnd, dimY - 15, ox + workStart, dimY - 15);
  d.drawLine(ox + taperEnd, dimY - 18, ox + taperEnd, dimY - 12);
  d.drawLine(ox + workStart, dimY - 18, ox + workStart, dimY - 12);
  d.drawText(ox + taperEnd + (bufferFt / 2) - 20, dimY - 10, 5, 0, `BUFFER: ${bufferFt} FT`);
  // Work zone
  d.drawLine(ox + workStart, dimY, ox + workEnd, dimY);
  d.drawLine(ox + workStart, dimY - 3, ox + workStart, dimY + 3);
  d.drawLine(ox + workEnd, dimY - 3, ox + workEnd, dimY + 3);
  d.drawText(ox + workStart + (workZoneFt / 2) - 25, dimY + 5, 5, 0, `WORK: ${workZoneFt} FT`);
  // Downstream taper
  d.drawLine(ox + workEnd, dimY - 15, ox + dnTaperEnd, dimY - 15);
  d.drawLine(ox + workEnd, dimY - 18, ox + workEnd, dimY - 12);
  d.drawLine(ox + dnTaperEnd, dimY - 18, ox + dnTaperEnd, dimY - 12);
  d.drawText(ox + workEnd + (dnTaperFt / 2) - 20, dimY - 10, 5, 0, `DN TAPER: ${dnTaperFt} FT`);
  // Sign distances
  blueprint.primary_approach.forEach((sign) => {
    const sx = taperStart - sign.distance_ft;
    d.drawLine(ox + sx, dimY - 30, ox + taperStart, dimY - 30);
    d.drawLine(ox + sx, dimY - 33, ox + sx, dimY - 27);
    d.drawText(ox + sx + 5, dimY - 25, 4, 0, `${sign.sign_code}: ${sign.distance_ft} FT`);
  });

  // === CROSS-STREET STUBS ===
  if (crossStreets && crossStreets.length > 0) {
    d.setActiveLayer('L-XSTREET');
    crossStreets.forEach((cs) => {
      const csX = taperStart + cs.position * (workEnd - taperStart);
      // Cross-street stub lines
      d.drawLine(ox + csX, oy + halfRoad, ox + csX, oy + halfRoad + 80);
      d.drawLine(ox + csX, oy - halfRoad, ox + csX, oy - halfRoad - 80);
      // Cross-street edge lines (20ft wide default)
      const csHW = 10;
      d.drawLine(ox + csX - csHW, oy + halfRoad, ox + csX - csHW, oy + halfRoad + 60);
      d.drawLine(ox + csX + csHW, oy + halfRoad, ox + csX + csHW, oy + halfRoad + 60);
      d.drawLine(ox + csX - csHW, oy - halfRoad, ox + csX - csHW, oy - halfRoad - 60);
      d.drawLine(ox + csX + csHW, oy - halfRoad, ox + csX + csHW, oy - halfRoad - 60);
      // Label
      d.setActiveLayer('L-ANNO-TEXT');
      d.drawText(ox + csX - 30, oy + halfRoad + 85, 5, 0, cs.name.toUpperCase());
      d.setActiveLayer('L-XSTREET');
    });
  }

  // === DIRECTION ARROWS ===
  d.setActiveLayer('L-ANNO-TEXT');
  // Primary direction arrow (left to right)
  d.drawLine(ox + roadStart + 30, oy + halfRoad + 20, ox + roadStart + 70, oy + halfRoad + 20);
  d.drawLine(ox + roadStart + 65, oy + halfRoad + 17, ox + roadStart + 70, oy + halfRoad + 20);
  d.drawLine(ox + roadStart + 65, oy + halfRoad + 23, ox + roadStart + 70, oy + halfRoad + 20);
  d.drawText(ox + roadStart + 30, oy + halfRoad + 27, 5, 0, 'PRIMARY APPROACH >>>');
  // Opposing direction arrow (right to left)
  d.drawLine(ox + roadEnd - 70, oy - halfRoad - 20, ox + roadEnd - 30, oy - halfRoad - 20);
  d.drawLine(ox + roadEnd - 65, oy - halfRoad - 17, ox + roadEnd - 70, oy - halfRoad - 20);
  d.drawLine(ox + roadEnd - 65, oy - halfRoad - 23, ox + roadEnd - 70, oy - halfRoad - 20);
  d.drawText(ox + roadEnd - 100, oy - halfRoad - 30, 5, 0, '<<< OPPOSING');

  // === TITLE BLOCK ===
  d.setActiveLayer('L-TITLE');
  const tbLeft = ox - 50;
  const tbRight = ox + roadEnd + 50;
  const tbTop = oy - halfRoad - 100;
  const tbBot = tbTop - 50;
  d.drawRect(tbLeft, tbBot, tbRight, tbTop);
  d.drawText(tbLeft + 10, tbBot + 35, 10, 0, 'IDAHO TRANSPORTATION DEPARTMENT');
  d.drawText(tbLeft + 10, tbBot + 20, 8, 0, `TEMPORARY TRAFFIC CONTROL PLAN — ${operationType.toUpperCase()}`);
  d.drawText(tbLeft + 10, tbBot + 8, 6, 0, `${taCode}: ${roadName || 'PROJECT ROAD'} | Speed: ${speedMph} MPH | WZ Speed: ${wzSpeedMph} MPH | Lanes: ${lanes}`);
  // Right-side info
  const rbX = tbRight - 400;
  d.drawText(rbX, tbBot + 35, 8, 0, `Sign Size: ${getSignSize(speedMph, roadName)}`);
  d.drawText(rbX, tbBot + 20, 6, 0, `Device Spacing — Taper: ${deviceSpacing.taperSpacingFt} ft | Tangent: ${deviceSpacing.tangentSpacingFt} ft`);
  d.drawText(rbX, tbBot + 8, 6, 0, `Buffer: ${bufferFt} ft (Table 6C-2) | Spacing Class: ${spacing.classification}`);

  // === ROAD LABEL ===
  d.setActiveLayer('L-ANNO-TEXT');
  d.drawText(ox + roadEnd + 10, oy - 3, 8, 0, roadName || 'MAIN ROAD');

  fs.writeFileSync(dxfPath, d.toDxfString(), 'utf8');
}

// ===================================================================
// MAIN EXPORT — ADAPTIVE MULTI-SHEET TCP PLAN SET
// ===================================================================
export async function generateCAD(
  blueprint: Blueprint,
  staticMapBase64: string | null,
  startCoords: { lat: number; lng: number } | null,
  endCoords: { lat: number; lng: number } | null,
  pdfPath: string,
  dxfPath: string,
  speedMph = 65,
  wzSpeedMph = 55,
  laneWidthFt = 12,
  operationType = 'Single Lane Closure',
  routeDistanceFt = 0,
  roadName = '',
  crossStreets: CrossStreet[] = [],
  terrain = '',
  funcClass = '',
  totalLanes = 0,
  aadt = 0,
  truckPct = 0,
  crashCount = 0,
  bridges: any[] = [],
  duration = 'Short-term (<= 3 days)',
  maxGradePercent = 0,
  operationTypes: string[] = [],
  routePolyline = '',
): Promise<GenerationResult> {
  // === BLUEPRINT VALIDATION — ensure all required fields exist ===
  if (!blueprint.primary_approach || !Array.isArray(blueprint.primary_approach)) blueprint.primary_approach = [];
  if (!blueprint.opposing_approach || !Array.isArray(blueprint.opposing_approach)) blueprint.opposing_approach = [];
  if (!blueprint.taper) blueprint.taper = { length_ft: 0, device_type: 'Cones' };
  if (!blueprint.downstream_taper) blueprint.downstream_taper = { length_ft: 50 };
  if (!blueprint.engineering_notes) blueprint.engineering_notes = '';
  if (!blueprint.taper.device_type) blueprint.taper.device_type = 'Cones';

  // Ensure minimum sign sequences — every approach needs at least W20-1
  if (blueprint.primary_approach.length === 0) {
    blueprint.primary_approach = [
      { sign_code: 'W20-1', distance_ft: 1000, label: 'ROAD WORK AHEAD' },
      { sign_code: 'W20-4', distance_ft: 500, label: 'ONE LANE ROAD AHEAD' },
    ];
  }
  if (blueprint.opposing_approach.length === 0) {
    blueprint.opposing_approach = [
      { sign_code: 'W20-1', distance_ft: 1000, label: 'ROAD WORK AHEAD' },
    ];
  }

  // Validate sign distances — must be positive numbers
  for (const sign of [...blueprint.primary_approach, ...blueprint.opposing_approach]) {
    if (!sign.distance_ft || sign.distance_ft <= 0) sign.distance_ft = 500;
    if (!sign.sign_code) sign.sign_code = 'W20-1';
    if (!sign.label) sign.label = 'ROAD WORK AHEAD';
  }

  // === INPUT VALIDATION ===
  const fcCode = funcClass ? parseInt(funcClass) || 99 : 99;
  const validation = MUTCD.validateInputData(roadName, speedMph, aadt, fcCode === 99 ? 0 : fcCode, totalLanes);
  if (validation.warnings.length > 0) {
    console.warn(`[cadGenerator] Data warnings: ${validation.warnings.join(' | ')}`);
  }

  // === TA SELECTION via MUTCD module (single source of truth) ===
  const isDivided = fcCode <= 3 && totalLanes >= 4;
  const hasTWLTL = totalLanes === 3 || totalLanes === 5;
  const isMultiLane = totalLanes >= 4 || (totalLanes === 3 && !hasTWLTL);

  let taSelection = MUTCD.selectTA(operationType, totalLanes, fcCode, isDivided, aadt, terrain);

  // === ROUNDABOUT TA OVERRIDE ===
  // If any cross-street within the work zone is a roundabout, override to roundabout-specific TA
  const hasRoundabout = crossStreets.some(cs => cs.geometry?.type === 'roundabout' || cs.geometry?.intersectionType?.includes('roundabout'));
  if (hasRoundabout) {
    const circulatoryLanes = crossStreets.find(cs => cs.geometry?.type === 'roundabout')?.geometry?.circulatoryLanes || 1;
    const workDuration = MUTCD.parseDuration(duration);
    taSelection = MUTCD.selectRoundaboutTA(circulatoryLanes, workDuration, true);
    console.log(`[cadGenerator] ROUNDABOUT OVERRIDE: ${taSelection.code} (${taSelection.title})`);
  }

  const taCode = taSelection.code;
  const taDescription = taSelection.title;
  console.log(`[cadGenerator] TA Selection: ${taCode} (${taDescription}) | Lanes: ${totalLanes} | FC: ${fcCode} | Op: ${operationType}${hasRoundabout ? ' | ROUNDABOUT' : ''}`);

  // === CAPTURE PE ORIGINALS FOR CORRECTION TRACKING ===
  const peOriginalTaper = blueprint.taper.length_ft;
  const peOriginalSigns = blueprint.primary_approach.map(s => s.sign_code).join(', ');
  const peOriginalDevice = blueprint.taper.device_type;

  // Taper length determination (via MUTCD module)
  const taperLengthFt = MUTCD.getTaperLength(taCode, laneWidthFt, speedMph);

  // Track corrections
  const corrections: CorrectionEntry[] = [];
  if (peOriginalTaper !== taperLengthFt) {
    corrections.push({ field: 'Taper Length', peValue: `${peOriginalTaper} ft`, correctedValue: `${taperLengthFt} ft`, reason: taCode === 'TA-10' ? 'MUTCD 6C.08: flagger taper clamped 50-100 ft' : `MUTCD 6C.08: L=${speedMph >= 45 ? 'WS' : 'WS²/60'} = ${taperLengthFt} ft` });
  }

  // === MUTCD-AUTHORITATIVE SIGN ENFORCEMENT ===
  // Use MUTCD module as the source of truth for sign codes.
  // PE Agent provides distances; we enforce correct sign codes per TA.
  // Get required signs — use roundabout-specific signs if applicable
  let requiredSigns: ReturnType<typeof MUTCD.getRequiredSigns>;
  if (MUTCD.isRoundaboutTA(taCode) || hasRoundabout) {
    const rbSigns = MUTCD.getRoundaboutSigns(taCode);
    requiredSigns = { primary: rbSigns.approach, opposing: rbSigns.approach }; // All approaches get same signs
  } else {
    requiredSigns = MUTCD.getRequiredSigns(taCode);
  }
  const spacing = MUTCD.getSignSpacing(speedMph, fcCode, terrain, maxGradePercent, aadt, crossStreets?.length || 0, roadName);

  // Build authoritative primary sign sequence using MUTCD-required codes.
  // Use PE distances if they meet MUTCD minimums, otherwise recalculate from Table 6B-1.
  const peDistances = blueprint.primary_approach.map(s => s.distance_ft).sort((a, b) => b - a);
  const numRequired = requiredSigns.primary.length;

  // Level 1: Check if first sign distance meets A minimum
  const peFirstDist = peDistances[0] || 0;
  let useAuthoritative = peFirstDist < spacing.a * 0.9;

  // Level 2: Even if first sign passes, check inter-sign B/C spacing
  if (!useAuthoritative && peDistances.length >= 2) {
    for (let i = 0; i < peDistances.length - 1; i++) {
      const interSpace = peDistances[i]! - peDistances[i + 1]!;
      const reqSpace = i === 0 ? spacing.b : spacing.c;
      if (interSpace < reqSpace * 0.85) { useAuthoritative = true; break; }
    }
  }

  // Build authoritative distances: first sign at A+(n-1)*B, then decrement by B
  const authDistances: number[] = [];
  for (let i = 0; i < numRequired; i++) {
    if (i === 0) authDistances.push(spacing.a + (numRequired - 1) * spacing.b);
    else authDistances.push(authDistances[i - 1]! - spacing.b);
  }

  const finalDistances = useAuthoritative ? authDistances : peDistances;

  // Ensure we have enough distances
  while (finalDistances.length < numRequired) {
    const lastDist = finalDistances.length > 0 ? finalDistances[finalDistances.length - 1]! : spacing.a;
    finalDistances.push(Math.max(lastDist - spacing.b, spacing.a));
  }

  if (useAuthoritative) {
    corrections.push({ field: 'Sign Distances', peValue: peDistances.map(d => d + ' ft').join(', '), correctedValue: finalDistances.map(d => d + ' ft').join(', '), reason: `PE distances violated Table 6B-1 ${spacing.classification} minimums (A=${spacing.a}, B=${spacing.b}, C=${spacing.c})` });
  }

  blueprint.primary_approach = requiredSigns.primary.map((req, i) => ({
    sign_code: req.code,
    distance_ft: finalDistances[i] || spacing.a,
    label: req.label,
  }));

  // Add W3-5 REDUCED SPEED when WZ speed differs — BOTH approaches per MUTCD 6C.01
  if (speedMph !== wzSpeedMph) {
    const addW35 = (signs: Sign[]) => {
      const sortedDists = signs.map(s => s.distance_ft).sort((a, b) => a - b);
      const closestSign = sortedDists[0] ?? spacing.a;
      const w35dist = Math.max(closestSign - spacing.b, 50);
      signs.push({ sign_code: 'W3-5', distance_ft: w35dist, label: `REDUCED SPEED ${wzSpeedMph} MPH AHEAD` });
    };
    addW35(blueprint.primary_approach);
    if (blueprint.opposing_approach.length > 0) addW35(blueprint.opposing_approach);
  }

  // Build authoritative opposing sign sequence (same spacing enforcement)
  if (requiredSigns.opposing.length > 0) {
    const oppPeDistances = blueprint.opposing_approach.map(s => s.distance_ft).sort((a, b) => b - a);
    const oppFirstDist = oppPeDistances[0] || 0;
    const useOppAuth = oppFirstDist < spacing.a * 0.9;
    const oppAuthDistances: number[] = [];
    for (let i = 0; i < requiredSigns.opposing.length; i++) {
      if (i === 0) oppAuthDistances.push(spacing.a + (requiredSigns.opposing.length - 1) * spacing.b);
      else oppAuthDistances.push(oppAuthDistances[i - 1]! - spacing.b);
    }
    const oppFinalDistances = useOppAuth ? oppAuthDistances : oppPeDistances;
    while (oppFinalDistances.length < requiredSigns.opposing.length) {
      const lastDist = oppFinalDistances.length > 0 ? oppFinalDistances[oppFinalDistances.length - 1]! : spacing.a;
      oppFinalDistances.push(Math.max(lastDist - spacing.b, spacing.a));
    }
    blueprint.opposing_approach = requiredSigns.opposing.map((req, i) => ({
      sign_code: req.code,
      distance_ft: oppFinalDistances[i] || spacing.a,
      label: req.label,
    }));
  } else {
    // TA-33/35 (divided) — opposing traffic unaffected
    blueprint.opposing_approach = [];
  }

  // === DEVICE TYPE ENFORCEMENT based on duration (via MUTCD module) ===
  const workDuration = MUTCD.parseDuration(duration);
  const deviceReq = MUTCD.getDeviceRequirements(workDuration);
  blueprint.taper.device_type = deviceReq.label;

  // Track sign and device corrections
  const correctedSigns = blueprint.primary_approach.map(s => s.sign_code).join(', ');
  if (peOriginalSigns !== correctedSigns) {
    corrections.push({ field: 'Sign Codes', peValue: peOriginalSigns, correctedValue: correctedSigns, reason: `MUTCD TA ${taCode} required signs enforced` });
  }
  if (peOriginalDevice !== blueprint.taper.device_type) {
    corrections.push({ field: 'Device Type', peValue: peOriginalDevice, correctedValue: blueprint.taper.device_type, reason: `MUTCD 6F.01: ${workDuration} requires ${deviceReq.label}` });
  }

  if (routeDistanceFt === 0 && startCoords && endCoords) {
    routeDistanceFt = Math.round(haversineDistanceFt(startCoords, endCoords));
  }

  // Sanitize cross-streets array
  if (!crossStreets || !Array.isArray(crossStreets)) crossStreets = [];

  // Filter out cross-streets that are actually the same road (alternate names, concurrent routes)
  // Uses GEOMETRIC approach: if a "cross-street" has a bearing within 30° of the primary road
  // at that point, it's the same road with a different name — not an intersection.
  const mainRoadNum = extractRoadNumber(roadName);

  // Build alignment for bearing checks if we have a route polyline
  let routeAlignment: ProjectAlignment | null = null;
  if (routePolyline) {
    try {
      const pts = decodeGooglePolyline(routePolyline);
      if (pts.length >= 2) routeAlignment = new ProjectAlignment(pts);
    } catch { /* skip */ }
  }

  const filteredCrossStreets = crossStreets.slice(0, 10).filter(cs => {
    const csNum = extractRoadNumber(cs.name);
    // Remove if the cross-street's route number matches the main road
    if (mainRoadNum && csNum && csNum === mainRoadNum) return false;
    // Remove if the cross-street name is essentially the main road name
    const csNorm = cs.name.toLowerCase().replace(/[^a-z0-9]/g, '');
    const mainNorm = roadName.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (mainNorm && (csNorm === mainNorm || csNorm.includes(mainNorm) || mainNorm.includes(csNorm))) return false;

    // GEOMETRIC CHECK: If this "cross-street" was detected at a position along the route,
    // check if the road bearing at that point is essentially the same as the primary road.
    // This catches concurrent routes (US-26 on US-20), alternate names (Chinden Blvd),
    // and honorary designations (POW-MIA Hwy) without any hardcoded name patterns.
    if (routeAlignment && cs.position >= 0 && cs.position <= 1) {
      const sta = cs.position * routeAlignment.totalLengthFt;
      // Check if any nearby ITD road segment at this position is collinear
      // A cross-street detected by geocoding but collinear with the main road = same road
      // Check the position ±5% — if no actual angle change, it's the same road
      const nearSta1 = Math.max(0, sta - routeAlignment.totalLengthFt * 0.03);
      const nearSta2 = Math.min(routeAlignment.totalLengthFt, sta + routeAlignment.totalLengthFt * 0.03);
      const bear1 = routeAlignment.getCoordinatesAtStation(nearSta1).heading;
      const bear2 = routeAlignment.getCoordinatesAtStation(nearSta2).heading;
      // If the bearing doesn't change significantly at this "intersection", the road is continuous
      const bearingChange = Math.abs(bear2 - bear1);
      const normalizedChange = bearingChange > 180 ? 360 - bearingChange : bearingChange;
      if (normalizedChange < 15) {
        // Road is straight through this point — "cross-street" is likely an alternate name
        // Only filter if the name also looks like a highway/route (not a local street)
        if (isHighway(cs.name) || /\b(Blvd|Boulevard|Ave|Avenue)\b/i.test(cs.name)) {
          console.log(`[cadGenerator] Filtering "${cs.name}" — collinear with primary road (bearing change ${normalizedChange.toFixed(1)}°)`);
          return false;
        }
      }
    }
    return true;
  }).slice(0, 6);
  console.log(`[cadGenerator] Cross-streets: ${crossStreets.length} detected → ${filteredCrossStreets.length} after filtering (${filteredCrossStreets.map(c => c.name).join(', ')})`);

  // Filter phases for compatibility before counting sheets
  const compatPhases = (operationTypes.length > 0 ? operationTypes : [operationType]).filter(op => {
    if (op === 'Median Crossover' && hasTWLTL) return false;
    if (op === 'Median Crossover' && !isDivided && totalLanes < 4) return false;
    if (op === 'Double Lane Closure' && totalLanes < 3) return false;
    return true;
  });
  const phaseCount = compatPhases.length || 1;
  // Count geometry plan sheets
  let geoPlanSheets = 0;
  if (routePolyline) {
    try {
      const testPts = decodeGooglePolyline(routePolyline);
      if (testPts.length >= 2) {
        const testAlign = new ProjectAlignment(testPts);
        geoPlanSheets = generateViewports(testAlign).length;
      }
    } catch { /* skip */ }
  }
  const totalSheets = 2 + phaseCount + filteredCrossStreets.length + 3 + geoPlanSheets;

  const ctx: DrawContext = {
    blueprint, staticMapBase64, startCoords, endCoords,
    speedMph, wzSpeedMph, laneWidthFt, operationType,
    routeDistanceFt, roadName, crossStreets: filteredCrossStreets, taperLengthFt,
    terrain, funcClass, mainRoadNumber: mainRoadNum, taCode, taDescription,
    totalLanes, hasTWLTL, isDivided, isMultiLane,
    aadt, truckPct, crashCount, bridges, duration,
    operationTypes: operationTypes.length > 0 ? operationTypes : [operationType],
    geoPlanSheets,
  };

  // Pre-fetch basemap: ITD primary (authoritative), OSM supplemental
  let geoBasemapRoads: OsmRoadway[] = [];
  let itdRoadSegments: ItdRoadSegment[] = [];
  if (routePolyline && startCoords && endCoords) {
    // ITD primary — authoritative Idaho road geometry
    try {
      itdRoadSegments = await fetchItdRoadGeometryAlongRoute(
        startCoords.lat, startCoords.lng, endCoords.lat, endCoords.lng, 600
      );
    } catch { /* ITD may timeout */ }

    // OSM supplemental — catches local streets ITD may miss
    if (itdRoadSegments.length < 5) {
      try {
        geoBasemapRoads = await fetchRoadNetwork(startCoords.lat, startCoords.lng, endCoords.lat, endCoords.lng, 600);
      } catch { /* graceful degradation */ }
    }
  }

  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'tabloid', layout: 'landscape', margin: 0, autoFirstPage: false });
      const pdfStream = fs.createWriteStream(pdfPath);

      pdfStream.on('finish', () => {
        try {
          generateDXF(blueprint, dxfPath, speedMph, laneWidthFt, operationType, startCoords, routeDistanceFt, roadName, filteredCrossStreets, terrain, funcClass, totalLanes, taCode, taperLengthFt, wzSpeedMph);
          console.log(`[cadGenerator] Complete. ${totalSheets} sheets. PDF: ${pdfPath} | DXF: ${dxfPath}`);

          // === MUTCD COMPLIANCE CHECKS (via authoritative reference module) ===
          const fcCode = funcClass ? parseInt(funcClass) || 99 : 99;
          const roadClass = MUTCD.classifyRoad(speedMph, fcCode, terrain, aadt, filteredCrossStreets.length, roadName);
          const signSpacing = MUTCD.getSignSpacing(speedMph, fcCode, terrain, maxGradePercent, aadt, filteredCrossStreets.length, roadName);
          const bufferFt = MUTCD.getBufferSpace(speedMph);
          const workDuration = MUTCD.parseDuration(duration);

          const compliance = MUTCD.runComplianceChecks({
            taCode, speedMph, wzSpeedMph, laneWidthFt, taperLengthFt, bufferFt,
            dnTaperFt: blueprint.downstream_taper.length_ft,
            primarySigns: blueprint.primary_approach.map(s => ({ sign_code: s.sign_code, distance_ft: s.distance_ft })),
            opposingSigns: blueprint.opposing_approach.map(s => ({ sign_code: s.sign_code, distance_ft: s.distance_ft })),
            deviceType: blueprint.taper.device_type,
            duration: workDuration,
            roadClass,
            roadName,
            crossStreetCount: filteredCrossStreets.length,
            arrowBoard: ['TA-30', 'TA-31', 'TA-33', 'TA-34', 'TA-35', 'TA-36'].includes(taCode),
          });

          const errors = compliance.filter(c => !c.pass && c.severity === 'error');
          const warnings = compliance.filter(c => !c.pass && c.severity === 'warning');
          const passCount = compliance.filter(c => c.pass).length;
          console.log(`[cadGenerator] Compliance: ${passCount}/${compliance.length} passed | ${errors.length} errors | ${warnings.length} warnings`);

          resolve({
            taCode, taDescription, taperLengthFt, bufferFt,
            deviceType: blueprint.taper.device_type,
            totalSheets,
            primarySigns: [...blueprint.primary_approach],
            opposingSigns: [...blueprint.opposing_approach],
            compliance: compliance.map(c => ({ rule: c.rule, requirement: c.requirement, actual: c.actual, pass: c.pass })),
            corrections,
            dataWarnings: validation.warnings,
            roadClassification: signSpacing.classification,
            signSpacingA: signSpacing.a,
            signSpacingB: signSpacing.b,
            signSpacingC: signSpacing.c,
          });
        } catch (dxfErr) {
          reject(new Error(`DXF write failed: ${dxfErr}`));
        }
      });
      pdfStream.on('error', (err) => reject(new Error(`PDF stream error: ${err}`)));
      doc.on('error', (err) => reject(new Error(`PDFKit doc error: ${err}`)));
      doc.pipe(pdfStream);

      let sheetNum = 1;

      // Sheet 1: Cover Sheet & General Notes
      drawCoverSheet(doc, sheetNum++, totalSheets, ctx);

      // Sheet 2+: Typical Application(s) — one per operation phase
      // Filter out operations incompatible with road geometry
      const allPhases = operationTypes.length > 0 ? operationTypes : [operationType];
      const phases = allPhases.filter(op => {
        if (op === 'Median Crossover' && hasTWLTL) return false; // TWLTL has no median
        if (op === 'Median Crossover' && !isDivided && totalLanes < 4) return false;
        if (op === 'Double Lane Closure' && totalLanes < 3) return false; // Can't close 2 of 2 lanes
        return true;
      });
      if (phases.length === 0) phases.push(operationType); // Ensure at least primary op
      for (const phaseOp of phases) {
        const phaseTA = MUTCD.selectTA(phaseOp, totalLanes, fcCode, isDivided, aadt, terrain);
        const phaseTaper = MUTCD.getTaperLength(phaseTA.code, laneWidthFt, speedMph);
        const phaseCtx: DrawContext = {
          ...ctx,
          operationType: phaseOp,
          taCode: phaseTA.code,
          taDescription: phaseTA.title,
          taperLengthFt: phaseTaper,
        };
        drawTASheet(doc, sheetNum++, totalSheets, phaseCtx);
      }

      // Sheet 3: Site-Specific Layout (Satellite Overlay)
      drawSiteLayoutSheet(doc, sheetNum++, totalSheets, ctx);

      // Sheets 4+: Intersection Details (one per cross-street)
      for (const cs of filteredCrossStreets) {
        drawIntersectionSheet(doc, sheetNum++, totalSheets, ctx, cs);
      }

      // Traffic Data & Queue Analysis
      drawQueueAnalysisSheet(doc, sheetNum++, totalSheets, ctx);

      // Special Considerations
      drawSpecialConsiderationsSheet(doc, sheetNum++, totalSheets, ctx);

      // Geometry Plan Sheets (true road shape from GPS polyline + OSM basemap)
      if (routePolyline && geoBasemapRoads !== undefined) {
        try {
          const gpsPoints = decodeGooglePolyline(routePolyline);
          if (gpsPoints.length >= 2) {
            const alignment = new ProjectAlignment(gpsPoints);
            const viewports = generateViewports(alignment);

            // Calculate the actual document page number for each viewport
            // so the index sheet grid labels point to the correct pages
            const geoBasePageNum = sheetNum; // First geometry sheet starts here
            for (let vi = 0; vi < viewports.length; vi++) {
              viewports[vi]!.sheetNumber = geoBasePageNum + vi; // Actual document page
            }

            for (let vi = 0; vi < viewports.length; vi++) {
              const vp = viewports[vi]!;
              // Skip degenerate viewports with minimal coverage (< 500ft of road)
              if (!vp.isIndexSheet && (vp.endStation - vp.startStation) < 500) continue;
              drawGeometryPlanSheet(doc, sheetNum++, totalSheets, ctx, alignment, vi + 1, viewports.length, vp.startStation, vp.endStation, geoBasemapRoads, itdRoadSegments, vp.isIndexSheet || false, viewports);
            }
            console.log(`[cadGenerator] Geometry plan: ${viewports.length} sheet(s), ${gpsPoints.length}-point polyline (${Math.round(alignment.totalLengthFt)} ft, UTM Zone ${alignment.utmZoneNumber}N), ${itdRoadSegments.length} ITD + ${geoBasemapRoads.length} OSM roads`);
          }
        } catch (geoErr) {
          console.warn('[cadGenerator] Geometry plan generation failed:', geoErr);
        }
      }

      // Last Sheet: Sign Schedule
      drawSignScheduleSheet(doc, sheetNum++, totalSheets, ctx);

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
