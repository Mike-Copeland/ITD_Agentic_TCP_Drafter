import PDFDocument from 'pdfkit';
import fs from 'fs';
import Drawing from 'dxf-writer';

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
    approachAngle: number; // degrees from perpendicular (0 = perfect cross, 45 = angled)
    legs: number; // 3 for T, 4 for cross, etc.
  };
}

type Doc = InstanceType<typeof PDFDocument>;

// ===================================================================
// MATH UTILITIES
// ===================================================================
function calcTaperLength(laneWidthFt: number, speedMph: number): number {
  return speedMph >= 45 ? laneWidthFt * speedMph : (laneWidthFt * speedMph * speedMph) / 60;
}

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

// MUTCD Table 6H-2: Advance Warning Sign Spacing
// Uses both speed AND terrain/functional class to determine classification
function getABCSpacing(speedMph: number, terrain?: string, funcClass?: string): { a: number; b: number; c: number; classification: string } {
  // Expressway/Freeway (Interstates, divided highways with FC 1-2)
  const fcCode = funcClass ? parseInt(funcClass) || 99 : 99;
  if (fcCode <= 2 || speedMph >= 65) return { a: 1000, b: 1500, c: 2640, classification: 'Expressway/Freeway' };
  // Rural: terrain is mountainous/rolling OR functional class is arterial (3-4) outside urban areas
  const isRural = terrain && /mountainous|rolling/i.test(terrain);
  if (isRural || (fcCode <= 4 && speedMph >= 45)) return { a: 500, b: 500, c: 500, classification: 'Rural' };
  // Urban High Speed
  if (speedMph > 40) return { a: 350, b: 350, c: 350, classification: 'Urban (High Speed)' };
  // Urban Low Speed
  return { a: 100, b: 100, c: 100, classification: 'Urban (Low Speed)' };
}

// MUTCD 11th Edition Table 6C-2: Longitudinal Buffer Space
// Based on stopping sight distance, NOT advance warning spacing
function getBufferSpaceFt(speedMph: number): number {
  if (speedMph <= 20) return 115;
  if (speedMph <= 25) return 155;
  if (speedMph <= 30) return 200;
  if (speedMph <= 35) return 250;
  if (speedMph <= 40) return 305;
  if (speedMph <= 45) return 360;
  if (speedMph <= 50) return 425;
  if (speedMph <= 55) return 495;
  if (speedMph <= 60) return 570;
  if (speedMph <= 65) return 645;
  return 730; // 70+ mph
}

// MUTCD channelizing device spacing
// Standard: 1V taper, 2V tangent. Flagger tapers: 20 ft max (tight visual block per Fig 6H-10)
function getDeviceSpacing(speedMph: number, taCode = 'TA-10'): { taperSpacingFt: number; tangentSpacingFt: number } {
  if (taCode === 'TA-10') return { taperSpacingFt: 20, tangentSpacingFt: speedMph * 2 };
  return { taperSpacingFt: speedMph, tangentSpacingFt: speedMph * 2 };
}

// Sign size determination: ITD requires 48" on State/US highways regardless of speed
function getSignSize(speedMph: number, roadName: string): string {
  // Route-hierarchy override: State/US highways always get 48" per ITD practice
  if (/\b(US|SH|I|ID|Interstate|Highway|Hwy)[\s-]*\d+/i.test(roadName)) return '48" x 48"';
  // Speed-based fallback per MUTCD
  return speedMph > 45 ? '48" x 48"' : '36" x 36"';
}

// Determine if a cross-street is a state/US highway (needs enhanced treatment)
function isHighway(name: string): boolean {
  return /\b(ID|SH|US|I|SR|State Hwy|Highway|Hwy|Interstate)[\s-]*\d+/i.test(name);
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
  const y0 = 720;
  doc.lineWidth(1).strokeColor('black');
  doc.rect(20, y0, 1184, 60).stroke();

  doc.moveTo(200, y0).lineTo(200, y0 + 60).stroke();
  doc.moveTo(350, y0).lineTo(350, y0 + 60).stroke();
  doc.moveTo(600, y0).lineTo(600, y0 + 60).stroke();
  doc.moveTo(800, y0).lineTo(800, y0 + 60).stroke();
  doc.moveTo(1050, y0).lineTo(1050, y0 + 60).stroke();

  doc.moveTo(200, y0 + 20).lineTo(350, y0 + 20).stroke();
  doc.moveTo(200, y0 + 40).lineTo(350, y0 + 40).stroke();
  doc.moveTo(1050, y0 + 20).lineTo(1204, y0 + 20).stroke();
  doc.moveTo(1050, y0 + 40).lineTo(1204, y0 + 40).stroke();

  doc.fontSize(8).fillColor('black');
  doc.text("REVISIONS", 25, y0 + 5, { width: 170, align: 'center', lineBreak: false });
  doc.text("DESIGNED", 205, y0 + 8, { width: 140, lineBreak: false });
  doc.text("DETAILED", 205, y0 + 28, { width: 140, lineBreak: false });
  doc.text("CHECKED", 205, y0 + 48, { width: 140, lineBreak: false });

  doc.fontSize(10).text("IDAHO TRANSPORTATION DEPARTMENT", 355, y0 + 12, { width: 240, align: 'center', lineBreak: false });
  if (roadName) doc.fontSize(8).text(roadName.toUpperCase(), 355, y0 + 30, { width: 240, align: 'center', lineBreak: false });

  doc.fontSize(9).text("OPERATION", 605, y0 + 5, { width: 190, lineBreak: false });
  doc.fontSize(10).text(operationType.toUpperCase(), 605, y0 + 22, { width: 190, align: 'center', lineBreak: false });

  doc.fontSize(9).text("TEMPORARY TRAFFIC CONTROL PLAN", 805, y0 + 5, { width: 240, align: 'center', lineBreak: false });
  doc.fontSize(10).text("AI-GENERATED TCP", 805, y0 + 28, { width: 240, align: 'center', lineBreak: false });

  doc.fontSize(10).text("ENGLISH", 1055, y0 + 5, { width: 140, lineBreak: false });
  doc.fontSize(8).text("STATE OF IDAHO", 1055, y0 + 28, { width: 140, lineBreak: false });
  doc.text(`SHEET ${sheetNum} OF ${totalSheets}`, 1055, y0 + 48, { width: 140, lineBreak: false });
}

function drawDimLine(doc: Doc, x1: number, x2: number, y: number, text: string) {
  doc.lineWidth(0.5).strokeColor('black');
  doc.moveTo(x1, y).lineTo(x2, y).stroke();
  doc.moveTo(x1, y - 4).lineTo(x1, y + 4).stroke();
  doc.moveTo(x2, y - 4).lineTo(x2, y + 4).stroke();
  doc.fontSize(7).fillColor('black');
  const tw = doc.widthOfString(text);
  doc.text(text, x1 + (x2 - x1) / 2 - tw / 2, y - 9, { lineBreak: false });
}

function drawSignDiamond(doc: Doc, x: number, y: number, code: string, label: string) {
  doc.lineWidth(1).strokeColor('black');
  doc.save().translate(x, y).rotate(45).rect(-12, -12, 24, 24).fillAndStroke('#ffffff', 'black').restore();
  doc.fontSize(7).fillColor('black');
  doc.text(`${code}`, x - 45, y + 22, { width: 90, align: 'center', lineBreak: false });
  doc.fontSize(6).text(label, x - 45, y + 32, { width: 90, align: 'center' });
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
  // Scale lane widths: for tabloid landscape, ~20px per lane looks good
  const lanePixelW = lanes <= 3 ? 25 : lanes <= 5 ? 18 : 14;
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

// ===================================================================
// SHEET: COVER / GENERAL NOTES
// ===================================================================
function drawCoverSheet(doc: Doc, sheetNum: number, totalSheets: number, ctx: DrawContext) {
  doc.addPage({ size: 'tabloid', layout: 'landscape', margin: 0 });

  // Header
  doc.fontSize(20).fillColor('black').text("TEMPORARY TRAFFIC CONTROL PLAN", 0, 40, { align: 'center' });
  doc.fontSize(14).text(ctx.roadName ? ctx.roadName.toUpperCase() : 'IDAHO HIGHWAY', 0, 68, { align: 'center' });
  doc.fontSize(12).text(ctx.operationType.toUpperCase(), 0, 88, { align: 'center' });

  // Project Info Box
  const bx = 50, by = 130, bw = 500, lh = 16;
  doc.lineWidth(1).strokeColor('black').rect(bx, by, bw, 200).stroke();
  doc.fontSize(10).text("PROJECT INFORMATION", bx + 10, by + 8, { underline: true });
  let row = by + 30;
  const info = [
    ['Road:', ctx.roadName || 'Not identified'],
    ['Operation:', ctx.operationType],
    ['Speed Limit:', `${ctx.speedMph} MPH (Work Zone: ${ctx.wzSpeedMph} MPH)`],
    ['Lane Width:', `${ctx.laneWidthFt} ft`],
    ['Route Distance:', ctx.routeDistanceFt > 0 ? `${ctx.routeDistanceFt.toLocaleString()} ft (${(ctx.routeDistanceFt / 5280).toFixed(1)} mi)` : 'N/A'],
    ['Start:', ctx.startCoords ? `${ctx.startCoords.lat.toFixed(5)}, ${ctx.startCoords.lng.toFixed(5)}` : 'N/A'],
    ['End:', ctx.endCoords ? `${ctx.endCoords.lat.toFixed(5)}, ${ctx.endCoords.lng.toFixed(5)}` : 'N/A'],
    ['Channelizing:', ctx.blueprint.taper.device_type],
    ['Lane Configuration:', ctx.totalLanes > 0 ? `${ctx.totalLanes} lanes${ctx.hasTWLTL ? ' (with center turn lane)' : ''}${ctx.isDivided ? ' (divided)' : ''}` : 'Unknown — verify on-site'],
    ['Typical Application:', `${ctx.taCode} — ${ctx.taDescription}`],
    ['Cross-Streets:', ctx.crossStreets.length > 0 ? ctx.crossStreets.map(c => c.name).join(', ') : 'None detected'],
  ];
  doc.fontSize(8);
  for (const [label, value] of info) {
    doc.font('Helvetica-Bold').text(label!, bx + 10, row, { continued: true, lineBreak: false });
    doc.font('Helvetica').text(` ${value}`, { lineBreak: false });
    row += lh;
  }

  // Sheet Index
  const ix = 600, iy = 130;
  doc.lineWidth(1).rect(ix, iy, 400, 200).stroke();
  doc.font('Helvetica-Bold').fontSize(10).text("SHEET INDEX", ix + 10, iy + 8, { underline: true });
  doc.font('Helvetica').fontSize(8);
  const sheetNames = [
    'Cover Sheet & General Notes',
    `Typical Application (${ctx.taCode})`,
    'Site-Specific Work Zone Layout',
    ...ctx.crossStreets.map(cs => `Intersection Detail: ${cs.name}`),
    'Sign Schedule & Quantities',
  ];
  sheetNames.forEach((name, i) => {
    doc.text(`Sheet ${i + 1}: ${name}`, ix + 10, iy + 30 + i * 14, { lineBreak: false });
  });

  // General Notes
  const ny = 360;
  doc.lineWidth(1).rect(50, ny, 1124, 340).stroke();
  doc.font('Helvetica-Bold').fontSize(10).text("GENERAL NOTES", 60, ny + 8, { underline: true });
  doc.font('Helvetica').fontSize(7);
  const notes = [
    '1. All temporary traffic control shall conform to the MUTCD 11th Edition (Dec 2023) and Idaho Supplementary provisions.',
    '2. All work shall comply with ITD Standard Specifications Section 626 — Temporary Traffic Control.',
    '3. The Contractor shall correct traffic control deficiencies within one hour of receiving notification (Section 626.03).',
    `4. All warning signs shall be ${getSignSize(ctx.speedMph, ctx.roadName)} diamond. ${isHighway(ctx.roadName) ? 'ITD requires 48" minimum on State/US Highways.' : ''}`,
    '5. Channelizing devices shall be 28-inch minimum height traffic cones for short-term operations, or 42-inch drums for long-term operations.',
    '6. Flagger certification required per ITD TCOC standards. Flaggers shall wear high-visibility safety apparel (ANSI/ISEA 107 Class 3).',
    '7. At night, flagger stations shall be illuminated. Retroreflective devices shall be used on all channelizing devices.',
    '8. Buffer spaces shall be maintained clear of all equipment, workers, and materials.',
    '9. All advance warning signs shall be removed or covered when the work zone is not active.',
    '10. The Contractor shall maintain access to all intersecting roads, driveways, and properties at all times unless otherwise approved.',
    `11. Posted Speed Limit: ${ctx.speedMph} MPH. Work Zone Speed: ${ctx.wzSpeedMph} MPH.`,
    `12. Taper Length: ${ctx.taperLengthFt} ft (${ctx.blueprint.taper.device_type}). Downstream Taper: ${ctx.blueprint.downstream_taper.length_ft} ft.`,
    `13. Minimum longitudinal buffer space: ${getBufferSpaceFt(ctx.speedMph)} ft (per MUTCD 11th Ed. Table 6C-2 for ${ctx.speedMph} MPH).`,
    `14. SINGLE PHASE OPERATION. All work shall be completed within a single traffic control setup.`,
    '',
    'LEGEND: Diamond = Warning Sign | Circle with paddle = Flagger Station | Crosshatch = Work Area | Dashed line = Centerline',
  ];
  let noteY = ny + 28;
  for (const note of notes) {
    doc.text(note, 60, noteY, { width: 1104 });
    noteY += note.length > 100 ? 18 : 11;
    if (noteY > ny + 330) break;
  }

  drawTitleBlock(doc, sheetNum, totalSheets, ctx.operationType, ctx.roadName);
}

// ===================================================================
// SHEET: TYPICAL APPLICATION (TA-10)
// ===================================================================
function drawTASheet(doc: Doc, sheetNum: number, totalSheets: number, ctx: DrawContext) {
  doc.addPage({ size: 'tabloid', layout: 'landscape', margin: 0 });

  const spacing = getABCSpacing(ctx.speedMph, ctx.terrain, ctx.funcClass);
  const bufferFt = getBufferSpaceFt(ctx.speedMph);
  const taTitle = `${ctx.taCode}: ${ctx.taDescription.toUpperCase()}`;
  doc.fontSize(14).fillColor('black').text(`TYPICAL APPLICATION — ${taTitle}`, 0, 25, { align: 'center' });
  doc.fontSize(8).text(`MUTCD 11th Edition | ${spacing.classification} | A=${spacing.a}' B=${spacing.b}' C=${spacing.c}' | Buffer: ${bufferFt}' min (Table 6C-2)`, 0, 44, { align: 'center' });
  if (ctx.totalLanes > 0) {
    doc.fontSize(7).text(`${ctx.totalLanes}-lane road${ctx.hasTWLTL ? ' with center turn lane' : ''}${ctx.isDivided ? ' (divided)' : ''}`, 0, 56, { align: 'center' });
  }

  const roadCL = 355;
  const roadL = 30, roadR = 1194;
  const isTwoWayFlagger = ctx.taCode === 'TA-10';
  const isMultiLaneClosure = ['TA-30', 'TA-31', 'TA-33', 'TA-35'].includes(ctx.taCode);
  const isShoulder = ['TA-22', 'TA-23'].includes(ctx.taCode);

  // Zone boundaries adapt based on TA type
  // Multi-lane/divided: no opposing warning area (opposing traffic unaffected)
  // Shoulder: shorter taper, no lane closure
  const zones = isTwoWayFlagger ? {
    priWarningStart: 40, priWarningEnd: 280,
    transitionStart: 280, transitionEnd: 355,
    bufferStart: 355, bufferEnd: 420,
    activityStart: 420, activityEnd: 630,
    dnBufferStart: 630, dnBufferEnd: 695,
    dnTransitionStart: 695, dnTransitionEnd: 740,
    terminationStart: 740, terminationEnd: 780,
    oppWarningStart: 780, oppWarningEnd: 1180,
  } : {
    // Multi-lane/shoulder: single-direction layout — more room for signs + longer taper
    priWarningStart: 40, priWarningEnd: 340,
    transitionStart: 340, transitionEnd: 500,  // Longer merging taper
    bufferStart: 500, bufferEnd: 560,
    activityStart: 560, activityEnd: 820,
    dnBufferStart: 820, dnBufferEnd: 860,
    dnTransitionStart: 860, dnTransitionEnd: 920, // Downstream taper
    terminationStart: 920, terminationEnd: 980,
    oppWarningStart: 980, oppWarningEnd: 1180, // END ROAD WORK area
  };

  // Roadway — lane-aware drawing
  const road = drawRoadway(doc, roadL, roadR, roadCL, ctx);
  const roadY1 = road.topEdge;
  const roadY2 = road.bottomEdge;

  // Zone labels
  doc.fontSize(6).fillColor('#333');
  const zoneLabelY = roadY1 - 45;
  doc.lineWidth(0.5).strokeColor('#999');

  const drawZoneLabel = (x1: number, x2: number, label1: string, label2?: string) => {
    doc.rect(x1, zoneLabelY, x2 - x1, 35).stroke();
    if (label2) {
      doc.text(label1, x1 + 2, zoneLabelY + 3, { width: x2 - x1 - 4, align: 'center', lineBreak: false });
      doc.text(label2, x1 + 2, zoneLabelY + 12, { width: x2 - x1 - 4, align: 'center', lineBreak: false });
    } else {
      doc.text(label1, x1 + 2, zoneLabelY + 8, { width: x2 - x1 - 4, align: 'center', lineBreak: false });
    }
  };

  drawZoneLabel(zones.priWarningStart, zones.priWarningEnd, 'ADVANCE', 'WARNING AREA');
  drawZoneLabel(zones.transitionStart, zones.transitionEnd, isTwoWayFlagger ? 'TRANSITION' : 'MERGING TAPER');
  drawZoneLabel(zones.bufferStart, zones.bufferEnd, 'BUFFER');
  drawZoneLabel(zones.activityStart, zones.activityEnd, 'ACTIVITY AREA');
  drawZoneLabel(zones.dnBufferStart, zones.dnBufferEnd, isTwoWayFlagger ? 'BUFFER' : 'BUFFER');
  drawZoneLabel(zones.dnTransitionStart, zones.dnTransitionEnd, isTwoWayFlagger ? 'TRANS.' : 'DN TAPER');
  drawZoneLabel(zones.terminationStart, zones.terminationEnd, 'TERM.');
  if (isTwoWayFlagger) {
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
      doc.circle(cx, cy, 2.5).fillAndStroke('orange', 'black');
    }
    // Work area fills opposing lane
    drawCrosshatch(doc, zones.activityStart, roadCL + 3, zones.activityEnd, roadY2 - 3);
    // Downstream taper
    doc.moveTo(zones.dnTransitionStart, roadCL + 3).lineTo(zones.dnTransitionEnd, roadY2).stroke();
    for (let i = 0; i <= 5; i++) {
      const cx = zones.dnTransitionStart + (i / 5) * (zones.dnTransitionEnd - zones.dnTransitionStart);
      const cy = roadCL + 3 + (i / 5) * (roadY2 - roadCL - 3);
      doc.circle(cx, cy, 2.5).fillAndStroke('orange', 'black');
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
      doc.circle(cx, cy, 2.5).fillAndStroke('orange', 'black');
    }
    // Work area in closed lane
    drawCrosshatch(doc, zones.activityStart, closedLaneTop, zones.activityEnd, closedLaneBot - 3);
    // Channelizing devices along tangent (closed lane boundary)
    doc.lineWidth(0.5).strokeColor('black');
    const tangentSpacing = Math.max(40, ctx.speedMph * 2);
    for (let x = zones.activityStart; x <= zones.activityEnd; x += tangentSpacing) {
      doc.circle(x, closedLaneTop, 2).fillAndStroke('orange', 'black');
    }
    // Downstream taper (shorter, shifts back to right)
    doc.lineWidth(1);
    doc.moveTo(zones.dnTransitionStart, closedLaneTop).lineTo(zones.dnTransitionEnd, closedLaneBot).stroke();
    for (let i = 0; i <= 5; i++) {
      const cx = zones.dnTransitionStart + (i / 5) * (zones.dnTransitionEnd - zones.dnTransitionStart);
      const cy = closedLaneTop + (i / 5) * (closedLaneBot - closedLaneTop);
      doc.circle(cx, cy, 2.5).fillAndStroke('orange', 'black');
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
      doc.circle(cx, cy, 2).fillAndStroke('orange', 'black');
    }
  }

  // Work area label (shared)
  const waLabelY = isShoulder ? roadY2 + 5 : (isTwoWayFlagger ? roadCL + 17 : roadCL + 10);
  const waX1 = zones.activityStart;
  const waX2 = zones.activityEnd;
  doc.save();
  const waW = doc.widthOfString("WORK AREA");
  doc.rect(waX1 + (waX2 - waX1) / 2 - waW / 2 - 3, waLabelY - 2, waW + 6, 12).fill('white');
  doc.restore();
  doc.fillColor('black').fontSize(8).text("WORK AREA", waX1, waLabelY, { width: waX2 - waX1, align: 'center', lineBreak: false });

  // END ROAD WORK sign
  doc.lineWidth(0.5).strokeColor('black');
  doc.rect(zones.terminationEnd - 20, roadY2 + 10, 30, 20).stroke();
  doc.fontSize(4).fillColor('black').text('G20-2', zones.terminationEnd - 18, roadY2 + 13, { lineBreak: false });
  doc.text('END ROAD', zones.terminationEnd - 18, roadY2 + 19, { lineBreak: false });
  doc.text('WORK', zones.terminationEnd - 18, roadY2 + 25, { lineBreak: false });

  // === SHARED: Signs, dimensions, notes ===

  // Primary approach signs
  const priSigns = ctx.blueprint.primary_approach;
  const priCount = priSigns.length;
  const priStep = priCount > 1 ? (zones.priWarningEnd - zones.priWarningStart - 40) / (priCount - 1) : 0;
  priSigns.forEach((sign, i) => {
    const x = zones.priWarningStart + 20 + i * priStep;
    drawSignDiamond(doc, x, roadY2 + 70, sign.sign_code, sign.label);
    if (i < priCount - 1) {
      drawDimLine(doc, x, zones.priWarningStart + 20 + (i + 1) * priStep, roadY2 + 52, `${sign.distance_ft} FT`);
    }
  });

  // Opposing/downstream signs
  if (isTwoWayFlagger) {
    // Two-way: opposing approach signs above the road
    const oppSigns = ctx.blueprint.opposing_approach;
    const oppCount = oppSigns.length;
    const oppStep = oppCount > 1 ? (zones.oppWarningEnd - zones.oppWarningStart - 40) / (oppCount - 1) : 0;
    oppSigns.forEach((sign, i) => {
      const x = zones.oppWarningStart + 20 + i * oppStep;
      drawSignDiamond(doc, x, roadY1 - 110, sign.sign_code, sign.label);
      if (i < oppCount - 1) {
        drawDimLine(doc, x, zones.oppWarningStart + 20 + (i + 1) * oppStep, roadY1 - 80, `${sign.distance_ft} FT`);
      }
    });
  }

  // Speed signs
  if (ctx.speedMph !== ctx.wzSpeedMph) {
    doc.lineWidth(0.5).strokeColor('black');
    const rsX = zones.transitionStart - 50;
    doc.rect(rsX - 12, roadY2 + 60, 24, 24).stroke();
    doc.fontSize(3.5).fillColor('black');
    doc.text('W3-5', rsX - 10, roadY2 + 64, { lineBreak: false });
    doc.text('REDUCED', rsX - 10, roadY2 + 70, { lineBreak: false });
    doc.text('SPEED', rsX - 10, roadY2 + 75, { lineBreak: false });
    const slX = zones.bufferStart;
    doc.rect(slX - 8, roadY2 + 60, 16, 24).stroke();
    doc.fontSize(3.5).text('R2-1', slX - 6, roadY2 + 64, { lineBreak: false });
    doc.fontSize(6).text(`${ctx.wzSpeedMph}`, slX - 6, roadY2 + 72, { lineBreak: false });
  }

  // Dimension lines
  const dimY = roadY2 + 145;
  const taperLabel = isTwoWayFlagger ? `FLAGGER TAPER: ${ctx.taperLengthFt} FT` : `MERGING TAPER: ${ctx.taperLengthFt} FT`;
  drawDimLine(doc, zones.transitionStart, zones.transitionEnd, dimY, taperLabel);
  drawDimLine(doc, zones.bufferStart, zones.bufferEnd, dimY, `BUFFER: ${bufferFt} FT`);
  drawDimLine(doc, zones.activityStart, zones.activityEnd, dimY, 'WORK AREA');
  if (isTwoWayFlagger) {
    drawDimLine(doc, zones.dnBufferStart, zones.dnBufferEnd, dimY, `BUFFER: ${bufferFt} FT`);
  }
  drawDimLine(doc, zones.dnTransitionStart, zones.dnTransitionEnd, dimY, `DN TAPER: ${ctx.blueprint.downstream_taper.length_ft} FT`);

  // Direction arrows
  doc.fillColor('#444').fontSize(7);
  doc.text("PRIMARY APPROACH >>>", 40, dimY + 8, { lineBreak: false });
  if (isTwoWayFlagger) {
    doc.text("<<< OPPOSING APPROACH", 1040, roadY1 - 100, { lineBreak: false });
  } else {
    doc.text("TRAFFIC FLOW >>>", roadL + 5, roadY1 + 3, { lineBreak: false });
  }

  // Cross-streets
  if (ctx.crossStreets.length > 0) {
    doc.fillColor('black').fontSize(7);
    doc.text(`INTERSECTIONS WITHIN WORK ZONE: ${ctx.crossStreets.map(c => c.name).join(', ')}`, 40, dimY + 22, { width: 1140, lineBreak: false });
    doc.fontSize(6).text('See intersection detail sheets for cross-street signage requirements.', 40, dimY + 34, { lineBreak: false });
  }

  // Notes box
  doc.lineWidth(0.5).rect(40, 610, 400, 90).stroke();
  doc.fontSize(7).fillColor('black');
  doc.font('Helvetica-Bold').text('NOTES:', 45, 615);
  doc.font('Helvetica').fontSize(6);
  doc.text(`Speed: ${ctx.speedMph} MPH | WZ Speed: ${ctx.wzSpeedMph} MPH | Lanes: ${ctx.totalLanes || '2'} | Width: ${ctx.laneWidthFt} ft`, 45, 628, { width: 390 });
  doc.text(`Taper: ${ctx.taperLengthFt} ft ${isTwoWayFlagger ? '(flagger)' : '(merging)'} | DN Taper: ${ctx.blueprint.downstream_taper.length_ft} ft | ${ctx.blueprint.taper.device_type}`, 45, 640, { width: 390 });
  doc.text(`Route: ${ctx.routeDistanceFt > 0 ? ctx.routeDistanceFt.toLocaleString() + ' ft' : 'N/A'} | Spacing: A=${spacing.a}' B=${spacing.b}' C=${spacing.c}' | Buffer: ${bufferFt}' (6C-2)`, 45, 652, { width: 390 });
  if (isMultiLaneClosure) doc.text('Arrow board (Type A) required at merging taper approach.', 45, 664, { width: 390 });

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
    doc.fillColor('black').fontSize(7);
    const ly = imgY + imgH + 8;
    doc.text(`START (S): ${ctx.startCoords.lat.toFixed(5)}, ${ctx.startCoords.lng.toFixed(5)}`, imgX, ly, { width: imgW / 2, align: 'left' });
    doc.text(`END (E): ${ctx.endCoords.lat.toFixed(5)}, ${ctx.endCoords.lng.toFixed(5)}`, imgX + imgW / 2, ly, { width: imgW / 2, align: 'right' });
    if (ctx.routeDistanceFt > 0) {
      doc.text(`Route: ${ctx.routeDistanceFt.toLocaleString()} ft (${(ctx.routeDistanceFt / 5280).toFixed(1)} mi)${ctx.roadName ? ' | ' + ctx.roadName : ''}`, imgX, ly + 12, { width: imgW, align: 'center' });
    }
  }

  // Cross-street list
  if (ctx.crossStreets.length > 0) {
    doc.fontSize(8).fillColor('black');
    const csY = imgY + imgH + 40;
    doc.font('Helvetica-Bold').text('INTERSECTIONS WITHIN WORK ZONE:', imgX, csY);
    doc.font('Helvetica').fontSize(7);
    ctx.crossStreets.forEach((cs, i) => {
      doc.text(`${i + 1}. ${cs.name} — See Sheet ${4 + i} for detail`, imgX + 10, csY + 14 + i * 11, { lineBreak: false });
    });
  }

  doc.fillColor('#666').fontSize(6);
  doc.text("Route polyline and markers provided by Google Maps Platform. Verify on-site before construction.", imgX, imgY + imgH + 95, { width: imgW, align: 'center' });

  drawTitleBlock(doc, sheetNum, totalSheets, ctx.operationType, ctx.roadName);
}

// ===================================================================
// SHEET: INTERSECTION DETAIL
// ===================================================================
// ===================================================================
// SHEET: INTERSECTION DETAIL (ENGINEERING-GRADE GEOMETRY)
// ===================================================================
function drawIntersectionSheet(doc: Doc, sheetNum: number, totalSheets: number, ctx: DrawContext, cs: CrossStreet) {
  doc.addPage({ size: 'tabloid', layout: 'landscape', margin: 0 });

  doc.fontSize(14).fillColor('black').text(`INTERSECTION DETAIL: ${cs.name.toUpperCase()}`, 0, 25, { align: 'center' });
  doc.fontSize(9).text(`${ctx.roadName || 'Main Road'} at ${cs.name} — Approximate Position: ${Math.round(cs.position * 100)}% along route`, 0, 45, { align: 'center' });

  const cx = 612, cy = 340;
  const mainLen = 450, crossLen = 200;
  const geo = cs.geometry || { type: '4-way', hasSignal: false, hasStopSign: false, turnLanes: false, approachAngle: 0, legs: 4 };

  const hasNorth = geo.type === 'T-north' || geo.type === '4-way' || geo.type === 'Y' || !geo.type.startsWith('T-');
  const hasSouth = geo.type === 'T-south' || geo.type === '4-way' || geo.type === 'Y' || !geo.type.startsWith('T-');

  // Geometry type label
  const geoLabel = geo.type === '4-way' ? '4-WAY INTERSECTION' :
    geo.type.startsWith('T-') ? `T-INTERSECTION (${geo.type.replace('T-', '').toUpperCase()})` :
    geo.type === 'Y' ? 'Y-INTERSECTION' : geo.type === 'roundabout' ? 'ROUNDABOUT' : 'INTERSECTION';
  doc.fontSize(8).fillColor('#666').text(geoLabel, 0, 60, { align: 'center' });

  // Main road (horizontal)
  const intRoad = drawRoadway(doc, cx - mainLen / 2, cx + mainLen / 2, cy, ctx);
  const mainHW = intRoad.totalPixelH / 2;
  const crossHW = geo.turnLanes ? 30 : 20; // Wider cross street if turn lanes exist
  const R = isHighway(cs.name) ? 35 : 20; // Corner radius (larger for state routes)

  // 1. MASKING: Erase the mainline edge lines where the cross streets enter
  doc.lineWidth(4).strokeColor('#ffffff');
  if (hasNorth) doc.moveTo(cx - crossHW - R, cy - mainHW).lineTo(cx + crossHW + R, cy - mainHW).stroke();
  if (hasSouth) doc.moveTo(cx - crossHW - R, cy + mainHW).lineTo(cx + crossHW + R, cy + mainHW).stroke();

  // MASKING: Erase the mainline centerlines inside the intersection box
  if (hasNorth || hasSouth) {
    doc.rect(cx - crossHW - 2, cy - mainHW + 2, (crossHW * 2) + 4, (mainHW * 2) - 4).fill('#ffffff');
  }

  // 2. DRAW CURB RETURNS & CROSS STREET EDGES
  doc.lineWidth(2).strokeColor('black');
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

  // 3. DRAW CROSS STREET CENTERLINES
  doc.lineWidth(1).strokeColor('#CC9900');
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
    doc.lineWidth(3).strokeColor('black');
    if (hasNorth) doc.moveTo(cx - crossHW, cy - mainHW - R).lineTo(cx, cy - mainHW - R).stroke();
    if (hasSouth) doc.moveTo(cx, cy + mainHW + R).lineTo(cx + crossHW, cy + mainHW + R).stroke();

    doc.lineWidth(1.5).dash(4, { space: 4 }).strokeColor('#666');
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

  // 6. ADVANCE WARNING SIGNS (Standard US Right-Hand Shoulder Placement)
  // North Leg (traffic moving down): Right shoulder is on the left (-X)
  if (hasNorth) drawSignDiamond(doc, cx - crossHW - 35, cy - crossLen + 40, 'W20-1', 'ROAD WORK\nAHEAD');

  // South Leg (traffic moving up): Right shoulder is on the right (+X)
  if (hasSouth) drawSignDiamond(doc, cx + crossHW + 35, cy + crossLen - 40, 'W20-1', 'ROAD WORK\nAHEAD');

  // Determine intersection significance and notes
  const isHwy = isHighway(cs.name);
  const isDriveway = /chevron|gas|station|driveway|parking|lot/i.test(cs.name) && !/state\s*park|national|public|forest|county/i.test(cs.name);
  const intType = isHwy ? 'STATE/US HIGHWAY INTERSECTION' : isDriveway ? 'COMMERCIAL ACCESS POINT' : 'LOCAL ROAD INTERSECTION';
  doc.fontSize(8).fillColor(isHwy ? '#cc0000' : '#333');
  doc.text(`Classification: ${intType}`, cx - mainLen / 2, cy + crossLen + 15, { width: mainLen, align: 'center', lineBreak: false });

  // Notes for this intersection
  const noteX = 50, noteY = 560;
  doc.lineWidth(0.5).rect(noteX, noteY, 530, 120).stroke();
  doc.font('Helvetica-Bold').fontSize(8).fillColor('black').text('INTERSECTION TRAFFIC CONTROL NOTES:', noteX + 10, noteY + 8);
  doc.font('Helvetica').fontSize(6.5);

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
  intNotes.forEach((n, i) => doc.text(n, noteX + 10, noteY + 22 + i * 13, { width: 510 }));

  // Sign detail for this intersection
  doc.lineWidth(0.5).rect(600, noteY, 400, 120).stroke();
  doc.font('Helvetica-Bold').fontSize(8).text('SIGNS REQUIRED AT THIS INTERSECTION:', 610, noteY + 8);
  doc.font('Helvetica').fontSize(7);
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
  const rowH = 20;

  // Header row
  doc.lineWidth(1).strokeColor('black');
  let hx = tx;
  doc.rect(tx, ty, colW.reduce((a, b) => a + b, 0), rowH).fillAndStroke('#e0e0e0', 'black');
  doc.fillColor('black').font('Helvetica-Bold').fontSize(8);
  headers.forEach((h, i) => {
    doc.text(h, hx + 4, ty + 6, { width: colW[i]! - 8, lineBreak: false });
    hx += colW[i]!;
  });

  // Data rows
  doc.font('Helvetica').fontSize(7);
  signList.forEach((sign, rowIdx) => {
    const ry = ty + rowH + rowIdx * rowH;
    let rx = tx;
    const bgColor = rowIdx % 2 === 0 ? '#f9f9f9' : '#ffffff';
    doc.rect(tx, ry, colW.reduce((a, b) => a + b, 0), rowH).fillAndStroke(bgColor, '#ccc');
    doc.fillColor('black');
    const vals = [sign.code, sign.description, sign.size, String(sign.qty), sign.location];
    vals.forEach((v, i) => {
      doc.text(v, rx + 4, ry + 6, { width: colW[i]! - 8, lineBreak: false });
      rx += colW[i]!;
    });
  });

  // Totals
  const totalY = ty + rowH + signList.length * rowH + 20;
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
  const spacing = getABCSpacing(speedMph, terrain, funcClass);
  const deviceSpacing = getDeviceSpacing(speedMph, taCode);
  const workZoneFt = routeDistanceFt > 0 ? Math.min(routeDistanceFt, 2000) : 400;

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
): Promise<void> {
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

  // === TA SELECTION based on lane count + operation type + functional class ===
  const fcCode = funcClass ? parseInt(funcClass) || 99 : 99;
  const isInterstate = fcCode <= 2;
  const isDivided = fcCode <= 3 && totalLanes >= 4;
  // Infer median type: 5 lanes = TWLTL (2+turn+2), 4 lanes could be divided or undivided
  const hasTWLTL = totalLanes === 3 || totalLanes === 5;
  const isMultiLane = totalLanes >= 4 || (totalLanes === 3 && !hasTWLTL);

  let taCode: string;
  let taDescription: string;
  if (operationType === 'Shoulder Work') {
    taCode = isMultiLane ? 'TA-23' : 'TA-22';
    taDescription = isMultiLane ? 'Shoulder Work on Multi-Lane Road' : 'Shoulder Work on Two-Lane Road';
  } else if (operationType === 'Median Crossover') {
    taCode = 'TA-18';
    taDescription = 'Median Crossover';
  } else if (isInterstate) {
    taCode = 'TA-35';
    taDescription = 'Lane Closure on Interstate/Freeway';
  } else if (isDivided) {
    taCode = 'TA-33';
    taDescription = 'Lane Closure on Divided Highway';
  } else if (isMultiLane) {
    taCode = hasTWLTL ? 'TA-31' : 'TA-30';
    taDescription = hasTWLTL ? 'Lane Closure with Center Turn Lane' : 'Lane Closure on Multi-Lane Road';
  } else {
    // 2-lane road
    taCode = 'TA-10';
    taDescription = 'Lane Closure Using Flaggers (Two-Lane Road)';
  }
  console.log(`[cadGenerator] TA Selection: ${taCode} (${taDescription}) | Lanes: ${totalLanes} | FC: ${fcCode} | Op: ${operationType}`);

  // Taper length determination
  let taperLengthFt: number;
  if (taCode === 'TA-10') {
    // MUTCD 6C.08: One-Lane Two-Way Traffic Taper = 50 ft min, 100 ft max
    const aiTaper = blueprint.taper.length_ft || 100;
    taperLengthFt = Math.min(Math.max(aiTaper, 50), 100);
  } else if (['TA-22', 'TA-23'].includes(taCode)) {
    // Shoulder taper = 1/3 of merging taper
    taperLengthFt = Math.round(calcTaperLength(laneWidthFt, speedMph) / 3);
  } else {
    // TA-30/31/33/35: Standard merging taper (L=WS or L=WS²/60)
    // Always use formula — PE may have provided a flagger taper by mistake
    taperLengthFt = calcTaperLength(laneWidthFt, speedMph);
  }

  // === SIGN CORRECTION based on TA selection ===
  // PE Agent assumes TA-10 (flaggers) — override signs for multi-lane TAs
  if (['TA-30', 'TA-31', 'TA-33', 'TA-35'].includes(taCode)) {
    // Replace W20-7a FLAGGER AHEAD with W20-5 RIGHT LANE CLOSED AHEAD
    // Replace W20-4 ONE LANE ROAD AHEAD with W20-5 RIGHT LANE CLOSED AHEAD (multi-lane)
    for (const signs of [blueprint.primary_approach, blueprint.opposing_approach]) {
      for (const sign of signs) {
        if (sign.sign_code === 'W20-7a') {
          sign.sign_code = 'W20-5';
          sign.label = 'RIGHT LANE CLOSED AHEAD';
        }
        if (sign.sign_code === 'W20-4') {
          sign.sign_code = 'W20-5';
          sign.label = 'RIGHT LANE CLOSED AHEAD';
        }
      }
    }
    // For multi-lane, opposing approach gets same signs (same direction closure)
    // but if TA-33/35 (divided), opposing traffic is unaffected — clear opposing signs
    if (['TA-33', 'TA-35'].includes(taCode)) {
      blueprint.opposing_approach = []; // Opposing traffic unaffected on divided highway
    }
  } else if (['TA-22', 'TA-23'].includes(taCode)) {
    // Shoulder work: replace lane closure signs with shoulder work signs
    for (const signs of [blueprint.primary_approach, blueprint.opposing_approach]) {
      for (const sign of signs) {
        if (sign.sign_code === 'W20-7a') {
          sign.sign_code = 'W21-5b';
          sign.label = 'SHOULDER WORK AHEAD';
        }
        if (sign.sign_code === 'W20-4') {
          sign.sign_code = 'W21-5';
          sign.label = 'SHOULDER CLOSED AHEAD';
        }
      }
    }
  }

  if (routeDistanceFt === 0 && startCoords && endCoords) {
    routeDistanceFt = Math.round(haversineDistanceFt(startCoords, endCoords));
  }

  // Sanitize cross-streets array
  if (!crossStreets || !Array.isArray(crossStreets)) crossStreets = [];

  // Filter out cross-streets that match the main road itself, then limit to 6
  const mainRoadNum = extractRoadNumber(roadName);
  const filteredCrossStreets = crossStreets.slice(0, 10).filter(cs => {
    const csNum = extractRoadNumber(cs.name);
    // Remove if the cross-street's road number matches the main road
    if (mainRoadNum && csNum && csNum === mainRoadNum) return false;
    // Remove if the cross-street name is essentially the main road name
    const csNorm = cs.name.toLowerCase().replace(/[^a-z0-9]/g, '');
    const mainNorm = roadName.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (mainNorm && (csNorm === mainNorm || csNorm.includes(mainNorm) || mainNorm.includes(csNorm))) return false;
    return true;
  }).slice(0, 6);

  const totalSheets = 3 + filteredCrossStreets.length + 1;

  const ctx: DrawContext = {
    blueprint, staticMapBase64, startCoords, endCoords,
    speedMph, wzSpeedMph, laneWidthFt, operationType,
    routeDistanceFt, roadName, crossStreets: filteredCrossStreets, taperLengthFt,
    terrain, funcClass, mainRoadNumber: mainRoadNum, taCode, taDescription,
    totalLanes, hasTWLTL, isDivided, isMultiLane,
  };

  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'tabloid', layout: 'landscape', margin: 0, autoFirstPage: false });
      const pdfStream = fs.createWriteStream(pdfPath);

      pdfStream.on('finish', () => {
        try {
          generateDXF(blueprint, dxfPath, speedMph, laneWidthFt, operationType, startCoords, routeDistanceFt, roadName, filteredCrossStreets, terrain, funcClass, totalLanes, taCode, taperLengthFt, wzSpeedMph);
          console.log(`[cadGenerator] Complete. ${totalSheets} sheets. PDF: ${pdfPath} | DXF: ${dxfPath}`);
          resolve();
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

      // Sheet 2: Typical Application (TA-10)
      drawTASheet(doc, sheetNum++, totalSheets, ctx);

      // Sheet 3: Site-Specific Layout (Satellite Overlay)
      drawSiteLayoutSheet(doc, sheetNum++, totalSheets, ctx);

      // Sheets 4+: Intersection Details (one per cross-street)
      for (const cs of filteredCrossStreets) {
        drawIntersectionSheet(doc, sheetNum++, totalSheets, ctx, cs);
      }

      // Last Sheet: Sign Schedule
      drawSignScheduleSheet(doc, sheetNum++, totalSheets, ctx);

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
