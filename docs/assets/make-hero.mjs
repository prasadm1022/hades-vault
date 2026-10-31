// Generates docs/assets/hades-hero.svg: a digital human head, a glowing network of dots and lines,
// turning about its vertical axis.   Run: node docs/assets/make-hero.mjs   (zero dependencies)
//
// 1. The head is a signed distance field: a smooth, mannequin-like head built from ellipsoids and
//    capsules (cranium, forehead, cheekbones, jaw line, chin, brow, eye sockets and lids, nose, lips,
//    ears, neck).
// 2. Points are projected onto its surface and thinned to an even (Poisson-disk) spacing; every pair
//    of neighbours closer than EDGE x spacing becomes an edge, which gives the triangulated network.
// 3. Animation is CSS only, so GitHub renders it. A point (X, Z) turning by angle w*t has screen x
//    Re(c * e^(iwt)) with c = X - iZ: a cosine. An ease-in-out-sine sweep between +|c| and -|c|
//    (alternate, half a period) is exactly that cosine, so every element shares one keyframe and
//    carries only its amplitude and a phase (a negative delay). A dot is translated; an edge is a
//    1px line translated by its midpoint's cosine and scaled in x by its vector's cosine (the line
//    is drawn with a non-scaling stroke), which reproduces both endpoints exactly. Depth (Re(i*c*...))
//    drives opacity, so the far side of the head fades.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'hades-hero.svg');
const W = 1280, H = 640;
const PERIOD = 16; // seconds per turn
const SPACING = 0.088; // distance between surface points on the skull and neck (model units; the head is ~2.3 tall)
const FACE_SPACING = 0.052; // finer on the face, where the features are
const EDGE = 1.62; // neighbours closer than EDGE * SPACING are joined
const NECK_END = -1.62; // the neck is cut here and fades out above it
const SCALE = 212, CX = 335, TOP = 1.27; // model y = TOP maps to screen y = 30

let seed = 0x48414445;
const rand = () => { // mulberry32, deterministic
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// ---- 1. Head SDF (y up, z towards the viewer at rest) ----
const len = (x, y, z) => Math.hypot(x, y, z);
const ell = (p, c, r) => {
  const x = (p[0] - c[0]) / r[0], y = (p[1] - c[1]) / r[1], z = (p[2] - c[2]) / r[2];
  const k0 = len(x, y, z), k1 = len(x / r[0], y / r[1], z / r[2]);
  return k1 === 0 ? -Math.min(...r) : (k0 * (k0 - 1)) / k1;
};
const cap = (p, a, b, ra, rb) => {
  const pa = [p[0] - a[0], p[1] - a[1], p[2] - a[2]], ba = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const h = Math.max(0, Math.min(1, (pa[0] * ba[0] + pa[1] * ba[1] + pa[2] * ba[2]) / (ba[0] ** 2 + ba[1] ** 2 + ba[2] ** 2)));
  return len(pa[0] - ba[0] * h, pa[1] - ba[1] * h, pa[2] - ba[2] * h) - (ra + (rb - ra) * h);
};
const smin = (a, b, k) => { const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.min(a, b) - h * h * k * 0.25; };
const smax = (a, b, k) => -smin(-a, -b, k);

function sdf(p) {
  const m = [Math.abs(p[0]), p[1], p[2]]; // mirrored for paired features
  let d = ell(p, [0, 0.36, -0.06], [0.66, 0.78, 0.8]); // cranium
  d = smin(d, ell(p, [0, 0.16, -0.36], [0.56, 0.56, 0.44]), 0.25); // occipital bulge
  d = smin(d, ell(p, [0, 0.33, 0.3], [0.58, 0.55, 0.52]), 0.22); // forehead
  d = smin(d, ell(p, [0, -0.24, 0.24], [0.52, 0.62, 0.58]), 0.3); // mid face
  d = smin(d, ell(m, [0.37, -0.1, 0.5], [0.17, 0.12, 0.18]), 0.14); // cheekbones
  d = smin(d, cap(m, [0.41, -0.38, 0.02], [0.15, -0.86, 0.44], 0.11, 0.09), 0.2); // jaw line
  d = smin(d, ell(p, [0, -0.88, 0.5], [0.19, 0.14, 0.15]), 0.16); // chin
  d = smin(d, ell(p, [0, 0.165, 0.72], [0.47, 0.075, 0.13]), 0.1); // brow ridge
  d = smax(d, -ell(m, [0.235, 0.03, 0.83], [0.14, 0.085, 0.13]), 0.06); // eye sockets
  d = smin(d, ell(m, [0.235, 0.025, 0.665], [0.112, 0.072, 0.1]), 0.03); // eyeballs
  d = smin(d, ell(m, [0.235, 0.068, 0.7], [0.125, 0.035, 0.085]), 0.025); // upper lids
  d = smin(d, cap(p, [0, 0.12, 0.79], [0, -0.25, 1.02], 0.05, 0.085), 0.07); // nose bridge
  d = smin(d, ell(p, [0, -0.275, 0.995], [0.085, 0.075, 0.075]), 0.05); // nose tip
  d = smin(d, ell(m, [0.075, -0.305, 0.91], [0.065, 0.055, 0.065]), 0.05); // nostril wings
  d = smin(d, ell(p, [0, -0.47, 0.855], [0.18, 0.045, 0.075]), 0.05); // upper lip
  d = smin(d, ell(p, [0, -0.57, 0.83], [0.16, 0.05, 0.075]), 0.05); // lower lip
  d = smax(d, -ell(p, [0, -0.517, 0.92], [0.17, 0.008, 0.06]), 0.01); // mouth line
  d = smin(d, ell(m, [0.665, -0.02, -0.04], [0.065, 0.21, 0.13]), 0.05); // ears
  d = smax(d, -ell(m, [0.715, -0.02, -0.02], [0.03, 0.13, 0.075]), 0.03); // ear hollows
  d = smin(d, cap(p, [0, -0.6, -0.1], [0, -2.0, 0.02], 0.31, 0.37), 0.24); // neck
  return d;
}
const grad = (p) => {
  const e = 1e-4;
  const g = [0, 1, 2].map((i) => { const a = [...p], b = [...p]; a[i] += e; b[i] -= e; return (sdf(a) - sdf(b)) / (2 * e); });
  const l = len(...g) || 1;
  return g.map((v) => v / l);
};

// ---- 2. Surface points (even spacing) and network edges ----
const raw = [];
for (let i = 0; i < 200000; i++) {
  let p = [rand() * 2 - 1, rand() * 3.2 - 1.9, rand() * 2.4 - 1.1];
  for (let k = 0; k < 10; k++) { const d = sdf(p), g = grad(p); p = p.map((v, j) => v - d * g[j]); }
  if (Math.abs(sdf(p)) < 2e-3 && p[1] > NECK_END) raw.push(p);
}
const grid = new Map(), pts = [];
const cellOf = (p, s) => p.map((v) => Math.floor(v / s));
const key = (c) => c.join(',');
const near = (p, s, fn) => {
  const c = cellOf(p, s);
  for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let e = -1; e <= 1; e++) {
    for (const q of grid.get(key([c[0] + a, c[1] + b, c[2] + e])) || []) fn(q);
  }
};
const onFace = (p) => p[2] > 0.25 && p[1] > -1.0 && p[1] < 0.45;
const spacing = (p) => (onFace(p) ? FACE_SPACING : SPACING);
// Mean curvature from the SDF Laplacian: high on the eyes, nose, lips, ears and jaw.
const lap = (p) => {
  const e = 0.02; let sum = -6 * sdf(p);
  for (let i = 0; i < 3; i++) { const a = [...p], b = [...p]; a[i] += e; b[i] -= e; sum += sdf(a) + sdf(b); }
  return sum / (e * e);
};
for (const p of raw) {
  let ok = true;
  p.s = spacing(p);
  near(p, SPACING, (q) => { if (ok && len(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < Math.min(p.s, q.s)) ok = false; });
  if (!ok) continue;
  p.id = pts.length; p.k = Math.abs(lap(p)); pts.push(p);
  const k = key(cellOf(p, SPACING));
  if (!grid.has(k)) grid.set(k, []);
  grid.get(k).push(p);
}
// Edges: neighbours within EDGE * SPACING (the grid cell is SPACING, so search a wider block).
const edges = [];
const span = Math.ceil(EDGE);
for (const p of pts) {
  const c = cellOf(p, SPACING);
  for (let a = -span; a <= span; a++) for (let b = -span; b <= span; b++) for (let e = -span; e <= span; e++) {
    for (const q of grid.get(key([c[0] + a, c[1] + b, c[2] + e])) || []) {
      if (q.id > p.id && len(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < EDGE * Math.max(p.s, q.s)) edges.push([p, q]);
    }
  }
}

// ---- 3. Animation parameters ----
const AXIS_Z = 0.06; // turn about the head's centre
const sy = (y) => 30 + (TOP - y) * SCALE;
const tau = 2 * Math.PI;
const cplx = (p) => [p[0] * SCALE, -(p[2] - AXIS_Z) * SCALE]; // c = X - iZ, in px
const abs = (c) => Math.hypot(c[0], c[1]);
const delay = (c, shift = 0) => -((((Math.atan2(c[1], c[0]) + shift) % tau) + tau) % tau) / tau * PERIOD;
const rMax = Math.max(...pts.map((p) => abs(cplx(p))));
const BUCKETS = 6;
const bucket = (r) => Math.min(BUCKETS - 1, Math.floor((r / rMax) * BUCKETS));
const f1 = (n) => +n.toFixed(1), f2 = (n) => n.toFixed(2);
const neckFade = (y) => (y < -1.05 ? Math.max(0, (y - NECK_END) / (-1.05 - NECK_END)) : 1);

const kSorted = pts.map((p) => p.k).sort((a, b) => a - b);
const kHi = kSorted[Math.floor(kSorted.length * 0.8)];
const lines = edges.map(([a, b]) => {
  const ca = cplx(a), cb = cplx(b);
  const mid = [(ca[0] + cb[0]) / 2, (ca[1] + cb[1]) / 2], vec = [cb[0] - ca[0], cb[1] - ca[1]];
  const fade = Math.min(neckFade(a[1]), neckFade(b[1]));
  const hot = Math.min(a.k, b.k) > kHi;
  const o = fade < 1 ? ` stroke-opacity="${f2(0.5 * fade)}"` : '';
  return `<g class="o${bucket(abs(mid))}" style="--r:${f1(abs(mid))};--d:${f2(delay(mid))}s;--e:${f2(delay(mid, Math.PI / 2))}s">`
    + `<line${hot ? ' class="f"' : ''} x1="${CX - 0.5}" y1="${f1(sy(a[1]))}" x2="${CX + 0.5}" y2="${f1(sy(b[1]))}" style="--a:${f1(abs(vec))};--d:${f2(delay(vec))}s"${o}/></g>`;
});
const dots = pts.map((p) => {
  const c = cplx(p);
  const big = p.k > kHi || rand() < 0.05; // feature nodes and a few random ones glow
  const fade = neckFade(p[1]);
  return `<circle class="o${bucket(abs(c))}${big ? ' n' : ''}" cx="${CX}" cy="${f1(sy(p[1]))}" r="${big ? 1.9 : 1.2}"`
    + `${fade < 1 ? ` fill-opacity="${f2(fade)}"` : ''} style="--r:${f1(abs(c))};--d:${f2(delay(c))}s;--e:${f2(delay(c, Math.PI / 2))}s"/>`;
});

// ---- 4. SVG ----
const half = PERIOD / 2, EASE = 'cubic-bezier(.37,0,.63,1)';
const depthKeys = Array.from({ length: BUCKETS }, (_, i) => {
  const a = (i + 0.5) / BUCKETS; // how far this bucket swings in depth
  return `@keyframes z${i}{from{opacity:${f2(0.62 + 0.38 * a)}}to{opacity:${f2(0.62 - 0.55 * a)}}}.o${i}{animation-name:sw,z${i}}`;
}).join('');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="t d">
<title id="t">HADES - the autonomous AI software company</title>
<desc id="d">A digital human head made of glowing connected dots, a network wireframe, slowly turning, next to the HADES name and tagline.</desc>
<defs>
<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#010614"/><stop offset="1" stop-color="#06173a"/></linearGradient>
<radialGradient id="glow" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#0ea5e9" stop-opacity="0.26"/><stop offset="1" stop-color="#0ea5e9" stop-opacity="0"/></radialGradient>
<linearGradient id="title" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#67e8f9"/><stop offset="0.55" stop-color="#38bdf8"/><stop offset="1" stop-color="#818cf8"/></linearGradient>
<pattern id="grid" width="32" height="32" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill="#7dd3fc" fill-opacity="0.06"/></pattern>
</defs>
<style>
.h g,.h circle{transform-box:view-box;animation-delay:var(--d),var(--e);animation-duration:${half}s;animation-timing-function:${EASE};animation-iteration-count:infinite;animation-direction:alternate}
.h line{transform-box:view-box;transform-origin:${CX}px 0;vector-effect:non-scaling-stroke;stroke:#38bdf8;stroke-opacity:.5;stroke-width:.7;animation:sc ${half}s ${EASE} var(--d) infinite alternate}
.h circle{fill:#a5f3fc}.h .n{fill:#ecfeff}.h .f{stroke:#a5f3fc;stroke-opacity:.75}
@keyframes sw{from{transform:translateX(calc(var(--r) * 1px))}to{transform:translateX(calc(var(--r) * -1px))}}
@keyframes sc{from{transform:scaleX(var(--a))}to{transform:scaleX(calc(var(--a) * -1))}}
${depthKeys}
@media (prefers-reduced-motion:reduce){.h g,.h circle,.h line{animation-play-state:paused}}
text{font-family:'Segoe UI',Inter,Helvetica,Arial,sans-serif}
</style>
<rect width="${W}" height="${H}" rx="24" fill="url(#bg)"/>
<rect width="${W}" height="${H}" rx="24" fill="url(#grid)"/>
<ellipse cx="${CX}" cy="${H / 2 - 20}" rx="310" ry="310" fill="url(#glow)"/>
<g class="h">${lines.join('')}${dots.join('')}</g>
<text x="660" y="262" font-size="120" font-weight="800" letter-spacing="10" fill="url(#title)">HADES</text>
<text x="666" y="320" font-size="31" font-weight="600" fill="#e2e8f0">The autonomous AI software company</text>
<text x="666" y="372" font-size="22" fill="#94a3b8">Requirements in. Tested, security-scanned commits out.</text>
<text x="666" y="404" font-size="22" fill="#94a3b8">11 AI role agents, one pipeline, zero pushes without you.</text>
<text x="666" y="474" font-size="16" letter-spacing="1.5" fill="#64748b">CLAUDE CODE · CODEX · CURSOR · GEMINI CLI · COPILOT · MIT</text>
</svg>
`;
fs.writeFileSync(OUT, svg);
console.log(`${pts.length} points, ${edges.length} edges, ${(svg.length / 1024).toFixed(0)} KB -> ${OUT}`);
