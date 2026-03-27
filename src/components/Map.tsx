import React, { useEffect, useRef, useState } from 'react';
import { APIProvider, Map as GoogleMap, AdvancedMarker, Pin, useMap } from '@vis.gl/react-google-maps';
import { Loader2 } from 'lucide-react';
import { getConfig } from '../config';

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

// API key loaded async from backend /api/config
let _cachedMapsKey = process.env.GOOGLE_MAPS_PLATFORM_KEY || (import.meta as any).env?.VITE_GOOGLE_MAPS_PLATFORM_KEY || '';

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
  const [mapsKey, setMapsKey] = useState(_cachedMapsKey);
  const [loading, setLoading] = useState(!_cachedMapsKey);

  useEffect(() => {
    if (!_cachedMapsKey) {
      getConfig().then(cfg => {
        _cachedMapsKey = cfg.mapsApiKey;
        setMapsKey(cfg.mapsApiKey);
        setLoading(false);
      });
    }
  }, []);

  if (loading) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-zinc-900 border border-white/10 rounded-xl">
        <Loader2 className="w-8 h-8 animate-spin text-emerald-400" />
        <span className="ml-2 text-zinc-400">Loading map...</span>
      </div>
    );
  }

  if (!mapsKey) {
    return (
      <div className="h-full w-full flex flex-col items-center justify-center bg-zinc-900 border border-white/10 rounded-xl p-6 text-center">
        <h2 className="text-xl font-bold text-white mb-4">Google Maps API Key Required</h2>
        <p className="text-zinc-400">Contact your administrator for API access.</p>
      </div>
    );
  }

  return (
    <div className="h-full w-full rounded-xl overflow-hidden shadow-2xl border border-white/10 relative">
      <APIProvider apiKey={mapsKey} version="weekly">
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
