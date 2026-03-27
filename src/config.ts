/**
 * Runtime config — fetches API keys from backend /api/config
 * In dev: falls back to process.env (injected by Vite)
 * In production: keys come from Cloud Run env vars via the backend
 */

interface AppConfig {
  geminiApiKey: string;
  mapsApiKey: string;
}

let cachedConfig: AppConfig | null = null;

export async function getConfig(): Promise<AppConfig> {
  if (cachedConfig) return cachedConfig;

  // Try fetching from backend first (production)
  try {
    const res = await fetch('/api/config');
    if (res.ok) {
      const data = await res.json();
      if (data.geminiApiKey || data.mapsApiKey) {
        cachedConfig = data;
        return cachedConfig;
      }
    }
  } catch {
    // Backend not available (dev mode with separate servers)
  }

  // Fallback to build-time env vars (dev mode)
  cachedConfig = {
    geminiApiKey: process.env.GEMINI_API_KEY || (import.meta as any).env?.VITE_GEMINI_API_KEY || '',
    mapsApiKey: process.env.GOOGLE_MAPS_PLATFORM_KEY || (import.meta as any).env?.VITE_GOOGLE_MAPS_PLATFORM_KEY || '',
  };
  return cachedConfig;
}

// Synchronous getter — returns cached value or empty (call getConfig() first)
export function getConfigSync(): AppConfig {
  return cachedConfig || {
    geminiApiKey: process.env.GEMINI_API_KEY || (import.meta as any).env?.VITE_GEMINI_API_KEY || '',
    mapsApiKey: process.env.GOOGLE_MAPS_PLATFORM_KEY || (import.meta as any).env?.VITE_GOOGLE_MAPS_PLATFORM_KEY || '',
  };
}
