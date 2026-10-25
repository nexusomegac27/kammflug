export type Field = {
  size: number;
  segments: number;
  sea: number;
  radiusM: number;
  heights: Float32Array;
  maxElev: number;
  tiles: number;
  source: string;
  spawn: { x: number; y: number; z: number };
};

function hash(ix: number, iz: number, salt = 0) {
  let n = Math.imul(ix + salt * 17, 374761393) + Math.imul(iz + salt * 3, 668265263);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}

/** Triangle-exact height of the terrain mesh. Outside the disk returns 0. */
export function sampleTerrain(field: Field, x: number, z: number) {
  const { size, segments, heights } = field;
  const half = size / 2;
  const u = (x + half) / size;
  const v = (z + half) / size;
  if (u <= 0 || v <= 0 || u >= 1 || v >= 1) return 0;
  const fx = u * segments;
  const fz = v * segments;
  const ix = Math.min(segments - 1, Math.floor(fx));
  const iz = Math.min(segments - 1, Math.floor(fz));
  const tx = fx - ix;
  const tz = fz - iz;
  const n = segments + 1;
  const ha = heights[iz * n + ix]!;
  const hb = heights[(iz + 1) * n + ix]!;
  const hc = heights[(iz + 1) * n + ix + 1]!;
  const hd = heights[iz * n + ix + 1]!;
  if (tx + tz <= 1) return ha * (1 - tx - tz) + hb * tz + hd * tx;
  return hd * (1 - tz) + hb * (1 - tx) + hc * (tx + tz - 1);
}

/** Solid floor: terrain or sea, whichever is higher. */
export function sampleFloor(field: Field, x: number, z: number) {
  return Math.max(sampleTerrain(field, x, z), field.sea);
}

type RGB = [number, number, number];

const DEEP: RGB = [0.1, 0.26, 0.32];
const SHALLOW: RGB = [0.32, 0.62, 0.6];
const SAND: RGB = [0.89, 0.76, 0.52];
const GRASS: RGB = [0.45, 0.64, 0.3];
const MEADOW: RGB = [0.22, 0.46, 0.27];
const ROCK: RGB = [0.55, 0.5, 0.44];
const SNOW: RGB = [0.95, 0.94, 0.91];

function mix(a: RGB, b: RGB, t: number, jitter: number): RGB {
  const k = Math.min(1, Math.max(0, t));
  return [
    Math.min(1, Math.max(0, a[0] + (b[0] - a[0]) * k + jitter)),
    Math.min(1, Math.max(0, a[1] + (b[1] - a[1]) * k + jitter * 0.85)),
    Math.min(1, Math.max(0, a[2] + (b[2] - a[2]) * k + jitter * 0.55)),
  ];
}

function colorAt(h: number, sea: number, ny: number, jitter: number): RGB {
  if (h < sea - 80) return mix(DEEP, DEEP, 0, jitter * 0.12);
  if (h < sea) return mix(DEEP, SHALLOW, (h - (sea - 80)) / 80, jitter * 0.18);
  if (ny < 0.58 && h > sea + 30) return mix(ROCK, SNOW, (h - 1450) / 400, jitter * 0.22);
  if (h < sea + 25) return mix(SAND, GRASS, (h - sea) / 25, jitter * 0.3);
  if (h < 650) return mix(GRASS, MEADOW, (h - 25) / 625, jitter * 0.35);
  if (h < 1300) return mix(MEADOW, ROCK, (h - 650) / 650, jitter * 0.28);
  return mix(ROCK, SNOW, (h - 1300) / 900, jitter * 0.16);
}

export type TerrainArrays = {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
};

export function buildTerrainArrays(field: Field): TerrainArrays {
  const { segments, size, heights, sea } = field;
  const n = segments + 1;
  const tris = segments * segments * 2;
  const positions = new Float32Array(tris * 9);
  const normals = new Float32Array(tris * 9);
  const colors = new Float32Array(tris * 9);
  let p = 0;

  const yAt = (ix: number, iz: number) => heights[iz * n + ix]!;
  const xAt = (ix: number) => (ix / segments - 0.5) * size;
  const zAt = (iz: number) => (iz / segments - 0.5) * size;

  const push = (
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    cx: number,
    cy: number,
    cz: number,
    ix: number,
    iz: number,
    salt: number,
  ) => {
    const abx = bx - ax;
    const aby = by - ay;
    const abz = bz - az;
    const acx = cx - ax;
    const acy = cy - ay;
    const acz = cz - az;
    let nx = aby * acz - abz * acy;
    let ny = abz * acx - abx * acz;
    let nz = abx * acy - aby * acx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    const jitter = (hash(ix, iz, salt) - 0.5) * 0.04;
    const col = colorAt((ay + by + cy) / 3, sea, ny, jitter);
    const verts = [ax, ay, az, bx, by, bz, cx, cy, cz];
    for (let i = 0; i < 3; i++) {
      positions[p] = verts[i * 3]!;
      positions[p + 1] = verts[i * 3 + 1]!;
      positions[p + 2] = verts[i * 3 + 2]!;
      normals[p] = nx;
      normals[p + 1] = ny;
      normals[p + 2] = nz;
      colors[p] = col[0];
      colors[p + 1] = col[1];
      colors[p + 2] = col[2];
      p += 3;
    }
  };

  for (let iz = 0; iz < segments; iz++) {
    for (let ix = 0; ix < segments; ix++) {
      const ax = xAt(ix);
      const az = zAt(iz);
      const bx = xAt(ix);
      const bz = zAt(iz + 1);
      const dx = xAt(ix + 1);
      const dz = zAt(iz);
      const cx = xAt(ix + 1);
      const cz = zAt(iz + 1);
      push(ax, yAt(ix, iz), az, bx, yAt(ix, iz + 1), bz, dx, yAt(ix + 1, iz), dz, ix, iz, 1);
      push(bx, yAt(ix, iz + 1), bz, cx, yAt(ix + 1, iz + 1), cz, dx, yAt(ix + 1, iz), dz, ix, iz, 2);
    }
  }

  return { positions, normals, colors };
}

