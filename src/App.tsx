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

  const [operationType, setOperationType] = useState('Single Lane Closure');
  const [duration, setDuration] = useState('Short-term (<= 3 days)');
  const [normalSpeed, setNormalSpeed] = useState(65);
  const [workZoneSpeed, setWorkZoneSpeed] = useState(55);
  const [laneWidth, setLaneWidth] = useState(12);

  const [startCoords, setStartCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [endCoords, setEndCoords] = useState<{ lat: number; lng: number } | null>(null);

  const [loadingState, setLoadingState] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);

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
      const contextData = contextRes.ok ? await contextRes.json() : null;

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
          duration,
          routeDistanceFt: contextData?.routeDistanceFt || 0,
          roadName: contextData?.roadName || '',
          positionedCrossStreets: contextData?.positionedCrossStreets || [],
          itdTerrain: contextData?.itdTerrain || '',
          itdFuncClass: contextData?.itdFuncClass || '',
          itdTotalLanes: contextData?.itdTotalLanes || 0
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
    return <div className="min-h-screen bg-zinc-950 flex items-center justify-center text-white"><Loader2 className="animate-spin" /></div>;
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 font-sans flex flex-col">
      <header className="border-b border-white/10 bg-zinc-900/50 backdrop-blur-md px-6 py-4 flex items-center justify-between sticky top-0 z-50">
        <div className="flex items-center gap-3">
          <div className="bg-emerald-500/20 p-2 rounded-lg">
            <Settings className="w-5 h-5 text-emerald-400" />
          </div>
          <h1 className="text-xl font-semibold tracking-tight">ITD Agentic CAD Generator</h1>
        </div>
        <div>
          {user ? (
            <div className="flex items-center gap-4">
              <span className="text-sm text-zinc-400">{user.email}</span>
              <button onClick={logOut} className="flex items-center gap-2 text-sm bg-white/5 hover:bg-white/10 px-3 py-1.5 rounded-md transition-colors">
                <LogOut className="w-4 h-4" /> Sign Out
              </button>
            </div>
          ) : (
            <button onClick={signInWithGoogle} className="flex items-center gap-2 text-sm bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-2 rounded-md transition-colors font-medium">
              <LogIn className="w-4 h-4" /> Sign In with Google
            </button>
          )}
        </div>
      </header>

      <main className="flex-1 max-w-[1600px] w-full mx-auto p-6 grid grid-cols-1 lg:grid-cols-12 gap-6">
        <motion.div
          initial={{ opacity: 0, x: -20 }}
          animate={{ opacity: 1, x: 0 }}
          className="lg:col-span-4 flex flex-col gap-6"
        >
          <div className="bg-zinc-900 border border-white/10 rounded-2xl p-6 shadow-xl">
            <h2 className="text-lg font-medium mb-6 flex items-center gap-2">
              <FileText className="w-5 h-5 text-zinc-400" />
              The Cookie Recipe
            </h2>

            <div className="space-y-5">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-zinc-400 mb-1.5">Operation Type</label>
                  <select
                    value={operationType}
                    onChange={(e) => setOperationType(e.target.value)}
                    className="w-full bg-zinc-950 border border-white/10 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/50"
                  >
                    <option>Median Crossover</option>
                    <option>Single Lane Closure</option>
                    <option>Shoulder Work</option>
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-zinc-400 mb-1.5">Work Duration</label>
                  <select
                    value={duration}
                    onChange={(e) => setDuration(e.target.value)}
                    className="w-full bg-zinc-950 border border-white/10 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/50"
                  >
                    <option>Short-term (&lt;= 3 days)</option>
                    <option>Long-term (&gt; 3 days)</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-zinc-400 mb-1.5">Normal Speed (MPH)</label>
                  <input
                    type="number"
                    value={normalSpeed}
                    onChange={(e) => setNormalSpeed(Number(e.target.value))}
                    className="w-full bg-zinc-950 border border-white/10 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/50"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-zinc-400 mb-1.5">Work Zone Speed (MPH)</label>
                  <input
                    type="number"
                    value={workZoneSpeed}
                    onChange={(e) => setWorkZoneSpeed(Number(e.target.value))}
                    className="w-full bg-zinc-950 border border-white/10 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/50"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-zinc-400 mb-1.5">Lane Width (Feet)</label>
                <input
                  type="number"
                  value={laneWidth}
                  onChange={(e) => setLaneWidth(Number(e.target.value))}
                  className="w-full bg-zinc-950 border border-white/10 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/50"
                />
              </div>

              <div className="pt-4 border-t border-white/5 space-y-4">
                <div>
                  <label className="block text-sm font-medium text-zinc-400 mb-1.5 flex items-center gap-2">
                    <MapPin className="w-4 h-4 text-emerald-400" /> Start Coordinates
                  </label>
                  <input
                    readOnly
                    value={startCoords ? `${startCoords.lat.toFixed(5)}, ${startCoords.lng.toFixed(5)}` : 'Click map to set...'}
                    className="w-full bg-zinc-950/50 border border-white/5 rounded-lg px-3 py-2.5 text-sm text-zinc-500 cursor-not-allowed"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-zinc-400 mb-1.5 flex items-center gap-2">
                    <MapPin className="w-4 h-4 text-red-400" /> End Coordinates
                  </label>
                  <input
                    readOnly
                    value={endCoords ? `${endCoords.lat.toFixed(5)}, ${endCoords.lng.toFixed(5)}` : 'Click map to set...'}
                    className="w-full bg-zinc-950/50 border border-white/5 rounded-lg px-3 py-2.5 text-sm text-zinc-500 cursor-not-allowed"
                  />
                </div>

                <button
                  onClick={handleAnalyzeArea}
                  disabled={analysisLoading || !startCoords}
                  className="w-full bg-zinc-800 hover:bg-zinc-700 disabled:bg-zinc-900 disabled:text-zinc-600 text-zinc-200 font-medium py-2.5 rounded-lg transition-colors flex items-center justify-center gap-2 text-sm"
                >
                  {analysisLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <MapPin className="w-4 h-4" />}
                  Analyze Area Context (Google Maps)
                </button>

                <div className="bg-zinc-950/80 border border-white/5 rounded-lg p-4 text-sm text-zinc-300 leading-relaxed">
                  <h4 className="text-emerald-400 font-medium mb-2">Area Context</h4>
                  <textarea
                    value={areaAnalysis || ''}
                    onChange={(e) => setAreaAnalysis(e.target.value)}
                    placeholder="Click 'Analyze Area Context' or type manual site constraints here..."
                    className="w-full bg-transparent border-none outline-none resize-y min-h-[100px] text-zinc-300 placeholder:text-zinc-600"
                  />
                </div>
              </div>

              {error && (
                <div className="bg-red-500/10 border border-red-500/20 text-red-400 text-sm px-4 py-3 rounded-lg flex items-start gap-2">
                  <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
                  <p>{error}</p>
                </div>
              )}

              <button
                onClick={handleGenerate}
                disabled={loadingState > 0}
                className="w-full bg-emerald-600 hover:bg-emerald-500 disabled:bg-zinc-800 disabled:text-zinc-500 text-white font-semibold py-4 rounded-xl shadow-lg transition-all active:scale-[0.98] mt-4 flex items-center justify-center gap-2"
              >
                {loadingState > 0 ? (
                  <><Loader2 className="w-5 h-5 animate-spin" /> Generating Plan Set...</>
                ) : (
                  'Generate ITD Plan Set'
                )}
              </button>

            </div>
          </div>

          <AnimatePresence>
            {loadingState > 0 && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                className="bg-zinc-900 border border-white/10 rounded-2xl p-6 shadow-xl overflow-hidden"
              >
                <h3 className="text-sm font-medium text-zinc-400 mb-4 uppercase tracking-wider">AI Pipeline Status</h3>
                <div className="space-y-4">
                  <div className={`flex items-center gap-3 ${loadingState >= 1 ? 'text-emerald-400' : 'text-zinc-600'}`}>
                    {loadingState > 1 ? <CheckCircle className="w-5 h-5" /> : <Loader2 className={`w-5 h-5 ${loadingState === 1 ? 'animate-spin' : ''}`} />}
                    <span className="text-sm">Step 1: Fetching Omniscient State & RAG...</span>
                  </div>
                  <div className={`flex items-center gap-3 ${loadingState >= 2 ? 'text-emerald-400' : 'text-zinc-600'}`}>
                    {loadingState > 2 ? <CheckCircle className="w-5 h-5" /> : <Loader2 className={`w-5 h-5 ${loadingState === 2 ? 'animate-spin' : ''}`} />}
                    <span className="text-sm">Step 2: Senior PE Agent Analysis...</span>
                  </div>
                  <div className={`flex items-center gap-3 ${loadingState >= 3 ? 'text-emerald-400' : 'text-zinc-600'}`}>
                    {loadingState > 3 ? <CheckCircle className="w-5 h-5" /> : <Loader2 className={`w-5 h-5 ${loadingState === 3 ? 'animate-spin' : ''}`} />}
                    <span className="text-sm">Step 3: Deterministic CAD Drafting...</span>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <AnimatePresence>
            {downloadUrl && (
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                className="bg-emerald-950/30 border border-emerald-500/30 rounded-2xl p-6 shadow-xl"
              >
                <div className="flex flex-col items-center text-center mb-6">
                  <div className="w-12 h-12 bg-emerald-500/20 rounded-full flex items-center justify-center mb-4">
                    <CheckCircle className="w-6 h-6 text-emerald-400" />
                  </div>
                  <h3 className="text-lg font-medium text-emerald-100">Plan Set Ready</h3>
                  <p className="text-sm text-emerald-400/80 mt-1">DXF and PDF files generated successfully.</p>
                </div>

                <a
                  href={downloadUrl}
                  download="ITD_Plan_Set.zip"
                  className="w-full bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-semibold py-3 rounded-xl shadow-lg transition-all active:scale-[0.98] flex items-center justify-center gap-2 mb-4"
                >
                  <Download className="w-5 h-5" />
                  📦 Download Plan Set (.DXF & .PDF)
                </a>

                {eacrAudit && (
                  <div className="mt-4 border-t border-emerald-500/20 pt-4">
                    <h4 className="text-sm font-semibold text-red-400 mb-2">🚨 EACR Adversarial Red Team Attack</h4>
                    <p className="text-xs text-zinc-400 mb-4 italic">{eacrAudit.attack}</p>
                    <h4 className="text-sm font-semibold text-emerald-400 mb-2">🛡️ Senior PE Defense & Countermeasures</h4>
                    <p className="text-xs text-zinc-300">{eacrAudit.defense}</p>
                  </div>
                )}

                {verifiedBlueprint && (
                  <div className="mt-4 border-t border-emerald-500/20 pt-4">
                    <button
                      onClick={() => setIsExpanded(!isExpanded)}
                      className="text-sm text-emerald-400 hover:text-emerald-300 flex items-center justify-between w-full"
                    >
                      <span>Verified Math Blueprint</span>
                      <span className="text-xs bg-emerald-500/20 px-2 py-1 rounded">
                        {isExpanded ? 'Hide' : 'Show'}
                      </span>
                    </button>
                    <AnimatePresence>
                      {isExpanded && (
                        <motion.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: 'auto', opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          className="overflow-hidden"
                        >
                          <pre className="mt-4 p-4 bg-zinc-950 rounded-lg text-xs text-zinc-400 overflow-x-auto whitespace-pre-wrap font-mono border border-white/5">
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

        </motion.div>

        <motion.div
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          className="lg:col-span-8 h-[600px] lg:h-auto relative rounded-2xl overflow-hidden shadow-2xl border border-white/10"
        >
          <Map startCoords={startCoords} endCoords={endCoords} onPinDrop={handlePinDrop} captureRef={mapCaptureRef} />

          <div className="absolute top-4 left-1/2 -translate-x-1/2 z-[400] bg-zinc-900/90 backdrop-blur-md border border-white/10 px-4 py-2 rounded-full shadow-lg pointer-events-none">
            <p className="text-sm font-medium text-zinc-200">
              {!startCoords ? 'Click to drop Start Pin' : !endCoords ? 'Click to drop End Pin' : 'Pins set. Ready to generate.'}
            </p>
          </div>
        </motion.div>

      </main>
    </div>
  );
}
