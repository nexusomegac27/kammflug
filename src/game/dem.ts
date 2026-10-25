import type { Field } from "./heightfield";
import { OBSERVED } from "./observed";
import { previewPathPrefix } from "@/lib/preview-path-prefix";

export { OBSERVED };

const TILE_PATH = "/api/dem-tile";

export type DemStatus =
  | { phase: "loading"; done: number; total: number }
  | { phase: "ready"; tiles: number; maxElev: number; radiusKm: number; source: string }
  | { phase: "error"; message: string };

type Tile = { w: number; data: Uint8ClampedArray };

export async function loadObservedDem(
  onProgress: (done: number, total: number) => void,
  signal: AbortSignal,
): Promise<Field> {
  const { lat, lon, radiusM, zoom, segments, sea } = OBSERVED;
  const mLat = 111_320;
  const mLon = 111_320 * Math.cos((lat * Math.PI) / 180);
  const size = radiusM * 2;
  const n = segments + 1;
  const needed = new Set<string>();

  const toTile = (x: number, z: number) => {
    const longitude = lon + x / mLon;
    const latitude = lat - z / mLat;
    const nTiles = 2 ** zoom;
    const fx = ((longitude + 180) / 360) * nTiles;
    const r = (latitude * Math.PI) / 180;
    const fy = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * nTiles;
    return { fx, fy, tx: Math.floor(fx), ty: Math.floor(fy) };
  };

  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const x = (ix / segments - 0.5) * size;
      const z = (iz / segments - 0.5) * size;
      if (x * x + z * z > radiusM * radiusM) continue;
      const { tx, ty } = toTile(x, z);
      needed.add(`${tx},${ty}`);
    }
  }

  const keys = [...needed];
  onProgress(0, keys.length);
  const tiles = new Map<string, Tile>();
  let source = "Terrarium";
  const sources = new Set<string>();
  let cursor = 0;
  let done = 0;

  async function worker() {
    while (cursor < keys.length) {
      const key = keys[cursor++]!;
      if (signal.aborted) return;
      const [tx, ty] = key.split(",");
      const res = await fetch(`${tileOrigin()}${TILE_PATH}/${zoom}/${tx}/${ty}`, { signal });
      if (!res.ok) throw new Error(`Höhenkachel ${zoom}/${tx}/${ty} antwortete ${res.status}`);
      const declared = res.headers.get("x-dem-source") ?? "";
      const label = labelSource(declared);
      if (label) sources.add(label);
      const bitmap = await createImageBitmap(await res.blob());
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) throw new Error("Höhenkachel ließ sich nicht lesen");
      const width = bitmap.width;
      ctx.drawImage(bitmap, 0, 0);
      const image = ctx.getImageData(0, 0, width, width);
      bitmap.close();
      tiles.set(key, { w: width, data: image.data });
      done += 1;
      onProgress(done, keys.length);
    }
  }

  const workers = Math.min(6, keys.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));
  if (signal.aborted) throw new DOMException("aborted", "AbortError");
  if (tiles.size === 0) throw new Error("Keine Höhenkachel im Radius");
  if (sources.size > 0) source = [...sources].join(" · ");

  const decode = (tile: Tile, px: number, py: number) => {
    const x = Math.max(0, Math.min(tile.w - 1, px));
    const y = Math.max(0, Math.min(tile.w - 1, py));
    const i = (y * tile.w + x) * 4;
    const d = tile.data;
    return d[i]! * 256 + d[i + 1]! + d[i + 2]! / 256 - 32768;
  };

  const sample = (fx: number, fy: number) => {
    let tx = Math.floor(fx);
    let ty = Math.floor(fy);
    let px = (fx - tx) * 256;
    let py = (fy - ty) * 256;
    if (px < 0) {
      px += 256;
      tx -= 1;
    }
    if (py < 0) {
      py += 256;
      ty -= 1;
    }
    const x0 = Math.floor(px);
    const y0 = Math.floor(py);
    const sx = px - x0;
    const sy = py - y0;
    const at = (ox: number, oy: number) => {
      let ix = x0 + ox;
      let iy = y0 + oy;
      let gx = tx;
      let gy = ty;
      if (ix >= 256) {
        ix -= 256;
        gx += 1;
      }
      if (iy >= 256) {
        iy -= 256;
        gy += 1;
      }
      const tile = tiles.get(`${gx},${gy}`);
      if (!tile) return 0;
      return decode(tile, ix, iy);
    };
    const e00 = at(0, 0);
    const e10 = at(1, 0);
    const e01 = at(0, 1);
    const e11 = at(1, 1);
    return e00 * (1 - sx) * (1 - sy) + e10 * sx * (1 - sy) + e01 * (1 - sx) * sy + e11 * sx * sy;
  };

  const heights = new Float32Array(n * n);
  let maxElev = 0;
  let spawnX = 0;
  let spawnZ = radiusM * 0.28;
  let spawnH = 0;
  let spawnScore = Number.POSITIVE_INFINITY;
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const x = (ix / segments - 0.5) * size;
      const z = (iz / segments - 0.5) * size;
      const i = iz * n + ix;
      if (x * x + z * z > radiusM * radiusM) {
        heights[i] = sea;
        continue;
      }
      const { fx, fy } = toTile(x, z);
      const h = sample(fx, fy);
      heights[i] = h;
      if (h > maxElev) maxElev = h;
      if (z > 0 && h > 4 && h < 90) {
        const score = Math.abs(x) * 0.35 + Math.abs(z - radiusM * 0.42);
        if (score < spawnScore) {
          spawnScore = score;
          spawnX = x;
          spawnZ = z;
          spawnH = h;
        }
      }
    }
  }

  return {
    size,
    segments,
    sea,
    radiusM,
    heights,
    maxElev,
    tiles: tiles.size,
    source,
    spawn: { x: spawnX, y: Math.max(spawnH, sea) + 260, z: spawnZ },
  };
}

function tileOrigin() {
  if (typeof window === "undefined") return "";
  return previewPathPrefix(window.location.hostname, window.location.pathname) ?? "";
}

function labelSource(raw: string) {
  const s = raw.toLowerCase();
  if (s.includes("eudem")) return "EU-DEM";
  if (s.includes("srtm")) return "SRTM";
  if (s.includes("gmted")) return "GMTED";
  if (s.includes("ned")) return "NED";
  const head = raw.split("/")[0];
  return head || "";
}
