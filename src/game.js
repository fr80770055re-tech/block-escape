(function () {
'use strict';
// relies on level.js globals: DIRS, opp, axisOf, cellKey, step, aheadCells, generateLevel

const BODY_COLORS = ['#ffd6bf', '#cfe4ff', '#d3efcd', '#e4d8ff', '#ffefb3', '#ffd1df', '#c6efe7', '#ffe0c2'];
const ARROW_COLOR = 0x2f2c3a, HINT_COLOR = 0xffa21e, ERR_COLOR = 0xe5484d;
const RIBBON_W = 0.3, LIFT = 0.018, TAIL_BACK = 0.3, HEAD_LEN = 0.36, HEAD_W = 0.66;
const SKEY = 'blockEscape.v2';

// ---------- persistence ----------
let save = { current: 1, unlocked: 1, best: {}, muted: false };
try { const raw = localStorage.getItem(SKEY); if (raw) save = Object.assign(save, JSON.parse(raw)); } catch (e) {}
function persist() { try { localStorage.setItem(SKEY, JSON.stringify(save)); } catch (e) {} }

// ---------- audio ----------
let actx = null;
function ac() {
  if (save.muted) return null;
  try {
    if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
  } catch (e) { return null; }
  return actx;
}
function tone(freq, dur, type, vol, slideTo, delay) {
  const a = ac(); if (!a) return;
  const t = a.currentTime + (delay || 0);
  const o = a.createOscillator(), g = a.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, t);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(a.destination); o.start(t); o.stop(t + dur + 0.02);
}
const sfx = {
  slide() { tone(380 + Math.random() * 140, 0.22, 'triangle', 0.15, 1400); },
  bump() { tone(160, 0.14, 'square', 0.06, 80); tone(95, 0.12, 'sine', 0.2, 60); },
  hint() { tone(880, 0.12, 'sine', 0.1); tone(1320, 0.18, 'sine', 0.08, null, 0.08); },
  win(stars) { [523, 659, 784, 1046, 1318].slice(0, 2 + stars).forEach((f, i) => tone(f, 0.3, 'triangle', 0.14, null, i * 0.11)); },
};
function vibrate(ms) { try { navigator.vibrate && navigator.vibrate(ms); } catch (e) {} }

// ---------- three.js setup ----------
const stage = document.getElementById('stage');
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2.5));
stage.appendChild(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 500);
scene.add(camera);
scene.add(new THREE.HemisphereLight(0xffffff, 0xb8a89a, 0.78));
const sun = new THREE.DirectionalLight(0xffffff, 0.42);
sun.position.set(-2, 4, 3);
camera.add(sun);
const pivot = new THREE.Group();
scene.add(pivot);
let content = new THREE.Group();
pivot.add(content);

const headGeo = (function () {
  const g = new THREE.BufferGeometry();
  // flat-based, sharp triangle head that overlaps the ribbon's square end
  g.setAttribute('position', new THREE.Float32BufferAttribute([HEAD_LEN, 0, 0, 0, HEAD_W / 2, 0, 0, -HEAD_W / 2, 0], 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
  return g;
})();
// square tail end: the ribbon itself ends flat, so the cap is an empty placeholder
const capGeo = new THREE.BufferGeometry();

// ---------- path geometry helpers ----------
const V = (a) => new THREE.Vector3(a[0], a[1], a[2]);
function cellCenter(c) { const n = DIRS[c.f]; return new THREE.Vector3(c.p[0] + 0.5 + n[0] * 0.5, c.p[1] + 0.5 + n[1] * 0.5, c.p[2] + 0.5 + n[2] * 0.5); }

// Build the arrow's full travel polyline: body (tail -> head) + straight run ahead + exit into space.
function buildPath(a, dims) {
  const pts = [];
  const cells = a.cells;
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i], ctr = cellCenter(c);
    pts.push({ p: ctr, n: V(DIRS[c.f]) });
    if (i < cells.length - 1 && cells[i + 1].f !== c.f) {
      pts.push({ p: ctr.clone().addScaledVector(V(DIRS[a.fwd[i]]), 0.5), n: V(DIRS[c.f]).add(V(DIRS[cells[i + 1].f])).normalize() });
    }
  }
  const headIdx = pts.length - 1;
  const head = cells[cells.length - 1], hn = V(DIRS[head.f]), dv = V(DIRS[a.d]);
  const ahead = aheadCells(head, a.d, dims);
  for (const c of ahead) pts.push({ p: cellCenter(c), n: hn.clone() });
  const last = pts[pts.length - 1].p;
  const edge = last.clone().addScaledVector(dv, 0.5);
  pts.push({ p: edge, n: hn.clone() });
  const far = Math.max(...dims) * 3 + 12;
  pts.push({ p: edge.clone().addScaledVector(dv, far), n: hn.clone() });
  const arcs = [0];
  for (let i = 1; i < pts.length; i++) arcs.push(arcs[i - 1] + pts[i].p.distanceTo(pts[i - 1].p));
  return { pts, arcs, L: arcs[headIdx], edgeArc: arcs[pts.length - 2], ahead };
}
function at(path, t) {
  const { pts, arcs } = path;
  let i = 0;
  if (t >= arcs[arcs.length - 1]) i = arcs.length - 2;
  else if (t > 0) { while (i < arcs.length - 2 && arcs[i + 1] <= t) i++; }
  const a = pts[i], b = pts[i + 1], len = arcs[i + 1] - arcs[i] || 1e-6;
  const u = (t - arcs[i]) / len;
  const T = b.p.clone().sub(a.p).normalize();
  return { p: a.p.clone().lerp(b.p, u), n: a.n.clone().lerp(b.n, Math.min(1, Math.max(0, u))).normalize(), T };
}
function sampleRange(path, a, b) {
  const out = [at(path, a)];
  for (let i = 0; i < path.arcs.length; i++) {
    const t = path.arcs[i];
    if (t > a + 1e-4 && t < b - 1e-4) out.push({ p: path.pts[i].p.clone(), n: path.pts[i].n.clone() });
  }
  out.push(at(path, b));
  return out;
}
function ribbonGeometry(samples) {
  const pos = [], nor = [], idx = [];
  const tmp = new THREE.Vector3(), side = new THREE.Vector3();
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const tin = i > 0 ? s.p.clone().sub(samples[i - 1].p).normalize() : null;
    const tout = i < samples.length - 1 ? samples[i + 1].p.clone().sub(s.p).normalize() : null;
    const T = (tin && tout) ? tin.clone().add(tout) : (tin || tout).clone();
    if (T.lengthSq() < 1e-8) T.copy(tin || tout);
    T.normalize();
    // widen (miter) only for turns within the face; folding over a cube edge keeps the width
    const inPlane = tin && tout && Math.abs(side.crossVectors(tin, tout).dot(s.n)) > 0.5;
    const m = inPlane ? 1 / Math.max(0.6, T.dot(tin)) : 1;
    side.crossVectors(s.n, T).normalize().multiplyScalar(RIBBON_W / 2 * m);
    tmp.copy(s.p).addScaledVector(s.n, LIFT);
    pos.push(tmp.x + side.x, tmp.y + side.y, tmp.z + side.z, tmp.x - side.x, tmp.y - side.y, tmp.z - side.z);
    nor.push(s.n.x, s.n.y, s.n.z, s.n.x, s.n.y, s.n.z);
    if (i > 0) { const k = i * 2; idx.push(k - 2, k - 1, k, k - 1, k + 1, k); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setIndex(idx);
  return g;
}
const mBasis = new THREE.Matrix4(), Zv = new THREE.Vector3(0, 0, 1);
function drawArrow(a) {
  const s = a.s, path = a.path;
  const g = ribbonGeometry(sampleRange(path, s - TAIL_BACK, s + path.L));
  a.body.geometry.dispose(); a.body.geometry = g;
  const h = at(path, s + path.L + 1e-3);
  const X = h.T, Z = h.n.clone().addScaledVector(X, -h.n.dot(X)).normalize(), Y = new THREE.Vector3().crossVectors(Z, X);
  mBasis.makeBasis(X, Y, Z);
  a.head.quaternion.setFromRotationMatrix(mBasis);
  a.head.position.copy(at(path, s + path.L).p).addScaledVector(Z, LIFT * 1.3);
  const t = at(path, s - TAIL_BACK);
  a.tail.position.copy(t.p).addScaledVector(t.n, LIFT);
  a.tail.quaternion.setFromUnitVectors(Zv, t.n);
}

// ---------- game state ----------
let level = null, arrows = [], occ = new Map(), stats = null, cube = null;
let viewRadius = 3, zoom = 1;
const tweens = new Set();
function addTween(dur, fn, done) { const t = { t0: performance.now(), dur, fn, done }; tweens.add(t); return t; }

function loadLevel(n) {
  tweens.clear();
  pivot.remove(content);
  content.traverse(o => { if (o.isMesh) { if (o.geometry !== headGeo && o.geometry !== capGeo) o.geometry.dispose(); o.material.dispose(); } });
  content = new THREE.Group(); pivot.add(content);

  level = generateLevel(n);
  save.current = n; persist();
  const [A, B, C] = level.dims;
  content.position.set(-A / 2, -B / 2, -C / 2);
  cube = new THREE.Mesh(new THREE.BoxGeometry(A, B, C),
    new THREE.MeshLambertMaterial({ color: BODY_COLORS[(n - 1) % BODY_COLORS.length], polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }));
  cube.position.set(A / 2, B / 2, C / 2);
  content.add(cube);

  occ = new Map(); arrows = [];
  level.arrows.forEach((src, id) => {
    const mat = new THREE.MeshLambertMaterial({ color: ARROW_COLOR, side: THREE.DoubleSide, transparent: true });
    const a = { id, ...src, path: buildPath(src, level.dims), s: 0, alive: true, mat, bump: null, hint: null };
    a.body = new THREE.Mesh(new THREE.BufferGeometry(), mat);
    a.head = new THREE.Mesh(headGeo, mat); a.head.material = mat;
    a.tail = new THREE.Mesh(capGeo, mat);
    content.add(a.body, a.head, a.tail);
    drawArrow(a);
    for (const c of a.cells) occ.set(cellKey(c), a);
    arrows.push(a);
  });
  viewRadius = Math.hypot(A, B, C) / 2 + 0.2;
  pivot.quaternion.identity();
  rotatePivot(-0.66, 0.5);
  zoom = 1;
  fitCamera();

  stats = { started: false, t0: 0, elapsed: 0, mistakes: 0, hints: 0, removed: 0, done: false };
  $('lvl').textContent = '第 ' + n + ' 關 · ' + A + '×' + B + '×' + C;
  hideOverlays();
  showTip(n === 1 ? '點一下箭頭，它會沿著箭頭方向整條滑出。前方被別的箭頭擋住就出不去。拖曳可旋轉方塊。'
        : n === 2 ? '箭頭可以繞過方塊的稜角。每關的破關秒數會記錄下來。'
        : n === 4 ? '雙指或滾輪可以縮放。卡住時試試提示。' : '');
  updateHud();
}

function blockerOf(a) {
  const head = a.cells[a.cells.length - 1];
  for (const c of aheadCells(head, a.d, level.dims)) { const o = occ.get(cellKey(c)); if (o && o !== a) return o; }
  return null;
}
function startClock() { if (!stats.started && !stats.done) { stats.started = true; stats.t0 = performance.now(); } }

function tapArrow(a) {
  if (stats.done || !a.alive) return;
  startClock();
  const blocker = blockerOf(a);
  if (!blocker) {
    a.alive = false;
    for (const c of a.cells) occ.delete(cellKey(c));
    if (a.bump) { tweens.delete(a.bump); a.bump = null; }
    if (a.hint) { tweens.delete(a.hint); a.hint = null; }
    a.mat.color.setHex(ARROW_COLOR);
    const s0 = a.s, dist = a.path.edgeArc + TAIL_BACK + 1.5;
    // fast launch: starts at full speed and still accelerates a little
    const dur = 140 + dist * 14;
    addTween(dur, k => {
      a.s = s0 + (dist - s0) * (k * 0.7 + k * k * 0.3);
      a.mat.opacity = k < 0.7 ? 1 : 1 - (k - 0.7) / 0.3;
      drawArrow(a);
    }, () => { content.remove(a.body, a.head, a.tail); });
    sfx.slide(); vibrate(8);
    stats.removed++;
    if (level.n <= 2 && stats.removed >= 2) showTip('');
    if (stats.removed === arrows.length) finishLevel();
  } else {
    stats.mistakes++;
    if (a.bump) tweens.delete(a.bump);
    a.mat.color.setHex(ERR_COLOR);
    blocker.mat.color.setHex(ERR_COLOR);
    a.bump = addTween(300, k => { a.s = Math.sin(k * Math.PI) * 0.3; drawArrow(a); },
      () => { a.s = 0; drawArrow(a); a.bump = null;
        a.mat.color.setHex(a.hint ? HINT_COLOR : ARROW_COLOR);
        if (blocker.alive) blocker.mat.color.setHex(blocker.hint ? HINT_COLOR : ARROW_COLOR); });
    sfx.bump(); vibrate([20, 30, 20]);
  }
  updateHud();
}

function useHint() {
  if (stats.done) return;
  const free = arrows.filter(a => a.alive && !blockerOf(a));
  if (!free.length) return;
  startClock();
  // prefer an arrow whose head faces the viewer
  const q = pivot.quaternion;
  free.sort((x, y) => V(DIRS[y.cells[y.cells.length - 1].f]).applyQuaternion(q).z - V(DIRS[x.cells[x.cells.length - 1].f]).applyQuaternion(q).z);
  const a = free[0];
  stats.hints++;
  if (a.hint) tweens.delete(a.hint);
  const base = new THREE.Color(ARROW_COLOR), hl = new THREE.Color(HINT_COLOR);
  a.hint = addTween(3000, k => {
    if (!a.alive || a.bump) return;
    a.mat.color.copy(base).lerp(hl, 0.55 + 0.45 * Math.abs(Math.sin(k * Math.PI * 4)));
  }, () => { a.hint = null; if (a.alive) a.mat.color.setHex(ARROW_COLOR); });
  sfx.hint();
  updateHud();
}

function elapsedTime() {
  return stats.started ? (stats.done ? stats.elapsed : (performance.now() - stats.t0) / 1000) : 0;
}

function finishLevel() {
  stats.done = true;
  stats.elapsed = (performance.now() - stats.t0) / 1000;
  const total = elapsedTime();
  const n = level.n, prev = save.best[n];
  const isNewBest = !prev || total < prev.time;
  save.best[n] = { time: isNewBest ? +total.toFixed(1) : prev.time };
  save.unlocked = Math.max(save.unlocked, n + 1);
  persist();
  // little celebration spin of the bare cube
  const q0 = pivot.quaternion.clone();
  addTween(900, k => { pivot.quaternion.copy(q0); rotatePivot(k * k * 1.2, 0); cube.scale.setScalar(1 + Math.sin(k * Math.PI) * 0.06); });
  setTimeout(() => showWin(total, isNewBest && !!prev), 750);
}

// ---------- camera & controls ----------
function fitCamera() {
  const w = stage.clientWidth || window.innerWidth, h = stage.clientHeight || window.innerHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  const vf = THREE.MathUtils.degToRad(camera.fov) / 2, hf = Math.atan(Math.tan(vf) * camera.aspect);
  // leave room for the top HUD and bottom buttons
  const usable = Math.max(0.5, (h - 260) / h);
  const dist = viewRadius / Math.sin(Math.min(vf * usable, hf * 0.92));
  camera.position.set(0, 0, dist * zoom);
  camera.far = dist * 8 + 80;
  camera.updateProjectionMatrix();
}
const qTmp = new THREE.Quaternion(), X_AXIS = new THREE.Vector3(1, 0, 0), Y_AXIS = new THREE.Vector3(0, 1, 0);
function rotatePivot(ax, ay) {
  qTmp.setFromAxisAngle(Y_AXIS, ax); pivot.quaternion.premultiply(qTmp);
  qTmp.setFromAxisAngle(X_AXIS, ay); pivot.quaternion.premultiply(qTmp);
}

const pointers = new Map();
let drag = null, pinch0 = 0, zoom0 = 1, spin = { x: 0, y: 0 };
const raycaster = new THREE.Raycaster(), ndc = new THREE.Vector2();
const el = renderer.domElement;
el.addEventListener('pointerdown', e => {
  el.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  ac();
  spin.x = spin.y = 0;
  if (pointers.size === 1) drag = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, moved: false, t: performance.now() };
  else if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch0 = Math.hypot(a.x - b.x, a.y - b.y); zoom0 = zoom; if (drag) drag.moved = true; }
});
el.addEventListener('pointermove', e => {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 1 && drag) {
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.x = e.clientX; drag.y = e.clientY;
    if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 9) drag.moved = true;
    if (drag.moved) { const k = 0.0085; rotatePivot(dx * k, dy * k); spin.x = dx * k; spin.y = dy * k; }
  } else if (pointers.size === 2) {
    const [a, b] = [...pointers.values()], d = Math.hypot(a.x - b.x, a.y - b.y);
    if (pinch0 > 0) { zoom = THREE.MathUtils.clamp(zoom0 * pinch0 / d, 0.4, 1.8); fitCamera(); }
  }
});
function endPointer(e) {
  if (!pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId);
  if (pointers.size === 0) {
    if (drag && !drag.moved && e.type === 'pointerup') { spin.x = spin.y = 0; pick(e.clientX, e.clientY); }
    drag = null;
  } else spin.x = spin.y = 0;
}
el.addEventListener('pointerup', endPointer);
el.addEventListener('pointercancel', endPointer);
el.addEventListener('wheel', e => {
  e.preventDefault();
  zoom = THREE.MathUtils.clamp(zoom * Math.exp(e.deltaY * 0.0012), 0.4, 1.8);
  fitCamera();
}, { passive: false });

function pick(cx, cy) {
  const r = el.getBoundingClientRect();
  ndc.set((cx - r.left) / r.width * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const hit = raycaster.intersectObject(cube, false)[0];
  if (!hit) return;
  const q = content.worldToLocal(hit.point.clone());
  const nrm = hit.face.normal;
  const f = Math.abs(nrm.x) > 0.5 ? (nrm.x > 0 ? 0 : 1) : Math.abs(nrm.y) > 0.5 ? (nrm.y > 0 ? 2 : 3) : (nrm.z > 0 ? 4 : 5);
  const dims = level.dims, p = [0, 0, 0], ax = axisOf(f);
  for (let i = 0; i < 3; i++) {
    if (i === ax) p[i] = (f & 1) ? 0 : dims[i] - 1;
    else p[i] = Math.min(dims[i] - 1, Math.max(0, Math.floor(q.getComponent(i))));
  }
  let a = occ.get(cellKey({ p, f }));
  if (!a) {
    // forgiving touch: try the nearest neighbouring cell on the same face
    let best = null, bd = 0.85;
    for (const t of [0, 1, 2, 3, 4, 5]) {
      if (axisOf(t) === ax) continue;
      const pp = p.slice(); pp[axisOf(t)] += DIRS[t][axisOf(t)];
      if (pp[axisOf(t)] < 0 || pp[axisOf(t)] >= dims[axisOf(t)]) continue;
      const o = occ.get(cellKey({ p: pp, f }));
      if (!o) continue;
      const cc = cellCenter({ p: pp, f }), d = cc.distanceTo(q);
      if (d < bd) { bd = d; best = o; }
    }
    a = best;
  }
  if (a) tapArrow(a);
}

window.addEventListener('resize', fitCamera);
window.addEventListener('keydown', e => {
  const s = 0.14;
  if (e.key === 'ArrowLeft') rotatePivot(-s, 0);
  else if (e.key === 'ArrowRight') rotatePivot(s, 0);
  else if (e.key === 'ArrowUp') rotatePivot(0, -s);
  else if (e.key === 'ArrowDown') rotatePivot(0, s);
  else if (e.key === 'h' || e.key === 'H') useHint();
  else if (e.key === 'r' || e.key === 'R') loadLevel(level.n);
});

// ---------- HUD & sheets ----------
function $(id) { return document.getElementById(id); }
function updateHud() {
  if (!stats) return;
  $('timer').textContent = elapsedTime().toFixed(1);
  const left = arrows.length - stats.removed, best = save.best[level.n];
  $('meta').textContent = '剩 ' + left + ' 支箭頭' + (best ? '　最佳 ' + best.time.toFixed(1) + ' 秒' : '');
}
let tipTimer = 0;
function showTip(text) {
  const t = $('tip'); clearTimeout(tipTimer);
  if (!text) { t.style.opacity = 0; tipTimer = setTimeout(() => t.textContent = '', 400); return; }
  t.textContent = text;
  requestAnimationFrame(() => t.style.opacity = 1);
  tipTimer = setTimeout(() => showTip(''), 10000);
}
function hideOverlays() { $('winOverlay').classList.remove('show'); $('menuOverlay').classList.remove('show'); }

function showWin(total, beatPrev) {
  $('winTitle').textContent = beatPrev ? '新紀錄！' : '過關！';
  $('winTime').textContent = total.toFixed(1) + ' 秒';
  const best = save.best[level.n];
  const rows = [
    ['點錯', stats.mistakes + ' 次'],
    ['提示', stats.hints + ' 次'],
    ['最佳紀錄', (beatPrev ? '<span class="new">新紀錄！</span> ' : '') + best.time.toFixed(1) + ' 秒'],
  ];
  $('winRows').innerHTML = rows.map(r => '<span>' + r[0] + '</span><span>' + r[1] + '</span>').join('');
  $('winOverlay').classList.add('show');
  sfx.win(3); vibrate([30, 40, 30]);
}

function openMenu() {
  const maxShow = Math.max(25, Math.ceil((save.unlocked + 1) / 5) * 5);
  const g = $('levelGrid'); g.innerHTML = '';
  for (let n = 1; n <= maxShow; n++) {
    const b = document.createElement('button');
    const best = save.best[n], locked = n > save.unlocked;
    b.className = 'cell' + (locked ? ' locked' : '') + (level && n === level.n ? ' cur' : '');
    b.innerHTML = '<b>' + (locked ? '🔒' : n) + '</b><i>' + (locked || !best ? '&nbsp;' : best.time.toFixed(1) + '″') + '</i>';
    if (locked) b.disabled = true; else b.onclick = () => loadLevel(n);
    g.appendChild(b);
  }
  $('totalStars').textContent = '已破 ' + Object.keys(save.best).length + ' 關';
  $('winOverlay').classList.remove('show');
  $('menuOverlay').classList.add('show');
  const cur = g.querySelector('.cur'); cur && cur.scrollIntoView({ block: 'center' });
}

function syncMute() { $('btnMute').textContent = save.muted ? '🔇' : '🔊'; }
$('btnMute').onclick = () => { save.muted = !save.muted; persist(); syncMute(); };
$('btnMenu').onclick = openMenu;
$('btnCloseMenu').onclick = () => $('menuOverlay').classList.remove('show');
$('menuOverlay').addEventListener('click', e => { if (e.target.id === 'menuOverlay') $('menuOverlay').classList.remove('show'); });
$('btnHint').onclick = useHint;
$('btnRestart').onclick = () => loadLevel(level.n);
$('btnNext').onclick = () => loadLevel(level.n + 1);
$('btnReplay').onclick = () => loadLevel(level.n);
$('btnWinMenu').onclick = openMenu;
syncMute();

// ---------- loop ----------
function frame(now) {
  for (const t of [...tweens]) {
    const k = Math.min(1, (now - t.t0) / t.dur);
    t.fn(k);
    if (k >= 1) { tweens.delete(t); t.done && t.done(); }
  }
  if (!drag && (Math.abs(spin.x) > 1e-4 || Math.abs(spin.y) > 1e-4)) {
    rotatePivot(spin.x, spin.y); spin.x *= 0.92; spin.y *= 0.92;
  }
  if (stats && stats.started && !stats.done) updateHud();
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

loadLevel(Math.min(save.current || 1, save.unlocked || 1));
requestAnimationFrame(frame);

// test hook
window.__blockEscape = {
  tapFree() { const a = arrows.find(a => a.alive && !blockerOf(a)); if (a) tapArrow(a); return !!a; },
  tapBlocked() { const a = arrows.find(a => a.alive && blockerOf(a)); if (a) tapArrow(a); return !!a; },
  state: () => ({ stats, n: level.n, arrows: arrows.length }),
};
})();
