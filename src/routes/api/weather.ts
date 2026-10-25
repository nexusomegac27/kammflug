import { createFileRoute } from "@tanstack/react-router";
import { OBSERVED, pointInsideRadius, WEATHER_POINTS } from "@/game/observed";
import { WEATHER_FALLBACK } from "@/game/weather-fallback";

const UPSTREAM = "https://api.open-meteo.com/v1/forecast";
const CURRENT = [
  "temperature_2m",
  "relative_humidity_2m",
  "precipitation",
  "weather_code",
  "cloud_cover",
  "wind_speed_10m",
  "wind_direction_10m",
  "wind_gusts_10m",
  "visibility",
  "is_day",
].join(",");

type Cache = { at: number; body: string };
let fresh: Cache | null = null;
let blockedUntil = 0;
const FRESH_MS = 10 * 60 * 1000;
const STALE_MS = 6 * 60 * 60 * 1000;
const BLOCK_MS = 60 * 1000;

function jsonResponse(body: string, stale = false) {
  return new Response(body, {
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=600",
      "x-weather-source": "Open-Meteo",
      ...(stale ? { "x-weather-stale": "1" } : {}),
    },
  });
}

async function pullForecast() {
  let status = 502;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 1200));
    const upstream = await fetch(observedForecastUrl(), {
      headers: { "user-agent": "Kammflug/1.0 (Madeira observed radius)" },
      signal: AbortSignal.timeout(12_000),
    });
    if (upstream.ok) return upstream;
    status = upstream.status;
    if (status !== 429 && status !== 503) break;
  }
  return status;
}

function fallbackBody() {
  return JSON.stringify({
    source: "Open-Meteo",
    license: "CC-BY 4.0",
    name: OBSERVED.name,
    radiusM: OBSERVED.radiusM,
    samples: WEATHER_FALLBACK,
  });
}

function heldReading(now: number) {
  if (fresh && now - fresh.at < STALE_MS) return jsonResponse(fresh.body, true);
  return jsonResponse(fallbackBody(), true);
}

function observedForecastUrl() {
  const lats = WEATHER_POINTS.map((p) => p.lat.toFixed(5)).join(",");
  const lons = WEATHER_POINTS.map((p) => p.lon.toFixed(5)).join(",");
  return `${UPSTREAM}?latitude=${lats}&longitude=${lons}&current=${CURRENT}&wind_speed_unit=ms&timezone=Atlantic%2FMadeira`;
}

export const Route = createFileRoute("/api/weather")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const latRaw = url.searchParams.get("lat");
        const lonRaw = url.searchParams.get("lon");
        if (latRaw !== null || lonRaw !== null) {
          const lat = Number(latRaw);
          const lon = Number(lonRaw);
          if (latRaw === null || lonRaw === null || !pointInsideRadius(lat, lon)) {
            return new Response("outside observed radius", { status: 403 });
          }
        }

        const now = Date.now();
        if (fresh && now - fresh.at < FRESH_MS) return jsonResponse(fresh.body);
        if (now < blockedUntil) return heldReading(now);

        try {
          const upstream = await pullForecast();
          if (typeof upstream === "number") {
            blockedUntil = now + BLOCK_MS;
            return heldReading(now);
          }
          const points = (await upstream.json()) as unknown;
          const samples = Array.isArray(points) ? points : [points];
          const body = JSON.stringify({
            source: "Open-Meteo",
            license: "CC-BY 4.0",
            name: OBSERVED.name,
            radiusM: OBSERVED.radiusM,
            samples,
          });
          fresh = { at: now, body };
          blockedUntil = 0;
          return jsonResponse(body);
        } catch {
          blockedUntil = now + BLOCK_MS;
          return heldReading(now);
        }
      },
    },
  },
});
