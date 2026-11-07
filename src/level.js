// ===== Level model & generator (pure, no DOM) =====
// A level is a box of A x B x C unit cells. Every outer face is a grid of surface cells.
// A surface cell is { p:[x,y,z], f } : the boundary voxel p and the outward face direction f.
// Directions are indices into DIRS; opposite(i) = i ^ 1, axis(i) = i >> 1.
const DIRS = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
const opp = i => i ^ 1;
const axisOf = i => i >> 1;
const cellKey = c => c.p[0] + ',' + c.p[1] + ',' + c.p[2] + ',' + c.f;

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function inBox(p, dims) {
  return p[0] >= 0 && p[1] >= 0 && p[2] >= 0 && p[0] < dims[0] && p[1] < dims[1] && p[2] < dims[2];
}
// Walk one cell across the surface in tangent direction t; wraps over cube edges.
function step(c, t, dims) {
  const v = DIRS[t], q = [c.p[0] + v[0], c.p[1] + v[1], c.p[2] + v[2]];
  if (inBox(q, dims)) return { c: { p: q, f: c.f }, t };
  return { c: { p: c.p, f: t }, t: opp(c.f) };
}
function tangents(f) { return [0, 1, 2, 3, 4, 5].filter(i => axisOf(i) !== axisOf(f)); }
function surfaceCells(dims) {
  const out = [];
  for (let f = 0; f < 6; f++) {
    const a = axisOf(f), b = (a + 1) % 3, c = (a + 2) % 3;
    for (let i = 0; i < dims[b]; i++) for (let j = 0; j < dims[c]; j++) {
      const p = [0, 0, 0]; p[a] = (f & 1) ? 0 : dims[a] - 1; p[b] = i; p[c] = j;
      out.push({ p, f });
    }
  }
  return out;
}
// Cells straight ahead of a head on the same face, up to the face edge.
function aheadCells(h, d, dims) {
  const res = []; let cur = h;
  for (;;) { const s = step(cur, d, dims); if (s.c.f !== cur.f) break; res.push(s.c); cur = s.c; }
  return res;
}

function levelDims(n) {
  // 3,3,3 / 4,3,3 / 4,4,3 / 4,4,4 / 5,4,4 ... capped at 8
  const list = [[3, 3, 3]];
  for (let s = 4; s <= 8; s++) list.push([s, s - 1, s - 1], [s, s, s - 1], [s, s, s]);
  if (n <= list.length) return list[n - 1];
  const tail = list.slice(-3);
  return tail[(n - list.length - 1) % 3];
}

// Reverse construction: arrows are placed one by one; each new arrow's path ahead must be
// free of arrows already placed. Removing them in reverse placement order always works.
function generateLevel(n) {
  const dims = levelDims(n);
  const rng = mulberry32((n * 2654435761) ^ 0x51ed270b);
  const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const cells = surfaceCells(dims);
  const occ = new Map();
  const arrows = [];
  const maxDim = Math.max(...dims);
  const maxLen = Math.min(3 + Math.ceil(maxDim / 2), 7);

  function tryPlace(h, minLen) {
    // order directions randomly, weighted toward long clear runs ahead (more chances to be blocked later)
    const ds = tangents(h.f).map(d => [d, aheadCells(h, d, dims)]);
    const order = [];
    while (ds.length) {
      const ws = ds.map(([, a]) => Math.pow(a.length + 1, 3));
      let r = rng() * ws.reduce((x, y) => x + y, 0), i = ds.length - 1;
      for (let j = 0; j < ds.length; j++) { r -= ws[j]; if (r <= 0) { i = j; break; } }
      order.push(ds.splice(i, 1)[0]);
    }
    for (const [d, ah] of order) {
      if (ah.some(c => occ.has(cellKey(c)))) continue;
      const ahSet = new Set(ah.map(cellKey));
      const target = minLen + Math.floor(rng() * (maxLen - minLen + 1));
      const own = new Set([cellKey(h)]);
      const body = [h], fwd = [];
      let cur = h, b = opp(d);
      while (body.length < target) {
        const opts = [[b, 2.2]];
        // the segment right behind the head stays straight so the head points along the body
        if (body.length > 1) for (const t of tangents(cur.f)) if (axisOf(t) !== axisOf(b)) opts.push([t, 1]);
        const cand = [];
        let tot = 0;
        for (const [o, w] of opts) {
          const s = step(cur, o, dims), k = cellKey(s.c);
          if (!occ.has(k) && !own.has(k) && !ahSet.has(k)) { cand.push([s, w]); tot += w; }
        }
        if (!cand.length) break;
        let r = rng() * tot, pick = cand[cand.length - 1][0];
        for (const [s, w] of cand) { r -= w; if (r <= 0) { pick = s; break; } }
        body.unshift(pick.c); fwd.unshift(opp(pick.t)); own.add(cellKey(pick.c));
        cur = pick.c; b = pick.t;
      }
      if (body.length < minLen) continue;
      const id = arrows.length;
      arrows.push({ cells: body, fwd, d });
      for (const c of body) occ.set(cellKey(c), id);
      return true;
    }
    return false;
  }

  for (const minLen of [3, 2, 1]) {
    let placed = true;
    while (placed) {
      placed = false;
      for (const c of shuffle(cells.slice())) if (!occ.has(cellKey(c)) && tryPlace(c, minLen)) placed = true;
    }
  }
  return { n, dims, arrows, coverage: occ.size / cells.length };
}

function starThresholds(count) {
  return { three: Math.round(count * 1.6 + 5), two: Math.round(count * 3.2 + 10) };
}
function starsFor(time, th) { return time <= th.three ? 3 : time <= th.two ? 2 : 1; }

if (typeof module !== 'undefined') module.exports = { DIRS, opp, axisOf, cellKey, step, aheadCells, generateLevel, levelDims, starThresholds, starsFor };
