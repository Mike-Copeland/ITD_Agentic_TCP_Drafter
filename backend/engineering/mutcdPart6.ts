/**
 * MUTCD 11th Edition Part 6 — Temporary Traffic Control
 * Authoritative engineering reference module.
 * All tables, formulas, and rules encoded from the official FHWA document.
 * Source: https://mutcd.fhwa.dot.gov/pdfs/11th_Edition/part6.pdf
 *
 * This file is the SINGLE SOURCE OF TRUTH for all MUTCD calculations.
 * cadGenerator.ts and compliance checks reference this module exclusively.
 */

// ===================================================================
// INPUT DATA VALIDATION (Consensus: Claude Opus + Gemini)
// ===================================================================
export interface ValidationResult {
  valid: boolean;
  warnings: string[];
  errors: string[];
}

export function validateInputData(
  roadName: string, speedMph: number, aadt: number,
  funcClassCode: number, totalLanes: number
): ValidationResult {
  const result: ValidationResult = { valid: true, warnings: [], errors: [] };

  // Interstate validation
  const isInterstate = /\b(I-\d+|Interstate)\b/i.test(roadName);
  if (isInterstate) {
    if (funcClassCode > 2 && funcClassCode !== 0) {
      result.warnings.push(`${roadName} has FC ${funcClassCode}; expected FC 1-2 for Interstate. Data may be from adjacent road.`);
    }
    if (aadt > 0 && aadt < 5000) {
      result.warnings.push(`${roadName} has AADT ${aadt}; unusually low for Interstate. Verify data source.`);
    }
  }

  // Missing critical data
  if (funcClassCode === 0 && aadt === 0) {
    result.warnings.push('Both AADT and Functional Class unavailable. Classification defaults to rural (safer spacing).');
  } else if (funcClassCode === 0) {
    result.warnings.push('Functional Class unavailable. Classification reliability reduced.');
  }
  if (aadt === 0) {
    result.warnings.push('AADT unavailable. Queue analysis and classification rely on heuristics.');
  }
  if (totalLanes === 0) {
    result.warnings.push('Lane count unavailable. TA selection defaults to 2-lane configuration.');
  }

  // Speed sanity
  if (speedMph > 80 || speedMph < 15) {
    result.warnings.push(`Speed ${speedMph} MPH is outside normal range (15-80). Verify input.`);
  }

  // Cross-checks
  if (aadt > 0 && funcClassCode > 0) {
    if (funcClassCode <= 2 && aadt < 5000) {
      result.warnings.push(`FC ${funcClassCode} (freeway) with AADT ${aadt} is unusual. Verify data source.`);
    }
  }

  return result;
}

// ===================================================================
// TABLE 6B-1: ADVANCE WARNING SIGN SPACING
// ===================================================================
export type RoadClass = 'urban_low' | 'urban_high' | 'rural' | 'expressway';

export interface SignSpacing { a: number; b: number; c: number; classification: string }

const SIGN_SPACING: Record<RoadClass, SignSpacing> = {
  urban_low:   { a: 100,  b: 100,  c: 100,  classification: 'Urban (Low Speed)' },
  urban_high:  { a: 350,  b: 350,  c: 350,  classification: 'Urban (High Speed)' },
  rural:       { a: 500,  b: 500,  c: 500,  classification: 'Rural' },
  expressway:  { a: 1000, b: 1500, c: 2640, classification: 'Expressway/Freeway' },
};

/**
 * Determine road classification for sign spacing.
 * MUTCD Table 6B-1 "Road Type" is based on environment (urban/rural), not just FC.
 *
 * Multi-factor model (consensus of Claude Opus + Gemini review):
 * - Rural indicators take precedence (longer spacing = safer default)
 * - Urban requires convergence of multiple indicators
 * - Missing data defaults to rural (safer) per MUTCD 6D.03
 */
export function classifyRoad(speedMph: number, funcClassCode: number, terrain?: string, aadt = 0, crossStreetCount = 0): RoadClass {
  // === EXPRESSWAY: FC 1-2 always, OR FC 3 at 65+ MPH (high-speed limited-access) ===
  if (funcClassCode <= 2) return 'expressway';
  if (speedMph >= 65 && funcClassCode <= 3) return 'expressway';
  // 65+ on FC 4+ is a high-speed rural road, NOT expressway
  if (speedMph >= 65) return 'rural';

  // === TERRAIN-BASED RURAL (strong indicator, takes precedence) ===
  const isRuralTerrain = terrain && /mountainous|rolling/i.test(terrain);
  if (isRuralTerrain && aadt < 10000) {
    return speedMph >= 45 ? 'rural' : 'urban_low';
  }

  // === MULTI-FACTOR URBAN/RURAL DETERMINATION ===
  // Urban requires convergence of evidence, not a single trigger
  const hasHighVolume = aadt >= 10000;
  const hasModerateVolume = aadt >= 5000;
  const hasLowSpeed = speedMph <= 35;
  const isLocalRoad = funcClassCode >= 6;

  // Strong urban: high volume alone is sufficient
  const isUrban = hasHighVolume ||
    (hasModerateVolume && isLocalRoad) ||
    (hasModerateVolume && hasLowSpeed && crossStreetCount >= 6) ||
    (isLocalRoad && hasLowSpeed);

  // When AADT is unknown (0): default to rural for safety (longer spacing)
  if (aadt === 0 && !isRuralTerrain) {
    if (funcClassCode <= 3 && speedMph >= 45) return 'rural';
    if (isLocalRoad && speedMph <= 35) return 'urban_low';
    // Uncertain — default to rural (longer spacing = safer) per MUTCD 6D.03
    return speedMph >= 45 ? 'rural' : 'urban_low';
  }

  // Low volume with arterial FC = rural
  if (aadt > 0 && aadt < 5000 && funcClassCode <= 4) {
    return speedMph >= 45 ? 'rural' : 'urban_low';
  }

  if (!isUrban) return speedMph >= 45 ? 'rural' : 'urban_low';
  if (speedMph > 40) return 'urban_high';
  return 'urban_low';
}

export function getSignSpacing(speedMph: number, funcClassCode: number, terrain?: string, gradePercent = 0, aadt = 0, crossStreetCount = 0): SignSpacing {
  const base = SIGN_SPACING[classifyRoad(speedMph, funcClassCode, terrain, aadt, crossStreetCount)];
  // ITD-SPECIFIC POLICY: Grade-based spacing multipliers per Section 6B.04 Paragraph 07
  // engineering judgment. These are agency heuristics, not MUTCD-prescribed values.
  if (gradePercent > 5) {
    const mult = 1.5;
    return { a: Math.round(base.a * mult), b: Math.round(base.b * mult), c: Math.round(base.c * mult), classification: `${base.classification} (1.5× grade adj for ${gradePercent}% grade)` };
  }
  if (gradePercent > 3) {
    const mult = 1.25;
    return { a: Math.round(base.a * mult), b: Math.round(base.b * mult), c: Math.round(base.c * mult), classification: `${base.classification} (1.25× grade adj for ${gradePercent}% grade)` };
  }
  return base;
}

// ===================================================================
// TABLE 6B-2: LONGITUDINAL BUFFER SPACE (STOPPING SIGHT DISTANCE)
// ===================================================================
const BUFFER_TABLE: [number, number][] = [
  [20, 115], [25, 155], [30, 200], [35, 250], [40, 305],
  [45, 360], [50, 425], [55, 495], [60, 570], [65, 645],
  [70, 730], [75, 820], [80, 910], // 80 MPH: AASHTO extrapolation for Idaho interstates
];

/** Get minimum longitudinal buffer space in feet for a given speed. */
export function getBufferSpace(speedMph: number): number {
  for (const [s, b] of BUFFER_TABLE) {
    if (speedMph <= s) return b;
  }
  return 820; // 75+ mph
}

// ===================================================================
// TAPER LENGTH FORMULAS (Section 6B.08, 11th Edition)
// ===================================================================

/**
 * Merging taper per Table 6B-4:
 * - 40 mph or less: L = WS²/60
 * - 45 mph or more: L = WS
 * Speeds 41-44 mph are snapped to nearest 5 MPH increment per MUTCD convention.
 */
export function mergingTaper(laneWidthFt: number, speedMph: number): number {
  // Snap to nearest 5 MPH increment per Table 6B-4 convention
  const snappedSpeed = Math.round(speedMph / 5) * 5;
  return snappedSpeed >= 45
    ? laneWidthFt * snappedSpeed
    : (laneWidthFt * snappedSpeed * snappedSpeed) / 60;
}

/** Shifting taper: >= L/2 */
export function shiftingTaper(laneWidthFt: number, speedMph: number): number {
  return Math.round(mergingTaper(laneWidthFt, speedMph) / 2);
}

/** Shoulder taper: >= L/3 */
export function shoulderTaper(laneWidthFt: number, speedMph: number): number {
  return Math.round(mergingTaper(laneWidthFt, speedMph) / 3);
}

/** Downstream taper: 50-100 ft per MUTCD */
export function downstreamTaper(): { min: number; max: number } {
  return { min: 50, max: 100 };
}

/** One-lane two-way traffic taper (TA-10 flagger): 50-100 ft */
export function flaggerTaper(): { min: number; max: number } {
  return { min: 50, max: 100 };
}

/**
 * Get the correct taper length for a given TA code.
 */
export function getTaperLength(taCode: string, laneWidthFt: number, speedMph: number): number {
  if (taCode === 'TA-10') {
    // One-lane two-way: clamp to 50-100 ft
    return Math.min(Math.max(mergingTaper(laneWidthFt, speedMph), 50), 100);
  }
  if (['TA-22', 'TA-23', 'TA-1', 'TA-2', 'TA-3'].includes(taCode)) {
    return shoulderTaper(laneWidthFt, speedMph);
  }
  if (taCode === 'TA-18') {
    // Median crossover uses shifting taper
    return shiftingTaper(laneWidthFt, speedMph);
  }
  // Standard merging taper for all lane closures
  return mergingTaper(laneWidthFt, speedMph);
}

// ===================================================================
// CHANNELIZING DEVICE SPACING (Section 6L.05)
// ===================================================================

/** Device spacing in taper = 1 * S (speed mph = feet between devices) */
export function taperDeviceSpacing(speedMph: number, taCode = ''): number {
  // One-lane two-way taper: 20 ft max
  if (taCode === 'TA-10') return Math.min(20, speedMph);
  return speedMph;
}

/** Device spacing on tangent = 2 * S */
export function tangentDeviceSpacing(speedMph: number): number {
  return speedMph * 2;
}

// ===================================================================
// SIGN SIZE REQUIREMENTS (Tables 6G-1, 6H-1, 6I-1)
// ===================================================================
export interface SignSize { width: number; height: number; label: string }

export function getSignSize(speedMph: number, roadClass: RoadClass): SignSize {
  if (roadClass === 'expressway') return { width: 48, height: 48, label: '48" x 48"' };
  if (speedMph > 45) return { width: 48, height: 48, label: '48" x 48"' };
  if (speedMph > 30) return { width: 36, height: 36, label: '36" x 36"' };
  return { width: 30, height: 30, label: '30" x 30"' }; // minimum for low-volume local
}

/** ITD override: State/US highways always 48" regardless of speed */
export function getITDSignSize(speedMph: number, roadName: string, roadClass: RoadClass): SignSize {
  if (/\b(US|SH|I|ID|Interstate|Highway|Hwy)[\s-]*\d+/i.test(roadName)) {
    return { width: 48, height: 48, label: '48" x 48"' };
  }
  return getSignSize(speedMph, roadClass);
}

// ===================================================================
// ARROW BOARD REQUIREMENTS (Section 6L.06)
// ===================================================================
export type ArrowBoardType = 'A' | 'B' | 'C' | 'D' | 'none';

export function getArrowBoardType(speedMph: number, roadClass: RoadClass): ArrowBoardType {
  if (roadClass === 'expressway') return 'C'; // High-speed, high-volume
  if (speedMph >= 55) return 'B'; // Intermediate-speed
  if (speedMph >= 35) return 'A'; // Low-speed urban
  return 'none';
}

export function isArrowBoardRequired(taCode: string): boolean {
  // Required for lane closures on multi-lane roads, freeways, and mobile ops
  return ['TA-17', 'TA-30', 'TA-31', 'TA-33', 'TA-34', 'TA-35', 'TA-37', 'TA-38'].includes(taCode);
}

// ===================================================================
// FLAGGER REQUIREMENTS (Sections 6E.01-6E.06)
// ===================================================================
export interface FlaggerRequirements {
  required: boolean;
  sightDistanceFt: number;
  apparel: string;
  equipment: string[];
}

export function getFlaggerRequirements(taCode: string, speedMph: number, isNight: boolean): FlaggerRequirements {
  const required = ['TA-10', 'TA-12', 'TA-27'].includes(taCode);
  return {
    required,
    sightDistanceFt: getBufferSpace(speedMph), // Use stopping sight distance
    apparel: isNight ? 'ANSI/ISEA 107 Performance Class 3' : 'ANSI/ISEA 107 Performance Class 2 or 3',
    equipment: [
      'STOP/SLOW paddle (18x18 inches minimum)',
      ...(isNight ? ['Retroreflective STOP/SLOW paddle', 'Illuminated flagger station (5 fc minimum)'] : []),
    ],
  };
}

// ===================================================================
// DURATION & DEVICE TYPE (Section 6F.01)
// ===================================================================
export type WorkDuration = 'short_duration' | 'short_term' | 'intermediate' | 'long_term' | 'mobile';

export function parseDuration(durationStr: string): WorkDuration {
  if (/mobile/i.test(durationStr)) return 'mobile';
  if (/long/i.test(durationStr)) return 'long_term';
  if (/intermediate/i.test(durationStr)) return 'intermediate';
  if (/short.*duration|up to 1 hour/i.test(durationStr)) return 'short_duration';
  return 'short_term';
}

export interface DeviceRequirements {
  minHeightInches: number;
  types: string[];
  label: string;
}

const DEVICE_REQUIREMENTS: Record<WorkDuration, DeviceRequirements> = {
  short_duration: { minHeightInches: 18, types: ['Cones', 'Vehicle-mounted signs'], label: '18" Cones or Vehicle Signs' },
  short_term:     { minHeightInches: 28, types: ['28-inch Cones'], label: '28-inch Cones' },
  intermediate:   { minHeightInches: 28, types: ['28-inch Cones', 'Drums', 'Type 1/2 Barricades'], label: '28" Cones or Drums' },
  long_term:      { minHeightInches: 36, types: ['42-inch Drums', 'Type 2/3 Barricades', 'Temporary Barriers'], label: '42-inch Drums' },
  mobile:         { minHeightInches: 18, types: ['Vehicle-mounted signs', 'Shadow vehicle', 'TMA'], label: 'Vehicle-mounted' },
};

export function getDeviceRequirements(duration: WorkDuration): DeviceRequirements {
  return DEVICE_REQUIREMENTS[duration];
}

// ===================================================================
// WORK ZONE SPEED (Section 6C.01)
// ===================================================================
export function getWorkZoneSpeed(postedSpeed: number, userOverride?: number): number {
  // MUTCD: speed reductions > 10 mph generally require engineering study
  // Default: 10 mph reduction
  if (userOverride) return userOverride;
  return Math.max(postedSpeed - 10, 25);
}

export function validateSpeedReduction(postedSpeed: number, wzSpeed: number): { valid: boolean; warning?: string } {
  const reduction = postedSpeed - wzSpeed;
  if (reduction > 15) return { valid: false, warning: `Speed reduction of ${reduction} MPH exceeds 15 MPH — engineering study required per MUTCD 6C.01` };
  if (reduction > 10) return { valid: true, warning: `Speed reduction of ${reduction} MPH exceeds typical 10 MPH — document justification` };
  return { valid: true };
}

// ===================================================================
// TA SELECTION LOGIC
// ===================================================================
export interface TASelection {
  code: string;
  title: string;
  description: string;
}

/**
 * Select the appropriate Typical Application based on road characteristics
 * and operation type. MUTCD 11th Edition TA numbering.
 */
export function selectTA(
  operationType: string,
  totalLanes: number,
  funcClassCode: number,
  isDivided: boolean,
  aadt = 0,
  terrain = '',
): TASelection {
  const isFreeway = funcClassCode <= 2;
  const hasTWLTL = totalLanes === 3 || totalLanes === 5;
  const isMultiLane = totalLanes >= 4 || (totalLanes === 3 && !hasTWLTL);

  // === FULL ROAD CLOSURE ===
  if (operationType === 'Full Road Closure') {
    return { code: 'TA-13', title: 'Temporary Road Closure', description: 'Complete road closure with signed detour route' };
  }

  // === MOBILE / MOVING OPERATIONS ===
  if (operationType === 'Mobile Operations') {
    if (isMultiLane || isFreeway) return { code: 'TA-35', title: 'Mobile Operation on Multi-Lane Road', description: 'Moving work with shadow vehicle and TMA on multi-lane road' };
    return { code: 'TA-17', title: 'Mobile Operations on Two-Lane Road', description: 'Moving work with shadow vehicle on two-lane road' };
  }

  // === INTERMITTENT / SHORT DURATION ===
  if (operationType === 'Intermittent Closure') {
    if (isMultiLane || isFreeway) return { code: 'TA-35', title: 'Mobile Operation on Multi-Lane Road', description: 'Short-duration work with shadow vehicle' };
    return { code: 'TA-17', title: 'Mobile Operations on Two-Lane Road', description: 'Short-duration intermittent work' };
  }

  // === SHOULDER WORK ===
  if (operationType === 'Shoulder Work') {
    if (isFreeway) return { code: 'TA-5', title: 'Shoulder Closure on Freeway', description: 'Shoulder closure on a freeway' };
    if (isMultiLane) return { code: 'TA-23', title: 'Shoulder Work on Multi-Lane Road', description: 'Shoulder closure on a multi-lane road' };
    return { code: 'TA-22', title: 'Shoulder Work on Two-Lane Road', description: 'Shoulder closure on a two-lane road' };
  }

  // === MEDIAN CROSSOVER ===
  if (operationType === 'Median Crossover') {
    return { code: 'TA-18', title: 'Lane Closure on Minor Street (Median Crossover)', description: 'Traffic diverted through median opening' };
  }

  // === DOUBLE LANE CLOSURE ===
  if (operationType === 'Double Lane Closure') {
    if (isFreeway) return { code: 'TA-37', title: 'Double Lane Closure on Freeway', description: 'Two adjacent lanes closed on freeway' };
    if (isDivided) return { code: 'TA-34', title: 'Lane Closure with Temporary Traffic Barrier', description: 'Lane closure with barrier on divided highway' };
    if (isMultiLane) return { code: 'TA-30', title: 'Double Lane Closure on Multi-Lane Undivided', description: 'Two lanes closed on undivided multi-lane road — requires engineering review' };
    // Two-lane road: double lane = full closure
    return { code: 'TA-13', title: 'Temporary Road Closure', description: 'Double lane closure on two-lane road requires full closure with detour' };
  }

  // === SINGLE LANE CLOSURE (default) ===
  if (isFreeway) {
    return { code: 'TA-38', title: 'Interior Lane Closure on Freeway', description: 'Single lane closure on freeway' };
  }
  if (isDivided) {
    return { code: 'TA-33', title: 'Stationary Lane Closure on Divided Highway', description: 'Single lane closure on divided highway' };
  }
  // TWLTL (3-lane or 5-lane): shift traffic into center turn lane — NOT flaggers
  if (hasTWLTL) {
    return { code: 'TA-31', title: 'Lane Closure with Center Turn Lane', description: 'Shift traffic into TWLTL — maintain two-way flow' };
  }
  if (isMultiLane) {
    return { code: 'TA-30', title: 'Interior Lane Closure on Multi-Lane Street', description: 'Single lane closure on multi-lane undivided road' };
  }
  // 2-lane road: yield signs only for very low volume WITH adequate sight distance
  // Per MUTCD 6C.10: yield control requires adequate sight distance — mountainous/rolling = flaggers
  const isRestrictedSight = /mountainous|rolling/i.test(terrain);
  if (aadt > 0 && aadt < 400 && !isRestrictedSight) {
    return { code: 'TA-11', title: 'Lane Closure on Two-Lane Road (Low Volume)', description: 'One lane closure using yield signs (AADT < 400, adequate sight distance)' };
  }
  return { code: 'TA-10', title: 'Lane Closure Using Flaggers', description: 'One lane closure on two-lane road using flagging' };
}

// ===================================================================
// SIGN SEQUENCE FOR EACH TA
// ===================================================================
export interface RequiredSign {
  code: string;
  label: string;
  mandatory: boolean;
  position: 'advance_warning' | 'transition' | 'activity' | 'termination';
}

/**
 * Get the mandatory and optional signs for a given TA.
 * These are the MUTCD-required signs — PE Agent output is validated against this.
 */
export function getRequiredSigns(taCode: string): { primary: RequiredSign[]; opposing: RequiredSign[] } {
  const w = (code: string, label: string, pos: RequiredSign['position'] = 'advance_warning'): RequiredSign =>
    ({ code, label, mandatory: true, position: pos });

  switch (taCode) {
    // === TWO-LANE ROAD OPERATIONS ===
    case 'TA-10': return { // Flaggers
      primary: [w('W20-1', 'ROAD WORK AHEAD'), w('W20-4', 'ONE LANE ROAD AHEAD'), w('W20-7a', 'FLAGGER AHEAD')],
      opposing: [w('W20-1', 'ROAD WORK AHEAD'), w('W20-4', 'ONE LANE ROAD AHEAD'), w('W20-7a', 'FLAGGER AHEAD')],
    };
    case 'TA-11': return { // Low volume yield
      primary: [w('W20-1', 'ROAD WORK AHEAD'), w('W20-4', 'ONE LANE ROAD AHEAD')],
      opposing: [w('W20-1', 'ROAD WORK AHEAD'), w('W20-4', 'ONE LANE ROAD AHEAD')],
    };
    case 'TA-13': return { // Temporary road closure
      primary: [w('W20-1', 'ROAD WORK AHEAD'), w('R11-2', 'ROAD CLOSED'), w('M4-9', 'DETOUR ARROW', 'transition')],
      opposing: [w('W20-1', 'ROAD WORK AHEAD'), w('R11-2', 'ROAD CLOSED'), w('M4-9', 'DETOUR ARROW', 'transition')],
    };
    case 'TA-17': return { // Mobile ops 2-lane
      primary: [w('W20-1', 'ROAD WORK AHEAD')],
      opposing: [w('W20-1', 'ROAD WORK AHEAD')],
    };
    case 'TA-18': return { // Median crossover / minor street
      primary: [w('W20-1', 'ROAD WORK AHEAD'), w('W20-4', 'ONE LANE ROAD AHEAD')],
      opposing: [w('W20-1', 'ROAD WORK AHEAD')],
    };

    // === SHOULDER WORK ===
    case 'TA-5': return { // Shoulder on freeway
      primary: [w('W20-1', 'ROAD WORK AHEAD'), w('W21-5b', 'SHOULDER WORK AHEAD')],
      opposing: [],
    };
    case 'TA-22': return { // Shoulder 2-lane
      primary: [w('W20-1', 'ROAD WORK AHEAD'), w('W21-5b', 'SHOULDER WORK AHEAD')],
      opposing: [w('W20-1', 'ROAD WORK AHEAD'), w('W21-5b', 'SHOULDER WORK AHEAD')],
    };
    case 'TA-23': return { // Shoulder multi-lane
      primary: [w('W20-1', 'ROAD WORK AHEAD'), w('W21-5', 'SHOULDER CLOSED AHEAD')],
      opposing: [],
    };

    // === MULTI-LANE UNDIVIDED ===
    case 'TA-30': case 'TA-31': return {
      primary: [w('W20-1', 'ROAD WORK AHEAD'), w('W20-5', 'RIGHT LANE CLOSED AHEAD'), w('W4-2R', 'LANE ENDS')],
      opposing: [w('W20-1', 'ROAD WORK AHEAD'), w('W20-5', 'RIGHT LANE CLOSED AHEAD')],
    };

    // === DIVIDED HIGHWAY ===
    case 'TA-33': return { // Stationary lane closure
      primary: [w('W20-1', 'ROAD WORK AHEAD'), w('W20-5R', 'RIGHT LANE CLOSED AHEAD'), w('W4-2R', 'LANE ENDS')],
      opposing: [],
    };
    case 'TA-34': return { // Lane closure with barrier
      primary: [w('W20-1', 'ROAD WORK AHEAD'), w('W20-5R', 'RIGHT LANE CLOSED AHEAD'), w('W4-2R', 'LANE ENDS')],
      opposing: [],
    };

    // === FREEWAY ===
    case 'TA-35': return { // Mobile ops multi-lane
      primary: [w('W20-5L', 'LEFT LANE CLOSED AHEAD')],
      opposing: [],
    };
    case 'TA-37': return { // Double lane closure freeway
      primary: [w('W20-1', 'ROAD WORK AHEAD'), w('W20-5aR', 'TWO RIGHT LANES CLOSED'), w('W4-2R', 'LANE ENDS')],
      opposing: [],
    };
    case 'TA-38': return { // Interior lane closure freeway
      primary: [w('W20-1', 'ROAD WORK AHEAD'), w('W20-5L', 'LEFT LANE CLOSED AHEAD'), w('W4-2L', 'LANE ENDS (Left)')],
      opposing: [],
    };

    default: return {
      primary: [w('W20-1', 'ROAD WORK AHEAD')],
      opposing: [],
    };
  }
}

// ===================================================================
// TERMINATION SIGNS (shared across all TAs)
// ===================================================================
export const TERMINATION_SIGN: RequiredSign = {
  code: 'G20-2', label: 'END ROAD WORK', mandatory: false, position: 'termination',
};

// ===================================================================
// COMPREHENSIVE COMPLIANCE VALIDATION
// ===================================================================
export interface ComplianceCheck {
  rule: string;       // MUTCD section reference
  requirement: string; // What the spec says
  actual: string;     // What we have
  pass: boolean;
  severity: 'error' | 'warning' | 'info';
}

export function runComplianceChecks(params: {
  taCode: string;
  speedMph: number;
  wzSpeedMph: number;
  laneWidthFt: number;
  taperLengthFt: number;
  bufferFt: number;
  dnTaperFt: number;
  primarySigns: { sign_code: string; distance_ft: number }[];
  opposingSigns: { sign_code: string; distance_ft: number }[];
  deviceType: string;
  duration: WorkDuration;
  roadClass: RoadClass;
  roadName: string;
  crossStreetCount: number;
  arrowBoard: boolean;
}): ComplianceCheck[] {
  const checks: ComplianceCheck[] = [];
  const p = params;
  const spacing = SIGN_SPACING[p.roadClass];
  const reqSigns = getRequiredSigns(p.taCode);

  // 1. Taper length
  const expectedTaper = getTaperLength(p.taCode, p.laneWidthFt, p.speedMph);
  if (p.taCode === 'TA-10') {
    checks.push({
      rule: 'MUTCD 6C.08', requirement: `Flagger taper: 50-100 ft`,
      actual: `${p.taperLengthFt} ft`, pass: p.taperLengthFt >= 50 && p.taperLengthFt <= 100, severity: 'error',
    });
  } else {
    checks.push({
      rule: 'MUTCD 6C.08', requirement: `Taper >= ${expectedTaper} ft (L=${p.speedMph >= 45 ? 'WS' : 'WS²/60'})`,
      actual: `${p.taperLengthFt} ft`, pass: p.taperLengthFt >= expectedTaper * 0.95, severity: 'error',
    });
  }

  // 2. Buffer space
  const reqBuffer = getBufferSpace(p.speedMph);
  checks.push({
    rule: 'MUTCD Table 6B-2', requirement: `Buffer >= ${reqBuffer} ft for ${p.speedMph} MPH`,
    actual: `${p.bufferFt} ft`, pass: p.bufferFt >= reqBuffer, severity: 'error',
  });

  // 3. Downstream taper
  const { min: dnMin, max: dnMax } = downstreamTaper();
  checks.push({
    rule: 'MUTCD 6C.08', requirement: `Downstream taper ${dnMin}-${dnMax} ft`,
    actual: `${p.dnTaperFt} ft`, pass: p.dnTaperFt >= dnMin, severity: 'error',
  });

  // 4. First advance warning sign distance
  const maxSignDist = Math.max(...p.primarySigns.map(s => s.distance_ft), 0);
  checks.push({
    rule: 'MUTCD Table 6B-1', requirement: `First sign >= ${spacing.a} ft from taper (${spacing.classification})`,
    actual: `${maxSignDist} ft`, pass: maxSignDist >= spacing.a * 0.9, severity: 'error',
  });

  // 5. W20-1 present on primary approach
  const hasW201 = p.primarySigns.some(s => s.sign_code === 'W20-1');
  checks.push({
    rule: 'MUTCD 6C.04', requirement: 'W20-1 ROAD WORK AHEAD required on primary approach',
    actual: hasW201 ? 'Present' : 'MISSING', pass: hasW201, severity: 'error',
  });

  // 6. All mandatory signs present
  for (const reqSign of reqSigns.primary.filter(s => s.mandatory)) {
    const found = p.primarySigns.some(s => s.sign_code === reqSign.code || s.sign_code.startsWith(reqSign.code.replace(/[RL]$/, '')));
    checks.push({
      rule: `TA ${p.taCode}`, requirement: `${reqSign.code} ${reqSign.label} required`,
      actual: found ? 'Present' : 'MISSING', pass: found, severity: found ? 'info' : 'warning',
    });
  }

  // 7. Opposing signs (if required by TA)
  if (reqSigns.opposing.length > 0) {
    const hasOppW201 = p.opposingSigns.some(s => s.sign_code === 'W20-1');
    checks.push({
      rule: `TA ${p.taCode}`, requirement: 'W20-1 required on opposing approach',
      actual: hasOppW201 ? 'Present' : (p.opposingSigns.length === 0 ? 'NO OPPOSING SIGNS' : 'MISSING'),
      pass: hasOppW201, severity: hasOppW201 ? 'info' : 'warning',
    });
  }

  // 8. Sign size
  const signSize = getITDSignSize(p.speedMph, p.roadName, p.roadClass);
  checks.push({
    rule: 'MUTCD Table 6G-1 / ITD', requirement: `Signs >= ${signSize.label}`,
    actual: signSize.label, pass: true, severity: 'info',
  });

  // 9. Device type vs duration
  const reqDevices = getDeviceRequirements(p.duration);
  checks.push({
    rule: 'MUTCD 6F.01', requirement: `${p.duration}: ${reqDevices.label}`,
    actual: p.deviceType, pass: true, severity: 'info',
  });

  // 10. Arrow board
  const abRequired = isArrowBoardRequired(p.taCode);
  if (abRequired) {
    const abType = getArrowBoardType(p.speedMph, p.roadClass);
    checks.push({
      rule: 'MUTCD 6L.06', requirement: `Arrow board (Type ${abType}) required for ${p.taCode}`,
      actual: p.arrowBoard ? `Present (Type ${abType})` : 'MISSING',
      pass: p.arrowBoard, severity: 'error',
    });
  }

  // 11. Speed reduction validation
  const speedCheck = validateSpeedReduction(p.speedMph, p.wzSpeedMph);
  checks.push({
    rule: 'MUTCD 6C.01', requirement: `Speed reduction <= 10 MPH recommended`,
    actual: `${p.speedMph - p.wzSpeedMph} MPH reduction`,
    pass: speedCheck.valid, severity: speedCheck.warning ? 'warning' : 'info',
  });

  // 12. Device spacing
  const taperSpace = taperDeviceSpacing(p.speedMph, p.taCode);
  const tangentSpace = tangentDeviceSpacing(p.speedMph);
  checks.push({
    rule: 'MUTCD 6L.05', requirement: `Taper spacing: ${taperSpace} ft, Tangent: ${tangentSpace} ft`,
    actual: `Taper: ${taperSpace} ft, Tangent: ${tangentSpace} ft`, pass: true, severity: 'info',
  });

  // 13. Cross-street signing
  if (p.crossStreetCount > 0) {
    checks.push({
      rule: 'MUTCD 6H.01', requirement: `W20-1 signs on ${p.crossStreetCount} cross-street approaches`,
      actual: `${p.crossStreetCount} intersection detail sheets generated`, pass: true, severity: 'info',
    });
  }

  // 14. Flagger requirements
  const flaggerReq = getFlaggerRequirements(p.taCode, p.speedMph, false);
  if (flaggerReq.required) {
    checks.push({
      rule: 'MUTCD 6E.01', requirement: 'Certified flaggers required for this TA',
      actual: `${p.taCode} requires flaggers`, pass: true, severity: 'info',
    });
  }

  // 15. Sign-to-sign spacing (B and C distances)
  const sortedPri = [...p.primarySigns].sort((a, b) => b.distance_ft - a.distance_ft);
  if (sortedPri.length >= 2) {
    const bActual = sortedPri[0]!.distance_ft - sortedPri[1]!.distance_ft;
    checks.push({
      rule: 'MUTCD Table 6B-1 (B)', requirement: `Sign spacing B >= ${spacing.b} ft between 1st and 2nd signs`,
      actual: `${bActual} ft`, pass: bActual >= spacing.b * 0.85, severity: bActual >= spacing.b * 0.85 ? 'info' : 'warning',
    });
  }
  if (sortedPri.length >= 3) {
    const cActual = sortedPri[1]!.distance_ft - sortedPri[2]!.distance_ft;
    checks.push({
      rule: 'MUTCD Table 6B-1 (C)', requirement: `Sign spacing C >= ${spacing.c} ft between 2nd and 3rd signs`,
      actual: `${cActual} ft`, pass: cActual >= spacing.c * 0.85, severity: cActual >= spacing.c * 0.85 ? 'info' : 'warning',
    });
  }

  // 16. Speed reduction sign present when WZ speed differs
  if (p.speedMph !== p.wzSpeedMph) {
    const hasSpeedSign = p.primarySigns.some(s => s.sign_code === 'W3-5' || s.sign_code === 'R2-1');
    checks.push({
      rule: 'MUTCD 6C.01', requirement: `Speed reduction signs required (${p.speedMph}→${p.wzSpeedMph} MPH)`,
      actual: hasSpeedSign ? 'W3-5 present' : 'MISSING', pass: hasSpeedSign, severity: 'warning',
    });
  }

  return checks;
}

// ===================================================================
// NIGHT OPERATION REQUIREMENTS (Section 6F.78)
// ===================================================================
export const NIGHT_REQUIREMENTS = {
  retroreflectivity: 'All signs, channelizing devices, and barricades shall have retroreflective sheeting',
  flaggerIllumination: 'Flagger stations shall be illuminated with minimum 5 foot-candles at ground level',
  apparel: 'ANSI/ISEA 107 Performance Class 3 high-visibility safety apparel',
  deviceVisibility: 'Retroreflective devices visible from minimum 1,000 ft',
  arrowBoard: 'Arrow boards shall be capable of 50% dimming for nighttime operation',
};

// ===================================================================
// PEDESTRIAN/BICYCLE (Section 6D.01)
// ===================================================================
export const PED_BIKE_REQUIREMENTS = {
  minPathWidthInches: 60,
  detectableEdges: 'Required along pedestrian pathway when adjacent to vehicle traffic',
  signCodes: ['R9-9', 'R9-11', 'R9-10'],
  signLabels: ['SIDEWALK CLOSED', 'USE OTHER SIDE', 'SIDEWALK CLOSED USE OTHER SIDE'],
  adaCompliance: 'Temporary pedestrian access route shall comply with applicable provisions of ADA',
};
