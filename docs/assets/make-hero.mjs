// Generates docs/assets/hades-hero.svg: a 3D human head made of dots, turning about its vertical axis.
// Run: node docs/assets/make-hero.mjs   (zero dependencies, deterministic)
//
// The head is a signed distance field (smooth unions of ellipsoids and capsules). Points are
// projected onto its surface, thinned to an even spacing, and animated with CSS only (GitHub
// renders README images without JavaScript): for a rotation about the y axis the screen x of a
// point is R*cos(wt + phi), which is exactly an ease-in-out-sine sweep between +R and -R, so
// each dot gets one shared keyframe, its own radius (--r) and a phase given as a negative delay.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'hades-hero.svg');
const W = 1280, H = 640;
const PERIOD = 14; // seconds per full turn
const SPACING = 0.058; // minimum distance between dots (model units)

// Deterministic PRNG (mulberry32).
let seed = 0x48414445;
const rand = () => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// ---- Signed distance field of a head (y up, z toward the viewer, head height ~2.4) ----
const len = (x, y, z) => Math.hypot(x, y, z);
const ell = (p, c, r) => { // approximate ellipsoid distance
  const x = (p[0] - c[0]) / r[0], y = (p[1] - c[1]) / r[1], z = (p[2] - c[2]) / r[2];
  const k0 = len(x, y, z);
  const k1 = len(x / r[0], y / r[1], z / r[2]);
  return k1 === 0 ? -Math.min(...r) : (k0 * (k0 - 1)) / k1;
};
const cap = (p, a, b, ra, rb) => { // tapered capsule
  const pa = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const ba = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const h = Math.max(0, Math.min(1, (pa[0] * ba[0] + pa[1] * ba[1] + pa[2] * ba[2]) / (ba[0] ** 2 + ba[1] ** 2 + ba[2] ** 2)));
  return len(pa[0] - ba[0] * h, pa[1] - ba[1] * h, pa[2] - ba[2] * h) - (ra + (rb - ra) * h);
};
const smin = (a, b, k) => { const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.min(a, b) - h * h * k * 0.25; };
const smax = (a, b, k) => -smin(-a, -b, k);
const mirror = (p) => [Math.abs(p[0]), p[1], p[2]];

// Proportions follow the owner's portrait photos (front and profile): tall curly hair on top with
// short faded sides, an oval face with a lean jaw, slightly prominent ears, a moustache and a pointed
// goatee, and the stand-up collar of a half-zip top. Each part is kept separately so it can be coloured.
const curls = (p) => 0.04 * Math.sin(13 * p[0] + 1) * Math.sin(11 * p[1]) * Math.sin(12 * p[2] + 2)
  + 0.014 * Math.sin(29 * p[0]) * Math.sin(31 * p[2] + 1);
function parts(p) {
  const m = mirror(p);
  let head = ell(p, [0, 0.12, -0.1], [0.7, 0.63, 0.86]); // cranium (skull top just under the hair)
  head = smin(head, ell(p, [0, -0.3, 0.16], [0.52, 0.64, 0.66]), 0.3); // face mass, oval
  head = smin(head, ell(p, [0, -0.78, 0.36], [0.31, 0.24, 0.28]), 0.22); // lean jaw and chin
  head = smin(head, ell(m, [0.35, -0.12, 0.47], [0.18, 0.16, 0.2]), 0.14); // cheekbones
  head = smin(head, ell(p, [0, 0.2, 0.7], [0.5, 0.1, 0.15]), 0.12); // brow ridge
  head = smin(head, ell(m, [0.66, -0.03, -0.02], [0.085, 0.22, 0.13]), 0.05); // ears, slightly out
  head = smax(head, -ell(m, [0.25, 0.04, 0.85], [0.15, 0.1, 0.13]), 0.08); // eye sockets
  head = smin(head, ell(m, [0.25, 0.04, 0.67], [0.12, 0.08, 0.1]), 0.04); // eyes
  head = smin(head, cap(p, [0, 0.12, 0.8], [0, -0.28, 1.07], 0.065, 0.1), 0.07); // straight nose
  head = smin(head, ell(p, [0, -0.32, 0.98], [0.15, 0.075, 0.09]), 0.06); // nose tip and nostrils
  head = smin(head, ell(p, [0, -0.52, 0.82], [0.2, 0.05, 0.09]), 0.05); // upper lip
  head = smin(head, ell(p, [0, -0.62, 0.79], [0.18, 0.055, 0.09]), 0.05); // lower lip
  head = smin(head, cap(p, [0, -0.7, -0.12], [0, -1.6, -0.18], 0.36, 0.42), 0.26); // neck
  // Hair: a tall, slightly forward-swept curly volume on top; the sides stay short (the skull).
  let hair = ell(p, [0, 0.7, 0.02], [0.6, 0.42, 0.84]); // domed, narrower than the face at the sides
  hair = smin(hair, ell(p, [0, 0.9, 0.36], [0.44, 0.28, 0.46]), 0.2); // front quiff, high and forward
  hair -= curls(p);
  // Moustache (with ends turning down) and a pointed goatee with a small patch under the lip.
  let beard = ell(p, [0, -0.445, 0.9], [0.25, 0.045, 0.07]);
  beard = smin(beard, ell(m, [0.22, -0.53, 0.8], [0.05, 0.085, 0.06]), 0.04);
  beard = Math.min(beard, ell(p, [0, -0.69, 0.83], [0.05, 0.05, 0.04]));
  beard = Math.min(beard, smin(ell(p, [0, -0.86, 0.52], [0.18, 0.18, 0.17]), cap(p, [0, -0.82, 0.52], [0, -1.1, 0.44], 0.12, 0.035), 0.08));
  // Stand-up collar of a half-zip top: a short open tube around the neck.
  const rc = Math.hypot(p[0], p[2] + 0.16);
  const collar = Math.max(Math.abs(rc - 0.47) - 0.02, Math.abs(p[1] + 1.36) - 0.09);
  const feat = Math.min(
    ell(m, [0.25, 0.04, 0.67], [0.15, 0.11, 0.13]), // eyes
    ell(p, [0, 0.2, 0.72], [0.52, 0.06, 0.16]), // brows
    cap(p, [0, 0.12, 0.8], [0, -0.3, 1.07], 0.09, 0.14), // nose
    ell(p, [0, -0.57, 0.81], [0.21, 0.1, 0.1])); // lips
  return { head, hair, beard, collar, feat };
}
function sdf(p) {
  const q = parts(p);
  return Math.min(smin(q.head, q.hair, 0.12), q.beard, q.collar);
}
// Which part a surface point belongs to (for colour and spacing).
function partOf(p) {
  const q = parts(p);
  if (q.beard < 0.02) return 'beard';
  if (q.collar < 0.02) return 'collar';
  if (q.hair < 0.03 && p[1] > 0.36) return 'hair';
  if (q.feat < 0) return 'feat';
  if (p[1] > 0.05 && p[1] < 0.5 && (Math.abs(p[0]) > 0.5 || p[2] < -0.2)) return 'side'; // short faded sides
  return 'skin';
}
const grad = (p) => {
  const e = 1e-4;
  const g = [0, 1, 2].map((i) => { const a = [...p], b = [...p]; a[i] += e; b[i] -= e; return (sdf(a) - sdf(b)) / (2 * e); });
  const l = len(...g) || 1;
  return g.map((v) => v / l);
};

// ---- Sample the surface ----
const raw = [];
for (let i = 0; i < 170000; i++) {
  let p = [rand() * 2 - 1, rand() * 3 - 1.8, rand() * 2.4 - 1.1];
  for (let k = 0; k < 10; k++) { const d = sdf(p), g = grad(p); p = p.map((v, j) => v - d * g[j]); }
  if (Math.abs(sdf(p)) < 2e-3 && p[1] > -1.5 && Math.abs(p[0]) < 1.1) raw.push(p);
}
// Even spacing: greedy Poisson-disk thinning on a hash grid; denser on the face, hair and beard.
const spacingOf = (part, p) => part === 'beard' ? 0.038 : part === 'hair' ? 0.048
  : (part === 'skin' || part === 'feat') && p[2] > 0.45 && p[1] > -0.95 && p[1] < 0.45 ? 0.046 : SPACING;
const cell = SPACING, grid = new Map(), pts = [];
const key = (x, y, z) => `${x},${y},${z}`;
for (const p of raw) {
  const part = partOf(p), min = spacingOf(part, p);
  const gx = Math.floor(p[0] / cell), gy = Math.floor(p[1] / cell), gz = Math.floor(p[2] / cell);
  let ok = true;
  for (let a = -1; a <= 1 && ok; a++) for (let b = -1; b <= 1 && ok; b++) for (let c = -1; c <= 1 && ok; c++) {
    for (const q of grid.get(key(gx + a, gy + b, gz + c)) || []) if (len(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < min) { ok = false; break; }
  }
  if (!ok) continue;
  const k = key(gx, gy, gz);
  if (!grid.has(k)) grid.set(k, []);
  grid.get(k).push(p);
  p.part = part;
  pts.push(p);
}

// ---- Render ----
const SCALE = 200, CX = 330, TOP = 1.32; // model y = TOP maps to screen y = 44
const sy = (y) => 44 + (TOP - y) * SCALE;
const AXIS_Z = 0.08; // rotate about the head's centre, not the origin
const rMax = Math.max(...pts.map((p) => Math.hypot(p[0], p[2] - AXIS_Z)));
const OPACITY_BUCKETS = 6, COLORS = 6;
const yMin = Math.min(...pts.map((p) => p[1])), yMax = Math.max(...pts.map((p) => p[1]));
const fmt = (n) => +n.toFixed(1);

pts.sort((a, b) => a[2] - b[2]);
const dots = pts.map((p) => {
  const x = p[0], z = p[2] - AXIS_Z;
  const r = Math.hypot(x, z) * SCALE;
  // At t=0 the head faces the viewer; screen offset = r*cos(phi), depth = r*sin(phi).
  const phi = Math.atan2(z, x);
  const tau = 2 * Math.PI;
  const dx = -(((phi % tau) + tau) % tau) / tau * PERIOD; // x sweep phase
  const dz = -((((phi - Math.PI / 2) % tau) + tau) % tau) / tau * PERIOD; // depth phase
  const ob = Math.min(OPACITY_BUCKETS - 1, Math.floor((Math.hypot(x, z) / rMax) * OPACITY_BUCKETS));
  const cb = { hair: 'h', beard: 'b', side: 's', collar: 'k', feat: 'f' }[p.part] || Math.min(COLORS - 1, Math.floor(((yMax - p[1]) / (yMax - yMin)) * COLORS));
  const neckFade = p[1] < -1.1 ? ` fill-opacity="${fmt(Math.max(0.1, (p[1] + 1.5) / 0.4))}"` : '';
  return `<circle class="d c${cb} o${ob}" cx="${CX}" cy="${fmt(sy(p[1]))}" r="1.9" style="--r:${fmt(r)}px;animation-delay:${dx.toFixed(2)}s,${dz.toFixed(2)}s"${neckFade}/>`;
});

const palette = ['#7dd3fc', '#60a5fa', '#818cf8', '#a78bfa', '#c084fc', '#e879f9'];
const half = PERIOD / 2;
const opacityKeyframes = Array.from({ length: OPACITY_BUCKETS }, (_, i) => {
  const a = (i + 0.5) / OPACITY_BUCKETS; // how much depth this bucket swings
  const hi = (0.6 + 0.4 * a).toFixed(2), lo = (0.6 - 0.52 * a).toFixed(2);
  return `@keyframes z${i}{from{opacity:${hi}}to{opacity:${lo}}}.o${i}{animation-name:sw,z${i}}`;
}).join('');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="t d">
<title id="t">HADES - the autonomous AI software company</title>
<desc id="d">A 3D portrait of the author's head (curly hair, moustache and goatee) made of a cluster of glowing dots, slowly turning, next to the HADES name and tagline.</desc>
<defs>
<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#05070f"/><stop offset="1" stop-color="#111530"/></linearGradient>
<radialGradient id="glow" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#6366f1" stop-opacity="0.32"/><stop offset="1" stop-color="#6366f1" stop-opacity="0"/></radialGradient>
<linearGradient id="title" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#7dd3fc"/><stop offset="0.55" stop-color="#a78bfa"/><stop offset="1" stop-color="#e879f9"/></linearGradient>
<pattern id="grid" width="32" height="32" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill="#ffffff" fill-opacity="0.05"/></pattern>
</defs>
<style>
.d{transform-box:view-box;animation-duration:${half}s;animation-timing-function:cubic-bezier(.37,0,.63,1);animation-iteration-count:infinite;animation-direction:alternate}
@keyframes sw{from{transform:translateX(var(--r))}to{transform:translateX(calc(var(--r) * -1))}}
${opacityKeyframes}
${palette.map((c, i) => `.c${i}{fill:${c}}`).join('')}.ch{fill:#e0f2fe}.cb{fill:#f5f3ff}.cs{fill:#93c5fd}.ck{fill:#fb7185}.cf{fill:#c7d2fe}
@media (prefers-reduced-motion:reduce){.d{animation-play-state:paused}}
text{font-family:'Segoe UI',Inter,Helvetica,Arial,sans-serif}
</style>
<rect width="${W}" height="${H}" rx="24" fill="url(#bg)"/>
<rect width="${W}" height="${H}" rx="24" fill="url(#grid)"/>
<ellipse cx="${CX}" cy="${H / 2}" rx="300" ry="300" fill="url(#glow)"/>
<g>${dots.join('')}</g>
<text x="640" y="262" font-size="120" font-weight="800" letter-spacing="10" fill="url(#title)">HADES</text>
<text x="646" y="320" font-size="31" font-weight="600" fill="#e2e8f0">The autonomous AI software company</text>
<text x="646" y="372" font-size="22" fill="#94a3b8">Requirements in. Tested, security-scanned commits out.</text>
<text x="646" y="404" font-size="22" fill="#94a3b8">11 AI role agents, one pipeline, zero pushes without you.</text>
<text x="646" y="474" font-size="16" letter-spacing="1.5" fill="#64748b">CLAUDE CODE · CODEX · CURSOR · GEMINI CLI · COPILOT · MIT</text>
</svg>
`;
fs.writeFileSync(OUT, svg);
console.log(`${pts.length} dots, ${(svg.length / 1024).toFixed(0)} KB -> ${OUT}`);
