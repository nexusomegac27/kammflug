import { latLonToLocal, OBSERVED, pointInsideRadius, WEATHER_POINTS } from "./observed";
import { previewPathPrefix } from "@/lib/preview-path-prefix";

export type WeatherSample = {
  id: string;
  lat: number;
  lon: number;
  x: number;
  z: number;
  time: string;
  tempC: number;
  humidity: number;
  precipMm: number;
  code: number;
  cloud: number;
  windMs: number;
  gustMs: number;
  fromDeg: number;
  visibilityM: number;
  isDay: boolean;
};

/** Mutable sky the flight loop reads. Filled once; never replaced mid-frame. */
export type Sky = {
  ready: boolean;
  blend: number;
  samples: WeatherSample[];
  tempC: number;
  label: string;
  windMs: number;
  gustMs: number;
  fromDeg: number;
  cloud: number;
  precipMm: number;
  code: number;
  visibilityM: number;
  isDay: boolean;
  source: string;
};

export type WeatherStatus =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | {
      phase: "ready";
      tempC: number;
      label: string;
      windMs: number;
      gustMs: number;
      windFrom: string;
      cloudPct: number;
      precipMm: number;
      visibilityKm: number;
      isDay: boolean;
      points: number;
      observedAt: string;
      source: string;
    };

const CARDINALS = ["N", "NO", "O", "SO", "S", "SW", "W", "NW"];

export function emptySky(): Sky {
  return {
    ready: false,
    blend: 0,
    samples: [],
    tempC: 0,
    label: "",
    windMs: 0,
    gustMs: 0,
    fromDeg: 0,
    cloud: 0,
    precipMm: 0,
    code: 0,
    visibilityM: 40_000,
    isDay: true,
    source: "Open-Meteo",
  };
}

export function cardinalOf(deg: number) {
  const d = ((deg % 360) + 360) % 360;
  return CARDINALS[Math.round(d / 45) % 8]!;
}

export function weatherLabel(code: number) {
  if (code === 0) return "Klar";
  if (code === 1) return "Überwiegend klar";
  if (code === 2) return "Wechselnd bewölkt";
  if (code === 3) return "Bedeckt";
  if (code === 45 || code === 48) return "Nebel";
  if (code === 51 || code === 53 || code === 55) return "Niesel";
  if (code === 56 || code === 57) return "Gefrierender Niesel";
  if (code === 61 || code === 80) return "Leichter Regen";
  if (code === 63 || code === 81) return "Regen";
  if (code === 65 || code === 82) return "Starker Regen";
  if (code === 66 || code === 67) return "Gefrierender Regen";
  if (code === 71 || code === 85) return "Leichter Schnee";
  if (code === 73) return "Schnee";
  if (code === 75 || code === 86) return "Starker Schnee";
  if (code === 77) return "Schneegriesel";
  if (code === 95) return "Gewitter";
  if (code >= 96) return "Gewitter mit Hagel";
  return "Wetter";
}

function summaryLabel(code: number, cloud: number) {
  if (code >= 45) return weatherLabel(code);
  if (cloud < 0.12) return "Klar";
  if (cloud < 0.35) return "Überwiegend klar";
  if (cloud < 0.7) return "Wechselnd bewölkt";
  return "Bedeckt";
}

export function isWetCode(code: number) {
  return (code >= 51 && code <= 67) || (code >= 80 && code <= 82) || code >= 95;
}

export function isSnowCode(code: number) {
  return (code >= 71 && code <= 77) || code === 85 || code === 86;
}

export type SkyRead = {
  x: number;
  z: number;
  cloud: number;
  precip: number;
  wet: boolean;
  snow: boolean;
};

const skyRead: SkyRead = { x: 0, z: 0, cloud: 0.35, precip: 0, wet: false, snow: false };

/** Wind at a world point. Reuses one object — copy fields before the next call. */
export function readSky(sky: Sky, x: number, z: number, time: number): SkyRead {
  if (!sky.ready || sky.samples.length === 0) {
    skyRead.x = 0;
    skyRead.z = 0;
    skyRead.cloud = 0.35;
    skyRead.precip = 0;
    skyRead.wet = false;
    skyRead.snow = false;
    return skyRead;
  }
  let wx = 0;
  let wz = 0;
  let cloud = 0;
  let precip = 0;
  let wet = 0;
  let snow = 0;
  let wsum = 0;
  const samples = sky.samples;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!;
    const dx = x - s.x;
    const dz = z - s.z;
    const w = 1 / (dx * dx + dz * dz + 2_500_000);
    const pulse = 0.5 + 0.5 * Math.sin(time * 0.65 + s.x * 0.00008 + s.z * 0.00005);
    const gust = s.windMs + (s.gustMs - s.windMs) * pulse * pulse;
    const rad = (s.fromDeg * Math.PI) / 180;
    wx += -Math.sin(rad) * gust * w;
    wz += Math.cos(rad) * gust * w;
    cloud += s.cloud * w;
    precip += s.precipMm * w;
    if (isWetCode(s.code) || s.precipMm > 0.15) wet += w;
    if (isSnowCode(s.code)) snow += w;
    wsum += w;
  }
  const blend = sky.blend;
  const measuredCloud = cloud / wsum;
  skyRead.x = (wx / wsum) * blend;
  skyRead.z = (wz / wsum) * blend;
  skyRead.cloud = 0.35 + (measuredCloud - 0.35) * blend;
  skyRead.precip = (precip / wsum) * blend;
  skyRead.wet = wet / wsum > 0.35;
  skyRead.snow = snow / wsum > 0.35;
  return skyRead;
}

type UpstreamCurrent = {
  time?: string;
  temperature_2m?: number | null;
  relative_humidity_2m?: number | null;
  precipitation?: number | null;
  weather_code?: number | null;
  cloud_cover?: number | null;
  wind_speed_10m?: number | null;
  wind_direction_10m?: number | null;
  wind_gusts_10m?: number | null;
  visibility?: number | null;
  is_day?: number | null;
};

type UpstreamPoint = {
  latitude?: number;
  longitude?: number;
  current?: UpstreamCurrent;
};

function num(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function statusOf(sky: Sky): WeatherStatus {
  return {
    phase: "ready",
    tempC: Math.round(sky.tempC * 10) / 10,
    label: sky.label,
    windMs: Math.round(sky.windMs * 10) / 10,
    gustMs: Math.round(sky.gustMs * 10) / 10,
    windFrom: cardinalOf(sky.fromDeg),
    cloudPct: Math.round(sky.cloud * 100),
    precipMm: Math.round(sky.precipMm * 10) / 10,
    visibilityKm: Math.round(sky.visibilityM / 100) / 10,
    isDay: sky.isDay,
    points: sky.samples.length,
    observedAt: sky.samples[0]?.time.slice(11, 16) ?? "",
    source: sky.source,
  };
}

function applySamples(sky: Sky, samples: WeatherSample[]) {
  let temp = 0;
  let cloud = 0;
  let precip = 0;
  let gust = 0;
  let vis = Number.POSITIVE_INFINITY;
  let day = 0;
  let sx = 0;
  let sz = 0;
  let pick = samples[0]!;
  let pickScore = -1;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!;
    temp += s.tempC;
    cloud += s.cloud;
    precip = Math.max(precip, s.precipMm);
    gust = Math.max(gust, s.gustMs);
    vis = Math.min(vis, s.visibilityM);
    if (s.isDay) day += 1;
    const rad = (s.fromDeg * Math.PI) / 180;
    sx += -Math.sin(rad) * s.windMs;
    sz += Math.cos(rad) * s.windMs;
    const wet = isWetCode(s.code) || isSnowCode(s.code) ? 5 : 0;
    const score = s.precipMm * 20 + wet + s.cloud;
    if (score > pickScore) {
      pickScore = score;
      pick = s;
    }
  }
  const n = samples.length;
  const meanCloud = cloud / n;
  sky.samples = samples;
  sky.tempC = temp / n;
  sky.cloud = meanCloud;
  sky.precipMm = precip;
  sky.gustMs = gust;
  sky.windMs = Math.hypot(sx, sz) / n;
  sky.fromDeg = ((Math.atan2(-sx, sz) * 180) / Math.PI + 360) % 360;
  sky.code = pick.code;
  sky.label = summaryLabel(pick.code, meanCloud);
  sky.visibilityM = Number.isFinite(vis) ? vis : 40_000;
  sky.isDay = day * 2 >= n;
  sky.source = "Open-Meteo";
  sky.ready = true;
}

export async function loadObservedWeather(sky: Sky, signal: AbortSignal): Promise<WeatherStatus> {
  const origin =
    typeof window === "undefined"
      ? ""
      : (previewPathPrefix(window.location.hostname, window.location.pathname) ?? "");
  let last: WeatherStatus = { phase: "error", message: "Wetter gerade nicht erreichbar" };
  for (let attempt = 0; attempt < 3; attempt++) {
    if (signal.aborted) throw new DOMException("aborted", "AbortError");
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 1200));
    const res = await fetch(`${origin}/api/weather`, { signal });
    if (res.status === 403) return { phase: "error", message: "Wetter außerhalb des Radius abgelehnt" };
    if (!res.ok) continue;
    const body = (await res.json()) as { samples?: UpstreamPoint[] };
    const raw = body.samples ?? [];
    const samples: WeatherSample[] = [];
    for (let i = 0; i < raw.length; i++) {
      const point = raw[i];
      const current = point?.current;
      if (!point || !current) continue;
      const lat = num(point.latitude, WEATHER_POINTS[i]?.lat ?? Number.NaN);
      const lon = num(point.longitude, WEATHER_POINTS[i]?.lon ?? Number.NaN);
      if (!pointInsideRadius(lat, lon)) continue;
      const local = latLonToLocal(lat, lon);
      const wind = Math.max(0, num(current.wind_speed_10m, 0));
      const gust = Math.max(wind, num(current.wind_gusts_10m, wind));
      samples.push({
        id: WEATHER_POINTS[i]?.id ?? `p${i}`,
        lat,
        lon,
        x: local.x,
        z: local.z,
        time: current.time ?? "",
        tempC: num(current.temperature_2m, 16),
        humidity: num(current.relative_humidity_2m, 0),
        precipMm: Math.max(0, num(current.precipitation, 0)),
        code: Math.round(num(current.weather_code, 0)),
        cloud: Math.min(1, Math.max(0, num(current.cloud_cover, 0) / 100)),
        windMs: wind,
        gustMs: gust,
        fromDeg: ((num(current.wind_direction_10m, 0) % 360) + 360) % 360,
        visibilityM: Math.max(500, num(current.visibility, 30_000)),
        isDay: num(current.is_day, 1) >= 0.5,
      });
    }
    if (samples.length === 0) {
      last = { phase: "error", message: "Keine Wetterpunkte im Radius" };
      continue;
    }
    applySamples(sky, samples);
    return statusOf(sky);
  }
  return last;
}

export const WEATHER_RADIUS_KM = OBSERVED.radiusM / 1000;
