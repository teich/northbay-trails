// Fetches and processes the map data for the North Bay Trails model: one continuous painted
// region from Monte Rio to Moore Creek, with the trails of a few parks drawn on it.
//
//   node scripts/build-data.mjs            (uses .cache/ when present)
//   node scripts/build-data.mjs --refresh  (re-downloads everything)
//
// Sources:
//   - OpenStreetMap via Overpass: park boundaries, trails, lakes, peaks, towns
//   - AWS Terrain Tiles (Terrarium): elevation
//
// Outputs (public/data/):
//   terrain.bin   Uint16 heights (meters * 4), row 0 = north edge
//   map.json      grid metadata, park outlines, water, labels
//   trails.json   trails grouped by park + name, with draped 3D polylines + stats

import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const CACHE = path.join(ROOT, '.cache');
const OUT = path.join(ROOT, 'public', 'data');
const REFRESH = process.argv.includes('--refresh');
fs.mkdirSync(path.join(CACHE, 'tiles'), { recursive: true });

const M_PER_DEG_LAT = 111320;

// ---------------------------------------------------------------------------
// The region and its parks

const BBOX = { west: -123.065, east: -122.33, south: 38.36, north: 38.585 };
const GRID_SPACING = 30; // meters between terrain samples
const DEM_ZOOM = 13;
const EXAGGERATION = 3; // the hills here are low; Tahoe used 2.3 on mountains twice as tall

// Each park's trails are drawn and listed. Add a park here to add it to the map.
//
//   park      the outline: OSM element ids, or a hand-drawn ring of [lon, lat]
//   buffer    meters outside the outline a trail may still count as part of the park
//             (trailheads, connectors, neighboring open space)
//   exclude   trail names to drop, with the reason
const PARKS = [
  {
    id: 'monte-rio',
    name: 'Monte Rio',
    long: 'Monte Rio Redwoods',
    park: { osm: ['way/1224024281', 'way/1224024282', 'way/1224024283'] },
    buffer: 450,
    exclude: {},
  },
  {
    id: 'annadel',
    name: 'Annadel',
    long: 'Trione-Annadel State Park',
    park: { osm: ['relation/181062', 'way/195463377', 'way/195463277'] }, // Annadel + Spring Lake + Howarth
    buffer: 120,
    exclude: {},
  },
  {
    id: 'moore-creek',
    name: 'Moore Creek',
    long: 'Moore Creek Park',
    // OSM has no outline for the park; this is drawn around its signed bike trails
    park: {
      ring: [
        [-122.4005, 38.5605], [-122.3835, 38.5005], [-122.3665, 38.4865], [-122.358, 38.4855],
        [-122.3505, 38.4885], [-122.3495, 38.4915], [-122.353, 38.513], [-122.357, 38.5215],
        [-122.377, 38.554], [-122.3825, 38.5575], [-122.3945, 38.5625],
      ],
    },
    buffer: 150,
    exclude: {},
  },
];

// ---------------------------------------------------------------------------
// Fetch helpers

async function cached(name, fetcher) {
  const file = path.join(CACHE, name);
  if (!REFRESH && fs.existsSync(file)) return fs.readFileSync(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  console.log(`  fetching ${name}…`);
  const buf = await fetcher();
  fs.writeFileSync(file, buf);
  return buf;
}

async function get(url, init) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'northbay-trails-model/0.1' }, ...init });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      if (attempt === 4) throw err;
      console.log(`  retrying ${url.slice(0, 80)} (${err.message})`);
      await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
    }
  }
}

const overpass = (query) =>
  get('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    body: new URLSearchParams({ data: query }),
  });

// ---------------------------------------------------------------------------
// Geometry helpers

function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// polygons: [{outer: ring, inner: [ring]}]
function pointInPolygons(x, y, polygons) {
  for (const p of polygons) {
    if (x < p.bbox[0] || x > p.bbox[2] || y < p.bbox[1] || y > p.bbox[3]) continue;
    if (pointInRing(x, y, p.outer) && !p.inner.some((r) => pointInRing(x, y, r))) return true;
  }
  return false;
}

function distToRing(x, y, ring) {
  let best = Infinity;
  for (let i = 1; i < ring.length; i++) {
    const [ax, ay] = ring[i - 1];
    const [bx, by] = ring[i];
    const dx = bx - ax;
    const dy = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, Math.hypot(x - ax - t * dx, y - ay - t * dy));
  }
  return best;
}

function ringBBox(ring) {
  let b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of ring) b = [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)];
  return b;
}

function ringArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  return Math.abs(a / 2);
}

// Join open way fragments into closed rings (for OSM multipolygon relations)
function assembleRings(lines) {
  const key = (p) => `${p[0].toFixed(7)},${p[1].toFixed(7)}`;
  const pending = lines.filter((l) => l.length > 1).map((l) => l.slice());
  const rings = [];
  while (pending.length) {
    let ring = pending.shift();
    let guard = 0;
    while (key(ring[0]) !== key(ring[ring.length - 1]) && guard++ < 10000) {
      const end = key(ring[ring.length - 1]);
      const idx = pending.findIndex((l) => key(l[0]) === end || key(l[l.length - 1]) === end);
      if (idx < 0) break;
      let next = pending.splice(idx, 1)[0];
      if (key(next[0]) !== end) next = next.reverse();
      ring = ring.concat(next.slice(1));
    }
    if (ring.length >= 4) rings.push(ring);
  }
  return rings;
}

// Douglas-Peucker
function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = pts[a];
    const [bx, by] = pts[b];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy || 1;
    let maxD = 0;
    let idx = -1;
    for (let i = a + 1; i < b; i++) {
      const t = Math.max(0, Math.min(1, ((pts[i][0] - ax) * dx + (pts[i][1] - ay) * dy) / len2));
      const d = Math.hypot(pts[i][0] - ax - t * dx, pts[i][1] - ay - t * dy);
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (maxD > tol) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

function lineLength(pts) {
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return d;
}

function densify(pts, step) {
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1];
    const [bx, by] = pts[i];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
    for (let k = 1; k <= n; k++) out.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]);
  }
  return out;
}

const round = (ring) => ring.map(([x, y]) => [Math.round(x), Math.round(y)]);

// ---------------------------------------------------------------------------

{
  const LAT0 = (BBOX.south + BBOX.north) / 2;
  const M_PER_DEG_LON = 111320 * Math.cos((LAT0 * Math.PI) / 180);
  const WIDTH_M = (BBOX.east - BBOX.west) * M_PER_DEG_LON;
  const HEIGHT_M = (BBOX.north - BBOX.south) * M_PER_DEG_LAT;
  const project = (lon, lat) => [(lon - BBOX.west) * M_PER_DEG_LON, (lat - BBOX.south) * M_PER_DEG_LAT];
  const inExtent = ([x, y]) => x >= 0 && y >= 0 && x <= WIDTH_M && y <= HEIGHT_M;
  const box = `${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east}`;
  const out = OUT;
  fs.mkdirSync(out, { recursive: true });

  function osmPolygons(el) {
    const toXY = (g) => g.map((p) => project(p.lon, p.lat));
    if (el.type === 'way') {
      const ring = toXY(el.geometry);
      return [{ outer: ring, inner: [], bbox: ringBBox(ring) }];
    }
    if (!el.members) return [];
    const outers = assembleRings(el.members.filter((m) => m.role !== 'inner' && m.geometry).map((m) => toXY(m.geometry)));
    const inners = assembleRings(el.members.filter((m) => m.role === 'inner' && m.geometry).map((m) => toXY(m.geometry)));
    return outers.map((outer) => ({
      outer,
      inner: inners.filter((r) => pointInRing(r[0][0], r[0][1], outer)),
      bbox: ringBBox(outer),
    }));
  }

  // --- 1. Park outlines
  console.log('Park outlines');
  const osmIds = PARKS.flatMap((p) => p.park.osm ?? []).map((s) => s.split('/'));
  const osmPark = JSON.parse(
    await cached('parks.json', () => overpass(`[out:json][timeout:90];(${osmIds.map(([type, id]) => `${type}(${id});`).join('')});out body geom;`)),
  );
  for (const p of PARKS) {
    p.polys = [];
    if (p.park.osm) {
      for (const ref of p.park.osm) {
        const [type, id] = ref.split('/');
        const el = osmPark.elements.find((e) => e.type === type && String(e.id) === id);
        if (!el) throw new Error(`${p.name}: no OSM ${ref}`);
        p.polys.push(...osmPolygons(el));
      }
    } else {
      const ring = p.park.ring.map(([lon, lat]) => project(lon, lat));
      ring.push(ring[0]);
      p.polys.push({ outer: ring, inner: [], bbox: ringBBox(ring) });
    }
    p.near = (x, y) => pointInPolygons(x, y, p.polys) || p.polys.some((q) => distToRing(x, y, q.outer) < p.buffer);
    console.log(`  ${p.long}: ${(p.polys.reduce((a, q) => a + ringArea(q.outer), 0) / 1e6).toFixed(1)} km²`);
  }

  // --- 2. Terrain
  console.log('Terrain');
  const lon2tile = (lon) => ((lon + 180) / 360) * 2 ** DEM_ZOOM;
  const lat2tile = (lat) => ((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * 2 ** DEM_ZOOM;
  const tiles = new Map();
  for (let tx = Math.floor(lon2tile(BBOX.west)); tx <= Math.floor(lon2tile(BBOX.east)); tx++) {
    for (let ty = Math.floor(lat2tile(BBOX.north)); ty <= Math.floor(lat2tile(BBOX.south)); ty++) {
      const buf = await cached(`tiles/${DEM_ZOOM}-${tx}-${ty}.png`, () =>
        get(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${DEM_ZOOM}/${tx}/${ty}.png`),
      );
      tiles.set(`${tx},${ty}`, PNG.sync.read(buf));
    }
  }
  function demPixel(px, py) {
    const tx = Math.floor(px / 256);
    const ty = Math.floor(py / 256);
    const t = tiles.get(`${tx},${ty}`);
    if (!t) return 0;
    const i = ((py - ty * 256) * 256 + (px - tx * 256)) * 4;
    return t.data[i] * 256 + t.data[i + 1] + t.data[i + 2] / 256 - 32768;
  }
  function demAt(x, y) {
    const lon = BBOX.west + x / M_PER_DEG_LON;
    const lat = BBOX.south + y / M_PER_DEG_LAT;
    const fx = lon2tile(lon) * 256 - 0.5;
    const fy = lat2tile(lat) * 256 - 0.5;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const u = fx - x0;
    const v = fy - y0;
    return (
      demPixel(x0, y0) * (1 - u) * (1 - v) +
      demPixel(x0 + 1, y0) * u * (1 - v) +
      demPixel(x0, y0 + 1) * (1 - u) * v +
      demPixel(x0 + 1, y0 + 1) * u * v
    );
  }
  const gridW = Math.round(WIDTH_M / GRID_SPACING) + 1;
  const gridH = Math.round(HEIGHT_M / GRID_SPACING) + 1;
  const heights = new Uint16Array(gridW * gridH);
  let minEle = Infinity;
  let maxEle = -Infinity;
  for (let j = 0; j < gridH; j++) {
    const y = HEIGHT_M - (j / (gridH - 1)) * HEIGHT_M;
    for (let i = 0; i < gridW; i++) {
      const e = Math.max(0, demAt((i / (gridW - 1)) * WIDTH_M, y));
      minEle = Math.min(minEle, e);
      maxEle = Math.max(maxEle, e);
      heights[j * gridW + i] = Math.round(e * 4);
    }
  }
  fs.writeFileSync(path.join(out, 'terrain.bin'), Buffer.from(heights.buffer));
  console.log(`  ${gridW}×${gridH} grid at ${GRID_SPACING} m, ${minEle.toFixed(0)}–${maxEle.toFixed(0)} m`);

  // --- 3. OSM context: water, peaks, towns
  console.log('OSM context');
  const osmCtx = JSON.parse(
    await cached('context.json', () =>
      overpass(`[out:json][timeout:180];
(
 way["natural"="water"](${box});
 relation["natural"="water"](${box});
 way["waterway"="riverbank"](${box});
 node["natural"="peak"]["name"](${box});
 node["place"~"^(town|village|hamlet|city)$"](${box});
);
out body geom;`),
    ),
  );
  const lakes = [];
  const labels = [];
  for (const el of osmCtx.elements) {
    const t = el.tags || {};
    if ((t.natural === 'water' || t.waterway === 'riverbank') && (el.type === 'way' || el.type === 'relation')) {
      if (t.water && !['lake', 'reservoir', 'pond', 'river', 'oxbow'].includes(t.water)) continue;
      const river = t.water === 'river' || t.waterway === 'riverbank';
      for (const poly of osmPolygons(el)) {
        const area_ = ringArea(poly.outer);
        if (area_ < (river ? 4000 : 15000) || !poly.outer.some(inExtent)) continue;
        // Water surface: low percentile of DEM along the shore
        const shore = poly.outer.filter(inExtent).map(([x, y]) => demAt(x, y)).sort((a, b) => a - b);
        const level = shore[Math.floor(shore.length * (river ? 0.1 : 0.2))];
        lakes.push({
          name: t.name || null,
          area: Math.round(area_),
          level: Math.round(level * 10) / 10,
          river,
          outer: round(simplify(poly.outer, 4)),
          inner: poly.inner.map((r) => round(simplify(r, 4))),
        });
      }
    } else if (t.natural === 'peak') {
      const [x, y] = project(el.lon, el.lat);
      if (!inExtent([x, y])) continue;
      labels.push({ kind: 'peak', name: t.name, x: Math.round(x), y: Math.round(y), ele: Math.round(t.ele ? parseFloat(t.ele) : demAt(x, y)) });
    } else if (t.place) {
      const [x, y] = project(el.lon, el.lat);
      if (!inExtent([x, y])) continue;
      const kind = t.place === 'town' || t.place === 'city' ? 'town' : 'village';
      labels.push({ kind, name: t.name, x: Math.round(x), y: Math.round(y) });
    }
  }
  // Named lake labels at a point well inside the lake
  for (const lake of lakes) {
    if (!lake.name || lake.river || lake.area < 15000 || /effluent|treatment|settling|^pond [a-z0-9]$/i.test(lake.name)) continue;
    const b = ringBBox(lake.outer);
    let best = null;
    const steps = 24;
    for (let i = 1; i < steps; i++) {
      for (let j = 1; j < steps; j++) {
        const x = b[0] + ((b[2] - b[0]) * i) / steps;
        const y = b[1] + ((b[3] - b[1]) * j) / steps;
        if (!pointInRing(x, y, lake.outer) || !inExtent([x, y])) continue;
        let d = Infinity;
        for (const [px, py] of lake.outer) d = Math.min(d, Math.hypot(px - x, py - y));
        if (!best || d > best.d) best = { x, y, d };
      }
    }
    if (best) labels.push({ kind: 'lake', name: lake.name, x: Math.round(best.x), y: Math.round(best.y), area: lake.area });
  }
  console.log(`  ${lakes.length} water bodies, ${labels.length} labels`);

  // --- 4. Trails
  console.log('Trails');
  const osmTrails = JSON.parse(
    await cached('trails.json', () =>
      overpass(`[out:json][timeout:180];
(
 way["highway"~"^(path|footway|track|bridleway)$"]["name"](${box});
);
out tags geom;`),
    ),
  );

  const NOT_A_TRAIL = /bike path|shared use path|climb|boulder|approach|snow storage|parcourse|decommis|^\d+$|driveway|bushwhack/i;
  const TRAILISH = /trail|loop|connector|cutoff|spur|fire road|\bf\.?r\.?\b|path|vista|overlook|dh\b/i;
  const segments = [];
  const dropped = new Map();
  for (const w of osmTrails.elements) {
    const t = w.tags;
    const name = t.name.trim();
    if (NOT_A_TRAIL.test(name)) continue;
    if (['private', 'no'].includes(t.access) || t.informal === 'yes' || t.footway === 'sidewalk' || t.footway === 'crossing') continue;
    if (t.highway === 'footway' && !TRAILISH.test(name)) continue;
    const pts = w.geometry.map((p) => project(p.lon, p.lat));
    const sample = densify(pts, 40);
    let park = null;
    let share = 0;
    for (const p of PARKS) {
      const s = sample.filter(([x, y]) => p.near(x, y)).length / sample.length;
      if (s > share) [park, share] = [p, s];
    }
    if (share < 0.5) {
      if (share > 0) dropped.set(name, park.name);
      continue;
    }
    if (park.exclude[name]) continue;
    let bike = null;
    if (['yes', 'designated', 'permissive'].includes(t.bicycle) || t['mtb:scale'] != null) bike = true;
    else if (['no', 'dismount'].includes(t.bicycle)) bike = false;
    const bikeInferred = bike === null;
    if (bike === null) bike = t.highway !== 'footway';
    segments.push({
      park: park.id,
      name,
      pts,
      hike: t.foot !== 'no',
      bike,
      bikeInferred,
      mtbScale: t['mtb:scale'] ?? null,
      sacScale: t.sac_scale ?? null,
      surface: t.surface ?? null,
      operator: t.operator ?? null,
      fireRoad: t.highway === 'track',
    });
  }
  console.log(`  ${segments.length} OSM segments kept`);
  if (dropped.size) console.log(`  just outside a park (dropped): ${[...dropped].map(([n, p]) => `${n} (${p})`).sort().join(', ')}`);

  const normName = (n) =>
    n
      .replace(/\s*\(.*?\)\s*/g, ' ')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, '')
      .replace(/\b(trail|trails|tr)\b/g, '')
      .replace(/\s+/g, ' ')
      .trim();

  const byName = new Map();
  for (const s of segments) {
    const k = `${s.park}|${normName(s.name)}`;
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(s);
  }

  function components(segs, tol) {
    const parent = segs.map((_, i) => i);
    const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (let i = 0; i < segs.length; i++) {
      for (let j = i + 1; j < segs.length; j++) {
        if (find(i) === find(j)) continue;
        const a = segs[i].pts;
        const b = segs[j].pts;
        let near = false;
        for (const p of [a[0], a[a.length - 1]]) for (const q of b) if (Math.hypot(p[0] - q[0], p[1] - q[1]) < tol) near = true;
        for (const p of [b[0], b[b.length - 1]]) for (const q of a) if (Math.hypot(p[0] - q[0], p[1] - q[1]) < tol) near = true;
        if (near) parent[find(i)] = find(j);
      }
    }
    const groups = new Map();
    segs.forEach((s, i) => {
      const r = find(i);
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r).push(s);
    });
    return [...groups.values()];
  }

  // Chain segments that share endpoints into longer polylines
  function chain(segs) {
    const lines = segs.map((s) => s.pts.slice());
    const close = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 3;
    let merged = true;
    while (merged) {
      merged = false;
      outer: for (let i = 0; i < lines.length; i++) {
        for (let j = 0; j < lines.length; j++) {
          if (i === j) continue;
          const a = lines[i];
          const b = lines[j];
          let joined = null;
          if (close(a[a.length - 1], b[0])) joined = a.concat(b.slice(1));
          else if (close(a[a.length - 1], b[b.length - 1])) joined = a.concat(b.slice().reverse().slice(1));
          else if (close(a[0], b[b.length - 1])) joined = b.concat(a.slice(1));
          if (joined) {
            lines[i] = joined;
            lines.splice(j, 1);
            merged = true;
            break outer;
          }
        }
      }
    }
    return lines;
  }

  const MTB_LABEL = { 0: 'Easy', 1: 'Intermediate', 2: 'Difficult', 3: 'Very difficult', 4: 'Extreme', 5: 'Extreme', 6: 'Extreme' };
  const SAC_LABEL = {
    hiking: 'Easy hiking',
    mountain_hiking: 'Mountain hiking',
    demanding_mountain_hiking: 'Demanding',
    alpine_hiking: 'Alpine',
    demanding_alpine_hiking: 'Demanding alpine',
  };

  // Densify polylines, drape them on the DEM, and total up distance and climbing.
  function measure(lines) {
    let length = 0;
    let gain = 0;
    let loss = 0;
    let lo = Infinity;
    let hi = -Infinity;
    const outLines = [];
    for (const line of lines) {
      const dense = densify(simplify(line, 2), 10);
      length += lineLength(dense);
      const eles = dense.map(([x, y]) => demAt(x, y));
      // Hysteresis-filtered climbing so DEM noise doesn't inflate gain
      let ref = eles[0];
      for (const e of eles) {
        lo = Math.min(lo, e);
        hi = Math.max(hi, e);
        if (e - ref > 3) {
          gain += e - ref;
          ref = e;
        } else if (ref - e > 3) {
          loss += ref - e;
          ref = e;
        }
      }
      outLines.push(dense.flatMap(([x, y], i) => [Math.round(x), Math.round(y), Math.round(eles[i])]));
    }
    return { outLines, length, gain, loss, lo, hi };
  }

  const trails = [];
  for (const segs of byName.values()) {
    for (const group of components(segs, 150)) {
      const { outLines, length, gain, loss, lo, hi } = measure(chain(group));
      if (length < 60) continue;
      const counts = new Map();
      for (const s of group) {
        const n = s.name.replace(/\s*\(.*?\)\s*/g, ' ').trim();
        counts.set(n, (counts.get(n) || 0) + lineLength(s.pts));
      }
      const name = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
      const total = group.reduce((a, s) => a + lineLength(s.pts), 0);
      const bikeShare = group.filter((s) => s.bike).reduce((a, s) => a + lineLength(s.pts), 0) / total;
      const mtb = group.map((s) => s.mtbScale).filter((v) => v != null).map((v) => parseInt(v, 10)).filter((v) => !isNaN(v));
      const sac = group.map((s) => s.sacScale).filter(Boolean);
      const surfaces = [...new Set(group.map((s) => s.surface).filter(Boolean))];
      const operators = [...new Set(group.map((s) => s.operator).filter(Boolean))];
      trails.push({
        park: group[0].park,
        name,
        hike: group.some((s) => s.hike),
        bike: bikeShare > 0.5,
        bikePartial: bikeShare > 0.05 && bikeShare <= 0.5,
        bikeInferred: group.every((s) => s.bikeInferred || !s.bike),
        fireRoad: group.every((s) => s.fireRoad),
        difficulty: mtb.length ? MTB_LABEL[Math.max(...mtb)] : null,
        mtbScale: mtb.length ? Math.max(...mtb) : null,
        hikeDifficulty: sac.length ? SAC_LABEL[sac.sort()[0]] ?? null : null,
        surface: surfaces.slice(0, 2).join(', ') || null,
        operator: operators.slice(0, 2).join(' · ') || null,
        official: false,
        sources: ['osm'],
        wilderness: false,
        lengthMi: Math.round((length / 1609.34) * 10) / 10,
        gainFt: Math.round(gain * 3.28084),
        lossFt: Math.round(loss * 3.28084),
        minFt: Math.round(lo * 3.28084),
        maxFt: Math.round(hi * 3.28084),
        lines: outLines,
      });
    }
  }
  trails.sort((a, b) => a.name.localeCompare(b.name) || b.lengthMi - a.lengthMi);
  // Disambiguate duplicate names with a location hint
  const nameCount = new Map();
  for (const t of trails) nameCount.set(`${t.park}|${t.name}`, (nameCount.get(`${t.park}|${t.name}`) || 0) + 1);
  const towns = labels.filter((l) => l.kind === 'town' || l.kind === 'village' || l.kind === 'peak' || l.kind === 'lake');
  const seenNames = new Map();
  trails.forEach((t, i) => {
    t.id = i;
    const key = `${t.park}|${t.name}`;
    if (nameCount.get(key) > 1) {
      const n = (seenNames.get(key) ?? 0) + 1;
      seenNames.set(key, n);
      const [x, y] = t.lines[0];
      const near = towns.length
        ? towns.reduce((a, b) => (Math.hypot(a.x - x, a.y - y) < Math.hypot(b.x - x, b.y - y) ? a : b))
        : null;
      t.area = near ? `near ${near.name}` : `section ${n}`;
    }
  });
  const miles = trails.reduce((a, t) => a + t.lengthMi, 0);
  console.log(`  ${trails.length} trails, ${miles.toFixed(1)} miles total`);
  for (const p of PARKS) {
    const ts = trails.filter((t) => t.park === p.id);
    console.log(`    ${p.long}: ${ts.length} trails, ${ts.reduce((a, t) => a + t.lengthMi, 0).toFixed(1)} mi`);
  }

  // --- 5. Write
  const map = {
    bbox: BBOX,
    widthM: Math.round(WIDTH_M),
    heightM: Math.round(HEIGHT_M),
    grid: { width: gridW, height: gridH, spacing: GRID_SPACING, scale: 4 },
    elevation: { min: Math.round(minEle), max: Math.round(maxEle) },
    datum: Math.round(minEle),
    exaggeration: EXAGGERATION,
    parks: PARKS.map((p) => ({ id: p.id, name: p.name, long: p.long, rings: p.polys.map((q) => round(simplify(q.outer, 6))) })),
    lakes,
    wilderness: [],
    roads: [],
    labels,
    attribution: ['Trails © OpenStreetMap contributors (ODbL)', 'Elevation: AWS Terrain Tiles (USGS 3DEP)'],
  };
  fs.writeFileSync(path.join(out, 'map.json'), JSON.stringify(map));
  fs.writeFileSync(path.join(out, 'trails.json'), JSON.stringify(trails));
  for (const f of ['future.json']) if (fs.existsSync(path.join(out, f))) fs.rmSync(path.join(out, f));
  for (const f of ['terrain.bin', 'map.json', 'trails.json']) {
    console.log(`  ${f}: ${(fs.statSync(path.join(out, f)).size / 1024).toFixed(0)} KB`);
  }
}
