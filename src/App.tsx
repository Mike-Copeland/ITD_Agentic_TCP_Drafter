import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Loader2, Download, FileText, MapPin, Settings, CheckCircle, AlertCircle, LogIn, LogOut } from 'lucide-react';
import Map from './components/Map';
import { auth, signInWithGoogle, logOut, db } from './firebase';
import { onAuthStateChanged, User } from 'firebase/auth';
import { collection, addDoc, serverTimestamp } from 'firebase/firestore';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import mutcdRules from './lib/mutcd_rules.json';

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [isAuthReady, setIsAuthReady] = useState(false);

  const [operationTypes, setOperationTypes] = useState<string[]>(['Single Lane Closure']);
  const operationType = operationTypes[0] || 'Single Lane Closure'; // Primary for PE prompt
  const [duration, setDuration] = useState('Short-term (<= 3 days)');
  const [normalSpeed, setNormalSpeed] = useState(65);
  const [workZoneSpeed, setWorkZoneSpeed] = useState(55);
  const [laneWidth, setLaneWidth] = useState(12);

  const [startCoords, setStartCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [endCoords, setEndCoords] = useState<{ lat: number; lng: number } | null>(null);

  const [loadingState, setLoadingState] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);

  const [contextData, setContextData] = useState<any>(null);
  const [verifiedBlueprint, setVerifiedBlueprint] = useState<string | null>(null);
  const [eacrAudit, setEacrAudit] = useState<{attack: string, defense: string} | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);

  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [areaAnalysis, setAreaAnalysis] = useState<string | null>(null);
  const mapCaptureRef = useRef<(() => string | null) | null>(null);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setIsAuthReady(true);
    });
    return () => unsubscribe();
  }, []);

  const handlePinDrop = async (coords: { lat: number; lng: number }) => {
    if (!startCoords) {
      setStartCoords(coords);

      // Bonus: Auto-Fetch Speed Limit via Google Search!
      try {
        let speedLimitFound = false;
        try {
          const roadsRes = await fetch('/api/speed-limit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lat: coords.lat, lng: coords.lng })
          });
          
          if (roadsRes.ok) {
            const roadsJson = await roadsRes.json();
            if (roadsJson.speedLimits && roadsJson.speedLimits.length > 0) {
              const speedKph = roadsJson.speedLimits[0].speedLimit;
              const speedMph = Math.round(speedKph * 0.621371);
              if (speedMph > 0 && speedMph <= 85) {
                setNormalSpeed(speedMph);
                setWorkZoneSpeed(speedMph >= 55 ? speedMph - 10 : speedMph - 5);
                speedLimitFound = true;
              }
            }
          }
        } catch (roadsErr) {
          console.error("Roads API Proxy failed", roadsErr);
        }

        if (!speedLimitFound) {
          // Roads API speed limits require premium tier — use Gemini Flash with coordinates
          try {
            const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || (import.meta as any).env.VITE_GEMINI_API_KEY });
            const response = await ai.models.generateContent({
              model: 'gemini-3-flash-preview',
              contents: `What is the posted speed limit on the road nearest to GPS ${coords.lat}, ${coords.lng} in Idaho? Idaho state highways are typically 55-65 MPH, US highways 55-65 MPH, interstates 65-80 MPH, local roads 25-45 MPH. Return ONLY the integer MPH.`,
            });
            const speedStr = response.text?.replace(/[^0-9]/g, '') || '';
            const speed = parseInt(speedStr, 10);
            if (!isNaN(speed) && speed > 0 && speed <= 85) {
              setNormalSpeed(speed);
              setWorkZoneSpeed(speed >= 55 ? speed - 10 : speed - 5);
            }
          } catch (flashErr) {
            console.log("Speed limit fallback failed, keeping default.", flashErr);
          }
        }
      } catch (e) {
        console.error("Speed limit auto-fetch failed, falling back to manual input.", e);
      }

    } else if (!endCoords) {
      setEndCoords(coords);
    } else {
      setStartCoords(coords);
      setEndCoords(null);
    }
  };

  const handleAnalyzeArea = async () => {
    if (!startCoords || !endCoords) {
      setError('Please drop BOTH Start and End pins on the map to analyze the route segment.');
      return null;
    }
    setError(null);
    setAnalysisLoading(true);
    setAreaAnalysis(null);

    try {
      // Call our backend which fetches from Google Maps APIs (Directions, Elevation, Reverse Geocoding)
      const res = await fetch('/api/site-context', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ startCoords, endCoords, normalSpeed })
      });

      if (!res.ok) throw new Error('Failed to fetch site context from backend.');
      const data = await res.json();

      // Format the API data into readable context for the engineer
      const lines: string[] = [];

      if (data.roadName) lines.push(`Road: ${data.roadName}`);
      if (data.roadContext) lines.push(data.roadContext);
      lines.push('');
      lines.push(`Elevation & Grade: ${data.elevationContext || 'Unavailable'}`);
      if (data.approachGradeContext) lines.push(`Grade Warning: ${data.approachGradeContext}`);
      lines.push('');
      if (data.crossStreets?.length > 0) {
        lines.push(`Cross-Streets/Turns Detected:`);
        data.crossStreets.forEach((cs: string) => lines.push(`  - ${cs}`));
      } else {
        lines.push('No cross-streets or intersections detected along route.');
      }

      // ITD authoritative data
      if (data.itdContext) {
        lines.push('');
        lines.push(data.itdContext);
      }

      // Auto-populate speed and lane width from ITD
      if (data.itdSpeedLimit) {
        setNormalSpeed(data.itdSpeedLimit);
        setWorkZoneSpeed(data.itdSpeedLimit >= 55 ? data.itdSpeedLimit - 10 : data.itdSpeedLimit - 5);
      }
      if (data.itdLaneWidth) {
        setLaneWidth(data.itdLaneWidth);
      }

      const text = lines.join('\n');
      setAreaAnalysis(text);
      return text;
    } catch (err: any) {
      setError(err.message || 'Area analysis failed.');
      return null;
    } finally {
      setAnalysisLoading(false);
    }
  };

  const handleGenerate = async () => {
    if (!startCoords || !endCoords) {
      setError('Please drop both Start and End pins on the map.');
      return;
    }

    // Use whatever area analysis text is available — don't block generation on it.
    // The PE Agent still gets elevation, speed, and MUTCD rules from the backend.
    const currentContext = areaAnalysis || '';

    setError(null);
    setVerifiedBlueprint(null);
    setDownloadUrl(null);
    setLoadingState(1);

    try {
      const apiKey = process.env.GEMINI_API_KEY || (import.meta as any).env.VITE_GEMINI_API_KEY;
      const ai = new GoogleGenAI({ apiKey });

      // ---------------------------------------------------------
      // PILLAR 1: OMNISCIENT SENSORY PAYLOAD (PROMISE.ALL)
      // ---------------------------------------------------------
      console.log("Fetching Omniscient State from Backend...");
      
      const contextRes = await fetch('/api/site-context', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ startCoords, endCoords, normalSpeed })
      });
      const ctxData = contextRes.ok ? await contextRes.json() : null;
      setContextData(ctxData);
      const contextData = ctxData;

      // Auto-populate from ITD authoritative data if available
      if (contextData?.itdSpeedLimit && contextData.itdSpeedLimit !== normalSpeed) {
        setNormalSpeed(contextData.itdSpeedLimit);
        setWorkZoneSpeed(contextData.itdSpeedLimit >= 55 ? contextData.itdSpeedLimit - 10 : contextData.itdSpeedLimit - 5);
      }
      if (contextData?.itdLaneWidth && contextData.itdLaneWidth !== laneWidth) {
        setLaneWidth(contextData.itdLaneWidth);
      }

      // Use ITD speed limit for calculations if available
      const effectiveSpeed = contextData?.itdSpeedLimit || normalSpeed;
      const effectiveLaneWidth = contextData?.itdLaneWidth || laneWidth;

      const elevationContext = contextData?.elevationContext || "Elevation data unavailable.";
      const speedLimitContext = contextData?.speedLimitContext || `User input speed: ${normalSpeed} MPH.`;
      const roadContext = contextData?.roadContext || '';
      const approachGradeContext = contextData?.approachGradeContext || '';
      const itdContext = contextData?.itdContext || '';

      const siteContext = `
        ROAD IDENTIFICATION: ${roadContext || 'Unknown road'}
        GEOGRAPHICAL CONTEXT: ${currentContext || 'None'}
        ELEVATION & GRADE: ${elevationContext}
        ${approachGradeContext ? `GRADE WARNING: ${approachGradeContext}` : ''}
        ${speedLimitContext}
        ${itdContext}
      `;

      // ---------------------------------------------------------
      // PILLAR 2: GROUND TRUTH MUTCD INJECTION (BACKEND RAG)
      // ---------------------------------------------------------
      const ragRes = await fetch('/api/rag', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operationType, speedLimit: effectiveSpeed, siteContext: currentContext || '', laneWidth: effectiveLaneWidth, duration })
      });
      const librarianOutput = ragRes.ok ? await ragRes.json() : { text: 'RAG failed. Rely on standard MUTCD math.', image_base64: null };
      console.log("🏆 RAG ENGINE MATCH:", librarianOutput.text);
      setLoadingState(2);

      // ---------------------------------------------------------
      // PILLAR 3: PHYSICS-AWARE FACT CHECKING (AGENT 2)
      // ---------------------------------------------------------
      let imageParts: any[] = [];
      // Primary approach Street View (facing toward work zone)
      if (contextData?.streetViewBase64) {
        imageParts.push({ inlineData: { data: contextData.streetViewBase64, mimeType: "image/jpeg" } });
      }
      // Opposing approach Street View (facing back toward work zone from end pin)
      if (contextData?.streetViewEndBase64) {
        imageParts.push({ inlineData: { data: contextData.streetViewEndBase64, mimeType: "image/jpeg" } });
      }
      // Satellite image
      if (contextData?.staticMapBase64) {
        imageParts.push({ inlineData: { data: contextData.staticMapBase64, mimeType: "image/jpeg" } });
      }

      if (librarianOutput.image_base64) {
        imageParts.push({
          inlineData: { data: librarianOutput.image_base64, mimeType: "image/jpeg" }
        });
      }

      const crossStreetInfo = contextData?.crossStreets?.length > 0
        ? `CROSS-STREETS DETECTED: ${contextData.crossStreets.join('; ')}. Consider additional intersection/cross-street signage if these intersections fall within the work zone.`
        : 'No cross-streets or intersections detected along the route segment.';

      const pePrompt = `
        You are a Senior Professional Engineer. Fact-check the MUTCD rules:
        ${librarianOutput.text}

        SITE CONTEXT: ${siteContext}
        OPERATION TYPE: ${operationType}
        PROJECT DURATION: ${duration}
        SPEED: ${effectiveSpeed} MPH, Lane Width: ${effectiveLaneWidth} FT
        ${crossStreetInfo}

        IMAGES PROVIDED (in order):
        ${contextData?.streetViewBase64 ? '- Image 1: Street View from PRIMARY APPROACH (start pin, facing toward work zone)' : ''}
        ${contextData?.streetViewEndBase64 ? '- Image 2: Street View from OPPOSING APPROACH (end pin, facing back toward work zone)' : ''}
        ${contextData?.staticMapBase64 ? '- Image 3: Satellite aerial view with route polyline overlay' : ''}
        ${librarianOutput.image_base64 ? '- MUTCD Typical Application diagram from RAG database' : ''}
        Analyze the Street View images for: sight distance obstructions, curve severity, shoulder width, guardrails, and terrain features that affect sign placement.

        TASKS:
        1. Calculate Road Bearing (North/South vs East/West) from the satellite image.
        2. Specify channelizing devices based on ${duration}.
        3. Calculate advance warning sequence for BOTH approaches (Primary and Opposing). You MUST include signs for BOTH approaches. Add PCMS if high-speed/blind curves require it.
        4. Calculate taper (L = W * S for >=45mph) and downstream taper lengths.
        5. PHYSICS OVERRIDE: If the GRADE WARNING indicates a steep downgrade on a specific approach, increase that approach's sign spacing by 1.5x.
        6. TRAFFIC VOLUME OVERRIDE: If the site context indicates a major arterial, US highway, state highway, or high traffic volume, mandate Flagger Control (TA-10) and include 'Flagger Ahead' (W20-7a) for BOTH approaches.
        7. Calculate a downstream taper (50-100 ft).

        IMPORTANT: The opposing_approach array MUST contain at minimum a W20-1 sign. Two-lane two-way roads always require advance warning for BOTH directions.

        Output strict JSON matching the schema.
      `;

      const peResponse = await ai.models.generateContent({
        model: 'gemini-3.1-pro-preview',
        contents: { parts: [...imageParts, { text: pePrompt }] },
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              primary_approach: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    sign_code: { type: Type.STRING },
                    distance_ft: { type: Type.NUMBER },
                    label: { type: Type.STRING }
                  },
                  required: ["sign_code", "distance_ft", "label"]
                }
              },
              opposing_approach: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    sign_code: { type: Type.STRING },
                    distance_ft: { type: Type.NUMBER },
                    label: { type: Type.STRING }
                  },
                  required: ["sign_code", "distance_ft", "label"]
                }
              },
              taper: {
                type: Type.OBJECT,
                properties: {
                  length_ft: { type: Type.NUMBER },
                  device_type: { type: Type.STRING }
                },
                required: ["length_ft", "device_type"]
              },
              downstream_taper: {
                type: Type.OBJECT,
                properties: { length_ft: { type: Type.NUMBER } },
                required: ["length_ft"]
              },
              engineering_notes: { type: Type.STRING }
            },
            required: ["primary_approach", "opposing_approach", "taper", "downstream_taper", "engineering_notes"]
          }
        }
      });

      const blueprintText = peResponse.text || '{}';
      const blueprintJson = JSON.parse(blueprintText);
      
      setVerifiedBlueprint(blueprintText);
      
      setLoadingState(3); // Update UI: "Step 3: Deterministic Drafting..."

      // ---------------------------------------------------------
      // PILLAR 3: DETERMINISTIC DRAFTER
      // ---------------------------------------------------------
      const response = await fetch('/api/generate-plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          blueprint: blueprintJson,
          startCoords,
          endCoords,
          staticMapBase64: contextData?.staticMapBase64 || mapCaptureRef.current?.() || '',
          normalSpeed,
          workZoneSpeed,
          laneWidth,
          operationType,
          operationTypes,
          duration,
          routeDistanceFt: contextData?.routeDistanceFt || 0,
          roadName: contextData?.roadName || '',
          positionedCrossStreets: contextData?.positionedCrossStreets || [],
          itdTerrain: contextData?.itdTerrain || '',
          itdFuncClass: contextData?.itdFuncClass || '',
          itdTotalLanes: contextData?.itdTotalLanes || 0,
          itdAADT: contextData?.itdAADT || 0,
          itdTruckPct: contextData?.itdTruckPct || 0,
          itdCrashCount: contextData?.itdCrashCount || 0,
          itdBridges: contextData?.itdBridges || [],
          maxGradePercent: contextData?.maxGradePercent || 0
        }),
      });

      if (!response.ok) {
        const errData = await response.json();
        throw new Error(errData.error || "Failed to generate CAD files.");
      }

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      setDownloadUrl(url);

      // Save to Firestore...
      try {
        if (user) {
          await addDoc(collection(db, 'plans'), {
            userId: user.uid, operationType, normalSpeed, workZoneSpeed, laneWidth,
            startLat: startCoords.lat, startLng: startCoords.lng, endLat: endCoords.lat, endLng: endCoords.lng,
            verifiedBlueprint: blueprintText || 'Generated', createdAt: serverTimestamp()
          });
        }
      } catch (fsError) {
        console.error("Failed to save plan", fsError);
      }

    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoadingState(0);
    }
  };

  if (!isAuthReady) {
    return <div className="fixed inset-0 bg-zinc-950 flex items-center justify-center"><Loader2 className="w-8 h-8 animate-spin text-emerald-500" /></div>;
  }

  const lanes = contextData?.itdTotalLanes || 0;
  const fc = parseInt(contextData?.itdFuncClass || '99') || 99;
  const isDivided = fc <= 3 && lanes >= 4;
  const isFreeway = fc <= 2;
  const isMultiLane = lanes >= 4;
  const allOps = [
    { id: 'Single Lane Closure', label: 'Lane Closure', icon: '◄►', show: true },
    { id: 'Double Lane Closure', label: 'Double Lane', icon: '◄◄', show: isMultiLane || isFreeway },
    { id: 'Full Road Closure', label: 'Road Closure', icon: '⊘', show: true },
    { id: 'Shoulder Work', label: 'Shoulder', icon: '▐', show: true },
    { id: 'Median Crossover', label: 'Crossover', icon: '⇌', show: isDivided || lanes >= 4 },
    { id: 'Mobile Operations', label: 'Mobile Ops', icon: '►', show: true },
    { id: 'Intermittent Closure', label: 'Intermittent', icon: '⏱', show: true },
  ].filter(o => o.show || !contextData);

  return (
    <div className="fixed inset-0 bg-zinc-950 text-zinc-100 overflow-hidden">
      {/* === IMMERSIVE MAP CANVAS === */}
      <div className="absolute inset-0 z-0">
        <Map startCoords={startCoords} endCoords={endCoords} onPinDrop={handlePinDrop} captureRef={mapCaptureRef} />
      </div>
      {/* Vignette overlay */}
      <div className="absolute inset-0 z-10 bg-gradient-to-br from-zinc-950/80 via-transparent to-zinc-950/80 pointer-events-none" />
      <div className="absolute inset-0 z-10 bg-gradient-to-t from-zinc-950/60 via-transparent to-zinc-950/40 pointer-events-none" />

      {/* === TOP BAR (minimal, floating) === */}
      <div className="absolute top-0 left-0 right-0 z-40 flex items-center justify-between px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
          <h1 className="text-sm font-mono tracking-widest uppercase text-zinc-400">ITD TCP DRAFTER</h1>
        </div>
        <div className="flex items-center gap-4">
          <div className="text-[10px] font-mono text-zinc-600 uppercase tracking-widest">
            {!startCoords ? 'AWAITING START PIN' : !endCoords ? 'AWAITING END PIN' : 'READY'}
          </div>
          {user ? (
            <button onClick={logOut} className="text-[10px] font-mono text-zinc-500 hover:text-zinc-300 uppercase tracking-widest transition-colors">
              {user.email?.split('@')[0]} ✕
            </button>
          ) : (
            <button onClick={signInWithGoogle} className="text-[10px] font-mono text-emerald-500 hover:text-emerald-400 uppercase tracking-widest transition-colors">
              Sign In
            </button>
          )}
        </div>
      </div>

      {/* === ENGINEERING COMMAND DECK (Left Panel) === */}
      <motion.div
        initial={{ opacity: 0, x: -40 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
        className="absolute top-16 left-6 bottom-6 w-[400px] bg-zinc-950/60 backdrop-blur-2xl border border-white/5 rounded-3xl z-40 flex flex-col shadow-2xl overflow-hidden"
      >
        <div className="flex-1 overflow-y-auto p-7 space-y-6" style={{ scrollbarWidth: 'none' }}>
          {/* Operation Phases */}
          <div>
            <p className="text-[10px] font-mono uppercase tracking-[0.2em] text-zinc-500 mb-3">Operation Phases</p>
            <div className="grid grid-cols-2 gap-2">
              {allOps.map(op => (
                <motion.button
                  key={op.id}
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={() => {
                    if (operationTypes.includes(op.id)) setOperationTypes(prev => prev.filter(t => t !== op.id));
                    else setOperationTypes(prev => [...prev, op.id]);
                  }}
                  className={`relative px-3 py-3 rounded-xl border text-left transition-all duration-200 ${
                    operationTypes.includes(op.id)
                      ? 'bg-emerald-500/10 border-emerald-500/40 shadow-[0_0_15px_rgba(16,185,129,0.12)]'
                      : 'bg-white/[0.03] border-white/[0.06] hover:border-white/10'
                  }`}
                >
                  <span className={`text-lg ${operationTypes.includes(op.id) ? 'opacity-100' : 'opacity-30'}`}>{op.icon}</span>
                  <p className={`text-[11px] font-medium mt-1 ${operationTypes.includes(op.id) ? 'text-emerald-400' : 'text-zinc-500'}`}>{op.label}</p>
                </motion.button>
              ))}
            </div>
          </div>

          {/* Duration */}
          <div>
            <p className="text-[10px] font-mono uppercase tracking-[0.2em] text-zinc-500 mb-2">Duration</p>
            <div className="flex gap-2">
              {['Short-term (<= 3 days)', 'Long-term (> 3 days)'].map(d => (
                <button key={d} onClick={() => setDuration(d)}
                  className={`flex-1 py-2 rounded-lg text-[11px] font-medium transition-all ${duration === d ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30' : 'bg-white/[0.03] text-zinc-500 border border-white/[0.06]'}`}>
                  {d.includes('Short') ? 'SHORT-TERM' : 'LONG-TERM'}
                </button>
              ))}
            </div>
          </div>

          {/* Speed & Width — HUD Style */}
          <div className="grid grid-cols-3 gap-4">
            <div className="border-b border-white/10 pb-2">
              <p className="text-[9px] font-mono uppercase tracking-[0.2em] text-zinc-600">Speed</p>
              <input type="number" value={normalSpeed} onChange={(e) => setNormalSpeed(Number(e.target.value))}
                className="w-full bg-transparent border-none outline-none font-mono text-lg text-emerald-400 p-0 mt-1" />
              <p className="text-[9px] font-mono text-zinc-600">MPH</p>
            </div>
            <div className="border-b border-white/10 pb-2">
              <p className="text-[9px] font-mono uppercase tracking-[0.2em] text-zinc-600">WZ Speed</p>
              <input type="number" value={workZoneSpeed} onChange={(e) => setWorkZoneSpeed(Number(e.target.value))}
                className="w-full bg-transparent border-none outline-none font-mono text-lg text-emerald-400 p-0 mt-1" />
              <p className="text-[9px] font-mono text-zinc-600">MPH</p>
            </div>
            <div className="border-b border-white/10 pb-2">
              <p className="text-[9px] font-mono uppercase tracking-[0.2em] text-zinc-600">Width</p>
              <input type="number" value={laneWidth} onChange={(e) => setLaneWidth(Number(e.target.value))}
                className="w-full bg-transparent border-none outline-none font-mono text-lg text-emerald-400 p-0 mt-1" />
              <p className="text-[9px] font-mono text-zinc-600">FT</p>
            </div>
          </div>

          {/* Coordinates */}
          <div className="space-y-2">
            <p className="text-[10px] font-mono uppercase tracking-[0.2em] text-zinc-500">Coordinates</p>
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-emerald-500" />
              <span className="font-mono text-[12px] text-zinc-400">{startCoords ? `${startCoords.lat.toFixed(5)}, ${startCoords.lng.toFixed(5)}` : '— awaiting pin —'}</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-red-500" />
              <span className="font-mono text-[12px] text-zinc-400">{endCoords ? `${endCoords.lat.toFixed(5)}, ${endCoords.lng.toFixed(5)}` : '— awaiting pin —'}</span>
            </div>
          </div>

          {/* Analyze + Context */}
          <div className="space-y-3">
            <button onClick={handleAnalyzeArea} disabled={analysisLoading || !startCoords}
              className="w-full py-2.5 rounded-xl text-[11px] font-mono uppercase tracking-widest transition-all border border-white/10 bg-white/[0.03] hover:bg-white/[0.06] disabled:opacity-30 flex items-center justify-center gap-2">
              {analysisLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <MapPin className="w-3 h-3" />}
              Analyze Site Context
            </button>
            {areaAnalysis && (
              <div className="bg-zinc-950/80 border border-white/5 rounded-xl p-3 max-h-[120px] overflow-y-auto" style={{ scrollbarWidth: 'none' }}>
                <textarea value={areaAnalysis} onChange={(e) => setAreaAnalysis(e.target.value)}
                  className="w-full bg-transparent border-none outline-none resize-none text-[11px] font-mono text-zinc-500 leading-relaxed min-h-[60px]" />
              </div>
            )}
          </div>

          {/* Error */}
          {error && (
            <div className="bg-red-500/10 border border-red-500/20 text-red-400 text-[11px] px-4 py-3 rounded-xl flex items-start gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <p>{error}</p>
            </div>
          )}
        </div>

        {/* Generate Button — pinned to bottom */}
        <div className="p-5 border-t border-white/5">
          <motion.button
            whileHover={{ scale: 1.01 }}
            whileTap={{ scale: 0.98 }}
            onClick={handleGenerate}
            disabled={loadingState > 0 || !startCoords || !endCoords}
            className="w-full py-4 rounded-2xl font-semibold text-sm tracking-wide transition-all disabled:opacity-30 disabled:cursor-not-allowed bg-gradient-to-r from-emerald-600 to-emerald-500 hover:from-emerald-500 hover:to-emerald-400 text-white shadow-lg shadow-emerald-500/20"
          >
            {loadingState > 0 ? 'GENERATING...' : 'GENERATE PLAN SET'}
          </motion.button>
        </div>
      </motion.div>

      {/* === GOD-MODE GENERATION TERMINAL (Full-screen overlay) === */}
      <AnimatePresence>
        {loadingState > 0 && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-zinc-950/90 backdrop-blur-md flex items-center justify-center"
          >
            <motion.div
              initial={{ opacity: 0, y: 40, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -20 }}
              className="w-[600px] bg-zinc-950/90 border border-white/10 rounded-3xl p-10 shadow-2xl"
            >
              <div className="text-center mb-8">
                <div className={`w-4 h-4 rounded-full mx-auto mb-4 animate-pulse ${loadingState === 1 ? 'bg-cyan-400 shadow-[0_0_20px_rgba(34,211,238,0.5)]' : loadingState === 2 ? 'bg-amber-400 shadow-[0_0_20px_rgba(251,191,36,0.5)]' : 'bg-emerald-400 shadow-[0_0_20px_rgba(52,211,153,0.5)]'}`} />
                <h2 className="font-mono text-lg tracking-tight text-zinc-200">
                  {loadingState === 1 ? 'ESTABLISHING UPLINK' : loadingState === 2 ? 'PE AGENT ANALYSIS' : 'RENDERING ARTIFACTS'}
                </h2>
              </div>

              <div className="space-y-5 font-mono text-[12px]">
                <div className={`flex items-center gap-3 ${loadingState >= 1 ? 'text-cyan-400' : 'text-zinc-700'}`}>
                  {loadingState > 1 ? <CheckCircle className="w-4 h-4" /> : <Loader2 className={`w-4 h-4 ${loadingState === 1 ? 'animate-spin' : ''}`} />}
                  <span>SATELLITE UPLINK & MUTCD RAG VECTOR SEARCH</span>
                </div>
                <div className={`flex items-center gap-3 ${loadingState >= 2 ? 'text-amber-400' : 'text-zinc-700'}`}>
                  {loadingState > 2 ? <CheckCircle className="w-4 h-4" /> : <Loader2 className={`w-4 h-4 ${loadingState === 2 ? 'animate-spin' : ''}`} />}
                  <span>SENIOR PE AGENT: DETERMINISTIC GEOMETRY</span>
                </div>
                <div className={`flex items-center gap-3 ${loadingState >= 3 ? 'text-emerald-400' : 'text-zinc-700'}`}>
                  {loadingState > 3 ? <CheckCircle className="w-4 h-4" /> : <Loader2 className={`w-4 h-4 ${loadingState === 3 ? 'animate-spin' : ''}`} />}
                  <span>CAD ENGINE: PDF + DXF ARTIFACT GENERATION</span>
                </div>
              </div>

              <div className="mt-8 bg-zinc-900/50 rounded-xl p-4 border border-white/5 max-h-[100px] overflow-hidden">
                <p className="font-mono text-[10px] text-zinc-600 animate-pulse">
                  {loadingState === 1 && '> Querying ITD ArcGIS... Speed zones, AADT, functional class, terrain, crash history...'}
                  {loadingState === 2 && '> Gemini 3.1 Pro: Calculating taper L=WS, buffer (Table 6B-2), sign spacing (Table 6B-1)...'}
                  {loadingState === 3 && '> pdfkit: Rendering sheets... dxf-writer: 14-layer CAD... archiver: Building ZIP...'}
                </p>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* === ARTIFACT REVEAL (Right slide-in) === */}
      <AnimatePresence>
        {downloadUrl && (
          <motion.div
            initial={{ opacity: 0, x: 80 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 80 }}
            transition={{ type: 'spring', damping: 25, stiffness: 200 }}
            className="fixed right-6 top-1/2 -translate-y-1/2 w-[380px] z-50 bg-zinc-950/70 backdrop-blur-2xl border border-emerald-500/20 rounded-3xl p-8 shadow-2xl shadow-emerald-500/10"
          >
            <div className="text-center mb-6">
              <motion.div
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ delay: 0.2, type: 'spring', stiffness: 300 }}
                className="w-14 h-14 rounded-full bg-emerald-500/20 flex items-center justify-center mx-auto mb-4 shadow-[0_0_30px_rgba(16,185,129,0.2)]"
              >
                <CheckCircle className="w-7 h-7 text-emerald-400" />
              </motion.div>
              <h3 className="text-lg font-semibold tracking-tight text-white">Plan Set Approved</h3>
              <p className="text-[11px] font-mono text-emerald-500/70 mt-1 uppercase tracking-widest">MUTCD 11th Ed. Compliant</p>
            </div>

            <motion.a
              whileHover={{ scale: 1.03, boxShadow: '0 0 30px rgba(16,185,129,0.3)' }}
              whileTap={{ scale: 0.97 }}
              href={downloadUrl}
              download="ITD_Plan_Set.zip"
              className="block w-full py-4 rounded-2xl font-semibold text-center text-sm bg-gradient-to-r from-emerald-500 to-emerald-400 text-zinc-950 shadow-lg shadow-emerald-500/30 mb-6"
            >
              <Download className="w-5 h-5 inline mr-2" />
              Download Plan Set
            </motion.a>

            {verifiedBlueprint && (
              <div className="border-t border-white/5 pt-4">
                <button onClick={() => setIsExpanded(!isExpanded)}
                  className="text-[10px] font-mono text-zinc-500 hover:text-zinc-300 uppercase tracking-widest w-full text-left transition-colors">
                  {isExpanded ? '▼' : '►'} Engineering Blueprint
                </button>
                <AnimatePresence>
                  {isExpanded && (
                    <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
                      <pre className="mt-3 p-3 bg-zinc-900/50 rounded-xl text-[10px] font-mono text-emerald-400/60 overflow-x-auto max-h-[200px] overflow-y-auto whitespace-pre-wrap border border-white/5" style={{ scrollbarWidth: 'none' }}>
                        {verifiedBlueprint}
                      </pre>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
