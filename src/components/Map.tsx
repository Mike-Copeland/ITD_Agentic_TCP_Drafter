import React, { useEffect, useRef } from 'react';
import { APIProvider, Map as GoogleMap, AdvancedMarker, Pin, useMap } from '@vis.gl/react-google-maps';
import { Loader2 } from 'lucide-react';

// Monkey-patch WebGL context creation so canvas.toDataURL() works on Google Maps.
// Must run before any canvas is created — preserveDrawingBuffer prevents the GPU
// from clearing the framebuffer after compositing.
if (typeof window !== 'undefined' && typeof HTMLCanvasElement !== 'undefined') {
  const origGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type: string, attrs?: any) {
    if (type === 'webgl' || type === 'webgl2') {
      attrs = { ...attrs, preserveDrawingBuffer: true };
    }
    return origGetContext.call(this, type, attrs);
  } as typeof origGetContext;
}

const defaultCenter = {
  lat: 44.0682,
  lng: -114.7420
};

interface MapProps {
  startCoords: { lat: number; lng: number } | null;
  endCoords: { lat: number; lng: number } | null;
  onPinDrop: (coords: { lat: number; lng: number }) => void;
  captureRef?: React.MutableRefObject<(() => string | null) | null>;
}

const API_KEY =
  process.env.GOOGLE_MAPS_PLATFORM_KEY ||
  (import.meta as any).env?.VITE_GOOGLE_MAPS_PLATFORM_KEY ||
  (globalThis as any).GOOGLE_MAPS_PLATFORM_KEY ||
  '';
const hasValidKey = Boolean(API_KEY) && API_KEY !== 'YOUR_API_KEY';

function PolylineComponent({ startCoords, endCoords }: { startCoords: any, endCoords: any }) {
  const map = useMap();
  const polylineRef = useRef<google.maps.Polyline | null>(null);

  useEffect(() => {
    if (!map) return;

    if (!polylineRef.current) {
      polylineRef.current = new google.maps.Polyline({
        strokeColor: '#10b981',
        strokeOpacity: 1,
        strokeWeight: 4,
        icons: [{
          icon: { path: 'M 0,-1 0,1', strokeOpacity: 1, scale: 4 },
          offset: '0',
          repeat: '20px'
        }]
      });
      polylineRef.current.setMap(map);
    }

    const path = [];
    if (startCoords) path.push(startCoords);
    if (endCoords) path.push(endCoords);
    
    polylineRef.current.setPath(path);

    return () => {
      if (polylineRef.current) {
        polylineRef.current.setMap(null);
      }
    };
  }, [map, startCoords, endCoords]);

  return null;
}

/** Wires the captureRef so App.tsx can grab the map canvas as JPEG base64 */
function MapCaptureWiring({ captureRef }: { captureRef?: React.MutableRefObject<(() => string | null) | null> }) {
  const map = useMap();
  useEffect(() => {
    if (!map || !captureRef) return;
    captureRef.current = () => {
      const div = map.getDiv();
      const canvas = div.querySelector('canvas');
      if (!canvas) return null;
      try {
        const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
        return dataUrl.split(',')[1] || null; // strip "data:image/jpeg;base64," prefix
      } catch {
        return null;
      }
    };
  }, [map, captureRef]);
  return null;
}

export default function Map({ startCoords, endCoords, onPinDrop, captureRef }: MapProps) {
  if (!hasValidKey) {
    return (
      <div className="h-full w-full flex flex-col items-center justify-center bg-zinc-900 border border-white/10 rounded-xl p-6 text-center">
        <h2 className="text-xl font-bold text-white mb-4">Google Maps API Key Required</h2>
        <p className="text-zinc-400 mb-2"><strong>Step 1:</strong> <a href="https://console.cloud.google.com/google/maps-apis/credentials" target="_blank" rel="noopener" className="text-emerald-400 hover:underline">Get an API Key</a></p>
        <p className="text-zinc-400 mb-4"><strong>Step 2:</strong> Add your key as a secret in AI Studio:</p>
        <ul className="text-left text-zinc-400 space-y-2 mb-4 list-disc pl-6">
          <li>Open <strong>Settings</strong> (⚙️ gear icon, <strong>top-right corner</strong>)</li>
          <li>Select <strong>Secrets</strong></li>
          <li>Type <code>GOOGLE_MAPS_PLATFORM_KEY</code> as the secret name, press <strong>Enter</strong></li>
          <li>Paste your API key as the value, press <strong>Enter</strong></li>
        </ul>
        <p className="text-zinc-500 text-sm">The app rebuilds automatically after you add the secret.</p>
      </div>
    );
  }

  return (
    <div className="h-full w-full rounded-xl overflow-hidden shadow-2xl border border-white/10 relative">
      <APIProvider apiKey={API_KEY} version="weekly">
        <GoogleMap
          defaultCenter={startCoords || defaultCenter}
          defaultZoom={startCoords ? 14 : 6}
          mapId="DEMO_MAP_ID"
          internalUsageAttributionIds={['gmp_mcp_codeassist_v1_aistudio']}
          style={{ width: '100%', height: '100%' }}
          mapTypeId="hybrid"
          disableDefaultUI={false}
          onClick={(e) => {
            if (e.detail.latLng) {
              onPinDrop({ lat: e.detail.latLng.lat, lng: e.detail.latLng.lng });
            }
          }}
        >
          {startCoords && (
            <AdvancedMarker position={startCoords} title="A">
              <Pin background="#10b981" glyphColor="#fff" borderColor="#047857" />
            </AdvancedMarker>
          )}
          {endCoords && (
            <AdvancedMarker position={endCoords} title="B">
              <Pin background="#ef4444" glyphColor="#fff" borderColor="#b91c1c" />
            </AdvancedMarker>
          )}
          <PolylineComponent startCoords={startCoords} endCoords={endCoords} />
          <MapCaptureWiring captureRef={captureRef} />
        </GoogleMap>
      </APIProvider>
    </div>
  );
}
