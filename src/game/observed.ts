/** Disk around Madeira. Tiles and weather outside this circle are never fetched. */
export const OBSERVED = {
  name: "Madeira",
  lat: 32.751,
  lon: -16.959,
  radiusM: 32_000,
  zoom: 11,
  segments: 80,
  sea: 0,
} as const;

const M_LAT = 111_320;

function clamp(v: number, a: number, b: number) {
  return Math.max(a, Math.min(b, v));
}

function metersPerLon() {
  return M_LAT * Math.cos((OBSERVED.lat * Math.PI) / 180);
}

function tileLat(y: number, n: number) {
  const t = Math.PI * (1 - (2 * y) / n);
  return (180 / Math.PI) * Math.atan(Math.sinh(t));
}

/** True only when the tile rectangle meets the observed disk. */
export function tileIntersectsRadius(z: number, x: number, y: number) {
  if (z !== OBSERVED.zoom) return false;
  const n = 2 ** z;
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= n || y >= n) return false;
  const west = (x / n) * 360 - 180;
  const east = ((x + 1) / n) * 360 - 180;
  const north = tileLat(y, n);
  const south = tileLat(y + 1, n);
  const lat = clamp(OBSERVED.lat, Math.min(south, north), Math.max(south, north));
  const lon = clamp(OBSERVED.lon, west, east);
  const dy = (lat - OBSERVED.lat) * M_LAT;
  const dx = (lon - OBSERVED.lon) * metersPerLon();
  return dx * dx + dy * dy <= OBSERVED.radiusM * OBSERVED.radiusM;
}

export function latLonToLocal(lat: number, lon: number) {
  return {
    x: (lon - OBSERVED.lon) * metersPerLon(),
    z: (OBSERVED.lat - lat) * M_LAT,
  };
}

export function localToLatLon(x: number, z: number) {
  return {
    lat: OBSERVED.lat - z / M_LAT,
    lon: OBSERVED.lon + x / metersPerLon(),
  };
}

/** True only for coordinates inside the observed disk. */
export function pointInsideRadius(lat: number, lon: number) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  const { x, z } = latLonToLocal(lat, lon);
  return x * x + z * z <= OBSERVED.radiusM * OBSERVED.radiusM;
}

const WEATHER_RING_M = 14_000;

/** Five sample points, all inside the disk. The weather route fetches only these. */
export const WEATHER_POINTS = [
  { id: "mitte", x: 0, z: 0 },
  { id: "nord", x: 0, z: -WEATHER_RING_M },
  { id: "ost", x: WEATHER_RING_M, z: 0 },
  { id: "sued", x: 0, z: WEATHER_RING_M },
  { id: "west", x: -WEATHER_RING_M, z: 0 },
].map((point) => {
  const geo = localToLatLon(point.x, point.z);
  return { ...point, lat: geo.lat, lon: geo.lon };
});
