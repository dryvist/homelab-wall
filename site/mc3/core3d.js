// MC3 hero scene on three.js WebGPURenderer + TSL. WebGPURenderer picks WebGPU when the browser
// has an adapter and falls back to its own WebGL2 backend otherwise (compute then runs as
// transform feedback), so this one module covers both; mc3.js keeps the 2D canvas reactor for
// hosts where neither is acceptable (hardwareGL() false, ?gl=2d) or where init throws.
//
// One GPU particle buffer holds every core's nebula, interleaved (particle i belongs to core
// i % coreCount) so drawing/simulating only the first N particles thins every core evenly when
// frame time forces the budget down. A slice of each core's particles flows to the central hub
// along an arc (only while that model is actually serving tokens); request-feed rows arrive as
// CPU-driven comets. Post: bloom -> afterimage trails -> subtle chromatic aberration.
// Each model's core sits on its accelerator anchor, and the stream from that core runs to the hub.
import * as THREE from 'three/webgpu';
import {
  Fn, If, PI, cross, float, hash, instanceIndex, instancedArray, mix, mx_noise_vec3, oneMinus, pass,
  select, sin, smoothstep, uint, uniform, uniformArray, uv, varying, vec2, vec3, vec4,
} from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { afterImage } from 'three/addons/tsl/display/AfterImageNode.js';
import { chromaticAberration } from 'three/addons/tsl/display/ChromaticAberrationNode.js';
import { clamp, adaptiveBloomOn, adaptiveDpr, hardwareGL } from '/lib/stage.js';

export const MAX_CORES = 8;
const PER_CORE = 100_000;
const MAX_PARTICLES = MAX_CORES * PER_CORE;
// Simulated/drawn counts snap to this step so a budget change reuses a cached compute kernel.
const CHUNK = 20_000;
const MIN_QUALITY = 0.05;
const STREAM_FRAC = 0.14;
const COMET_MAX = 32;
const TRAIL = 18;
const SLOW_FRAME_MS = 20;
const FAST_FRAME_MS = 17.5;
// Accelerator anchors (mc3.js ANCHOR_DEFS order). Each is pinned to a screen point that mc3.js lays
// out in the free area, so it holds its place while the camera drifts. The wireframe core runs from
// ANCHOR_R_MIN (no busy reading) to ANCHOR_R_MAX (fully busy); at this camera 1 unit is about 4.5 px,
// so the core spans roughly 40-70 px across.
const MAX_ANCHORS = 8;
const ANCHOR_R_MIN = 4.6;
const ANCHOR_R_MAX = 7.8;
const ANCHOR_COLOR = { gpu: '#3ee6ff', mac: '#38ff9c', cloud: '#ffb347' };
// Mirrors mc3.js: beads are drawn one each up to BEAD_RING, then packed into rings up to BEAD_CAP.
const BEAD_RING = 12;
const BEAD_CAP = 36;
// Model cores spread on a small ring around their anchor when several models share it.
const ANCHOR_SPREAD = 24;

const strHash = (s) => { let h = 2166136261; for (const ch of String(s)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619); return h >>> 0; };
const norm = (s) => String(s ?? '').toLowerCase().split('/').pop();
// tok/s -> 0..1 on a log scale (~127 tok/s saturates).
const tokNorm = (tok) => clamp(Math.log2(1 + Math.max(0, tok || 0)) / 7, 0, 1);

export async function buildGpuCore(canvas, { palette, reducedMotion = false, onLost } = {}) {
  const RM = reducedMotion;
  const colorFor = (name) => palette[strHash(norm(name)) % palette.length];

  const renderer = new THREE.WebGPURenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance' });
  renderer.setClearColor(0x000000, 1);
  await renderer.init();
  renderer.onDeviceLost = (info) => onLost?.(info);

  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(46, 1, 1, 3000);
  // The left glass column and the bottom model band cover part of the full-viewport canvas, so
  // the camera aims left of/below the hub to centre the scene in the open area.
  const AIM = new THREE.Vector3(-30, -8, 0);
  cam.position.set(AIM.x, 14, 285);
  cam.lookAt(AIM);

  /* ---------------- per-core uniforms ---------------- */
  const uDt = uniform(0);
  const uTime = uniform(0);
  const uCount = uniform(1, 'uint');
  const uHub = uniform(new THREE.Vector3(0, 0, 0));
  const uSize = uniform(0.75);
  const uAlpha = uniform(0.07);
  // A: centre.xyz + nebula radius; B: flow speed, stream speed, brightness, up flag.
  const coreA = uniformArray(Array.from({ length: MAX_CORES }, () => new THREE.Vector4()), 'vec4');
  const coreB = uniformArray(Array.from({ length: MAX_CORES }, () => new THREE.Vector4()), 'vec4');
  const coreC = uniformArray(Array.from({ length: MAX_CORES }, () => new THREE.Color()), 'color');

  /* ---------------- particle buffers + compute ---------------- */
  const pos = instancedArray(MAX_PARTICLES, 'vec3');
  const vel = instancedArray(MAX_PARTICLES, 'vec3');
  const phase = instancedArray(MAX_PARTICLES, 'float');

  // Particles boot as a dense ball at the hub and spread out to their cores once data arrives.
  const init = Fn(() => {
    const i = instanceIndex;
    const dir = vec3(hash(i), hash(i.add(uint(1))), hash(i.add(uint(2)))).mul(2).sub(1);
    pos.element(i).assign(dir.mul(hash(i.add(uint(3))).mul(28)));
    vel.element(i).assign(vec3(0));
    phase.element(i).assign(hash(i.add(uint(4))));
  })().compute(MAX_PARTICLES);

  // Curl of a vec3 Perlin potential (forward differences): divergence-free, so the nebula swirls
  // instead of collapsing or exploding.
  const curl = Fn(([p]) => {
    const e = 0.3;
    const n = mx_noise_vec3(p).toVar();
    const dx = mx_noise_vec3(p.add(vec3(e, 0, 0))).sub(n).toVar();
    const dy = mx_noise_vec3(p.add(vec3(0, e, 0))).sub(n).toVar();
    const dz = mx_noise_vec3(p.add(vec3(0, 0, e))).sub(n).toVar();
    return vec3(dy.z.sub(dz.y), dz.x.sub(dx.z), dx.y.sub(dy.x)).div(e);
  });

  const update = Fn(() => {
    const i = instanceIndex;
    const k = i.mod(uCount);
    const a = coreA.element(k);
    const b = coreB.element(k);
    const p = pos.element(i);
    const v = vel.element(i);
    const ph = phase.element(i);
    const seed = hash(i.add(uint(5)));
    const centre = a.xyz;
    If(seed.lessThan(STREAM_FRAC).and(b.y.greaterThan(0)), () => {
      // Hub stream: a quadratic arc core -> hub, re-spawning at the core.
      const t = ph.add(uDt.mul(b.y).mul(seed.mul(3).add(0.7))).fract().toVar();
      ph.assign(t);
      const mid = mix(centre, uHub, 0.5).add(vec3(0, a.w.mul(1.4), a.w.mul(0.6)));
      const q = mix(mix(centre, mid, t), mix(mid, uHub, t), t);
      const wobble = mx_noise_vec3(vec3(seed.mul(97), t.mul(4), uTime.mul(0.3))).mul(sin(t.mul(PI)).mul(a.w).mul(0.22));
      p.assign(q.add(wobble));
      v.assign(vec3(0));
    }).Else(() => {
      const rel = p.sub(centre).toVar();
      const dist = rel.length().max(0.001).toVar();
      const radial = rel.div(dist).toVar();
      const shell = a.w.mul(hash(i.add(uint(6))).pow(0.6).mul(0.85).add(0.15));
      const flow = curl(p.mul(0.042).add(vec3(0, uTime.mul(0.06), k.toFloat().mul(13.7))));
      const swirl = cross(radial, vec3(0.15, 1, 0.1).normalize()).mul(a.w.mul(0.55));
      const desired = flow.mul(a.w.mul(0.9)).add(swirl).mul(b.x).add(radial.mul(shell.sub(dist)).mul(1.4));
      v.assign(mix(v, desired, uDt.mul(2.5).min(1)));
      p.addAssign(v.mul(uDt));
    });
  });
  const kernels = new Map();
  const kernelFor = (n) => { let c = kernels.get(n); if (!c) { c = update().compute(n); kernels.set(n, c); } return c; };

  const vk = instanceIndex.mod(uCount);
  const isStream = hash(instanceIndex.add(uint(5))).lessThan(STREAM_FRAC).and(coreB.element(vk).y.greaterThan(0));
  // Stream particles brighten toward the hub so a still frame still reads the flow direction.
  const boost = select(isStream, mix(float(0.6), float(2.8), phase.toAttribute()), float(1));
  const tint = varying(coreC.element(vk).mul(coreB.element(vk).z).mul(boost));
  const sizeSeed = hash(instanceIndex.add(uint(9)));
  const pMat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  pMat.positionNode = pos.toAttribute();
  pMat.scaleNode = uSize.mul(sizeSeed.mul(sizeSeed).mul(1.8).add(0.4));
  pMat.colorNode = Fn(() => {
    const d = uv().sub(0.5).length();
    const fall = oneMinus(smoothstep(0, 0.5, d));
    return vec4(tint, fall.mul(fall).mul(uAlpha));
  })();
  const particles = new THREE.Sprite(pMat);
  particles.frustumCulled = false;
  particles.count = 0;
  scene.add(particles);

  /* ---------------- hub ---------------- */
  const hub = new THREE.Group();
  scene.add(hub);
  const hubCore = new THREE.Mesh(new THREE.IcosahedronGeometry(5, 2), new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(1.6, 1.5, 2.1), wireframe: true }));
  hub.add(hubCore);
  const hubGlowMat = new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(1.4, 1.1, 1.8), transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false });
  const hubGlow = new THREE.Mesh(new THREE.SphereGeometry(2.6, 24, 24), hubGlowMat);
  hub.add(hubGlow);
  const hubRings = [0, 1, 2].map((r) => {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(9 + r * 4.5, 0.22, 8, 96), new THREE.MeshBasicNodeMaterial({ color: new THREE.Color('#ff4fd8').multiplyScalar(1.4 - r * 0.3), transparent: true, opacity: 0.8 - r * 0.2, blending: THREE.AdditiveBlending, depthWrite: false }));
    ring.rotation.x = Math.PI / 2 + r * 0.45; ring.rotation.y = r * 0.6;
    hub.add(ring);
    return ring;
  });

  /* ---------------- core wireframe centres ---------------- */
  const coreMeshes = Array.from({ length: MAX_CORES }, (_, i) => {
    const mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 1), new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(), wireframe: true, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
    mesh.visible = false;
    mesh.rotation.set(i * 0.7, i * 1.3, 0);
    scene.add(mesh);
    return mesh;
  });

  /* ---------------- comets ---------------- */
  const cometMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const cometMesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), cometMat, COMET_MAX * TRAIL);
  cometMesh.frustumCulled = false;
  const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
  const BLACK = new THREE.Color(0, 0, 0);
  for (let j = 0; j < COMET_MAX * TRAIL; j++) { cometMesh.setMatrixAt(j, ZERO); cometMesh.setColorAt(j, BLACK); }
  scene.add(cometMesh);
  const comets = [];
  let cometsDirty = false;

  /* ---------------- accelerator anchors ---------------- */
  // A node draws an additive glow sprite that fades to nothing at its edge, a wireframe core sized by
  // busy %, and a hairline halo ring. Every translucent layer is at most 0.25 opacity. A dim node (idle
  // or no data) draws its outline only. The cloud node (the last anchor) gets an octahedron core
  // instead of an icosahedron.
  const icoGeom = new THREE.IcosahedronGeometry(1, 2);
  const octGeom = new THREE.OctahedronGeometry(1, 0);
  const ringGeom = new THREE.TorusGeometry(1, 0.035, 6, 96);
  const anchorNodes = Array.from({ length: MAX_ANCHORS }, () => {
    const grp = new THREE.Group();
    const glowCol = uniform(new THREE.Color());
    const glowA = uniform(0);
    const glowMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    glowMat.colorNode = Fn(() => {
      const d = uv().sub(0.5).length().mul(2);
      const fall = oneMinus(smoothstep(0, 1, d));
      return vec4(glowCol, fall.mul(fall).mul(glowA));
    })();
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), glowMat);
    const core = new THREE.Mesh(icoGeom, new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(), wireframe: true, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false }));
    const ring = new THREE.Mesh(ringGeom, new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(), transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false }));
    ring.rotation.set(1.1, 0, 0.3);
    grp.add(glow, core, ring);
    grp.visible = false;
    scene.add(grp);
    return { grp, glow, glowCol, glowA, core, ring };
  });
  // Request beads: one instanced mesh with BEAD_CAP slots per anchor.
  const beadMesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }), MAX_ANCHORS * BEAD_CAP);
  beadMesh.frustumCulled = false;
  for (let j = 0; j < MAX_ANCHORS * BEAD_CAP; j++) { beadMesh.setMatrixAt(j, ZERO); beadMesh.setColorAt(j, BLACK); }
  scene.add(beadMesh);
  const anchorState = Array.from({ length: MAX_ANCHORS }, () => ({
    kind: 'gpu', dim: true, centre: new THREE.Vector3(), color: new THREE.Color(), pt: { x: 0, y: 0 },
    active: 0, shown: 0, lit: 0, litTarget: 0,
  }));
  let anchorCount = 0;
  const ORIGIN = new THREE.Vector3();
  const ndcV = new THREE.Vector3();
  const rayV = new THREE.Vector3();

  // Pins each anchor to its screen point: the world point on the z = 0 plane under that pixel, from
  // this frame's camera. The node keeps its place in the free area while the camera drifts.
  function pinAnchors() {
    if (!canvas.clientWidth || !canvas.clientHeight) return;
    cam.updateMatrixWorld();
    for (let i = 0; i < anchorCount; i++) {
      const { x, y } = anchorState[i].pt;
      ndcV.set((x / canvas.clientWidth) * 2 - 1, 1 - (y / canvas.clientHeight) * 2, 0.5).unproject(cam);
      rayV.copy(ndcV).sub(cam.position).normalize();
      anchorState[i].centre.copy(cam.position).addScaledVector(rayV, -cam.position.z / rayV.z);
    }
  }

  /* ---------------- post-processing ---------------- */
  const pipeline = new THREE.RenderPipeline(renderer);
  const scenePass = pass(scene, cam);
  const sceneColor = scenePass.getTextureNode('output');
  const uDamp = uniform(RM ? 0 : 0.82);
  const uAberration = uniform(RM ? 0 : 0.35);
  const lit = sceneColor.add(bloom(sceneColor, 1.25, 0.5, 0.35));
  // chromaticAberration has no default centre in this three release; pass the screen centre.
  const fullOut = chromaticAberration(afterImage(lit, uDamp), uAberration, vec2(0.5, 0.5));
  const liteOut = afterImage(sceneColor, uDamp);
  let bloomOn = adaptiveBloomOn();
  pipeline.outputNode = bloomOn ? fullOut : liteOut;

  /* ---------------- state ---------------- */
  const state = Array.from({ length: MAX_CORES }, () => ({
    name: '', up: false, centre: new THREE.Vector3(), target: new THREE.Vector3(), radius: 0, targetRadius: 0,
    anchor: -1, offset: new THREE.Vector3(),
    flow: 0, stream: 0, bright: 0, targetBright: 0, color: new THREE.Color(), targetColor: new THREE.Color(),
  }));
  let coreCount = 0;
  // A software rasterizer (a forced ?gl=3d on a host without a GPU) starts at the smallest
  // budget and earns more only if frames stay fast.
  let quality = hardwareGL() ? 1 : MIN_QUALITY;
  let emaMs = 16;
  let lastAdjust = 0;
  let lastNow = 0;
  let lastRender = 0;
  let hubPulse = 0;

  // models: [{n, up, tok, anchor}] (any order; sorted by name here so a core keeps its slot, position
  // and colour while the model tab re-sorts by load). anchor indexes `anchors`; a missing or invalid
  // index puts the model on the last anchor, the cloud node. tokensToday: real 24h total or null.
  // anchors: [{kind, busy, active, dim}] in mc3.js ANCHOR_DEFS order; their screen points come from layout().
  function sync(models, tokensToday, anchors = []) {
    anchorCount = Math.min(MAX_ANCHORS, anchors.length);
    anchors.slice(0, anchorCount).forEach((a, i) => {
      const s = anchorState[i];
      s.kind = a.kind;
      s.dim = !!a.dim;
      s.active = Math.max(0, Math.round(a.active || 0));
      s.litTarget = Number.isFinite(a.busy) ? clamp(a.busy / 100, 0, 1) : 0;
      s.color.set(ANCHOR_COLOR[a.kind] ?? ANCHOR_COLOR.gpu);
      const node = anchorNodes[i];
      node.core.geometry = a.kind === 'cloud' ? octGeom : icoGeom;
      node.glowCol.value.copy(s.color);
    });
    const list = [...models].sort((x, y) => x.n.localeCompare(y.n)).slice(0, MAX_CORES);
    const g = Number.isFinite(tokensToday) ? clamp(Math.log10(1 + tokensToday) / 8, 0.12, 1) : 0.3;
    const maxTok = Math.max(0, ...list.map((m) => (m.up ? m.tok || 0 : 0)));
    const at = list.map((m) => (Number.isInteger(m.anchor) && m.anchor >= 0 && m.anchor < anchorCount ? m.anchor : anchorCount - 1));
    const perAnchor = new Array(anchorCount).fill(0);
    for (const a of at) if (a >= 0) perAnchor[a] += 1;
    const seenAt = new Array(anchorCount).fill(0);
    coreCount = list.length;
    uCount.value = Math.max(1, coreCount);
    list.forEach((m, i) => {
      const s = state[i];
      const tn = m.up ? tokNorm(m.tok) : 0;
      const share = maxTok > 0 && m.up ? (m.tok || 0) / maxTok : 0;
      s.name = m.n;
      s.up = !!m.up;
      // A core rides its anchor (render() follows the anchor's pinned point); models sharing one anchor spread on a small ring.
      const a = at[i];
      const k = a >= 0 ? seenAt[a]++ : 0;
      const n = a >= 0 ? perAnchor[a] : 1;
      s.anchor = a;
      s.offset.set(0, 0, 0);
      if (n > 1) {
        const ang = (k / n) * Math.PI * 2 + a * 0.7;
        s.offset.set(Math.cos(ang) * ANCHOR_SPREAD, Math.sin(ang) * ANCHOR_SPREAD * 0.5, 0);
      }
      s.targetRadius = (12 + 20 * g) * (0.75 + 0.5 * share);
      s.flow = m.up ? 0.3 + 1.7 * tn : 0.06;
      s.stream = m.up && (m.tok || 0) > 0.05 ? 0.12 + 0.55 * tn : 0;
      s.targetBright = m.up ? (0.45 + 1.05 * g) * (0.8 + 0.5 * tn) : 0.1;
      s.targetColor.set(colorFor(m.n));
      if (!s.bright) s.color.copy(s.targetColor);
    });
    for (let i = list.length; i < MAX_CORES; i++) { state[i].radius = 0; state[i].targetRadius = 0; state[i].bright = 0; state[i].targetBright = 0; state[i].name = ''; }
  }

  // Screen points (CSS px) for the anchors, from mc3.js; applied on the next frame.
  function layout(points) {
    points.slice(0, MAX_ANCHORS).forEach((p, i) => { anchorState[i].pt = { x: p.x, y: p.y }; });
  }

  // row: one /api/llm/recent row ({ts, source, model, role, chars}). Launches from the core
  // serving that model, or — for a model no local core serves — from a fixed point on an outer
  // ring per source, so every comet's origin is the row's own identity.
  function comet(row, delayMs = 0) {
    if (RM) return;
    const want = norm(row.model);
    const idx = want ? state.slice(0, coreCount).findIndex((s) => norm(s.name) === want) : -1;
    let from, color;
    if (idx >= 0) { from = state[idx].centre.clone(); color = state[idx].color.clone(); }
    else {
      const a = (strHash(row.source) % 360) * Math.PI / 180;
      from = new THREE.Vector3(Math.cos(a) * 260, Math.sin(a) * 120, -60);
      color = new THREE.Color(colorFor(row.source || row.model));
    }
    const chars = Math.max(0, Number(row.chars) || 0);
    if (comets.length >= COMET_MAX) comets.shift();
    comets.push({ from, color, t0: performance.now() + delayMs, dur: 1500 + Math.random() * 500, size: 0.9 + Math.log10(1 + chars) * 0.45 });
  }

  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, adaptiveDpr(1.5));
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr)), h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    renderer.setPixelRatio(1);
    renderer.setSize(w, h, false);
    cam.aspect = w / (h || 1);
    cam.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(canvas.parentElement);
  resize();
  renderer.compute(init);

  function adapt(now) {
    const dt = now - lastNow;
    lastNow = now;
    if (!(dt > 0) || dt > 250) return; // first frame or resuming from a paused (hidden) page
    emaMs = emaMs * 0.9 + dt * 0.1;
    if (emaMs > SLOW_FRAME_MS && quality > MIN_QUALITY && now - lastAdjust > 600) { quality = Math.max(MIN_QUALITY, quality * 0.7); lastAdjust = now; }
    else if (emaMs < FAST_FRAME_MS && quality < 1 && now - lastAdjust > 2500) { quality = Math.min(1, quality / 0.85); lastAdjust = now; }
  }

  const m4 = new THREE.Matrix4();
  const tmpC = new THREE.Color();
  const tmpV = new THREE.Vector3();
  const mid = new THREE.Vector3();
  function drawComets(now) {
    if (!comets.length && !cometsDirty) return;
    cometsDirty = comets.length > 0;
    for (let c = comets.length - 1; c >= 0; c--) if ((now - comets[c].t0) / comets[c].dur > 1.4) { comets.splice(c, 1); hubPulse = Math.min(1.5, hubPulse + 0.35); }
    for (let s = 0; s < COMET_MAX; s++) {
      const cm = comets[s];
      for (let j = 0; j < TRAIL; j++) {
        const idx = s * TRAIL + j;
        const t = cm ? (now - cm.t0) / cm.dur - j * 0.022 : -1;
        if (t < 0 || t > 1) { cometMesh.setMatrixAt(idx, ZERO); continue; }
        const e = 1 - (1 - t) * (1 - t);
        mid.copy(cm.from).lerp(uHub.value, 0.5); mid.y += 40; mid.z += 30;
        tmpV.copy(cm.from).lerp(mid, e).lerp(mid.clone().lerp(uHub.value, e), e);
        const fade = 1 - j / TRAIL;
        const sc = cm.size * (0.25 + 0.75 * fade);
        m4.makeScale(sc, sc, sc).setPosition(tmpV);
        cometMesh.setMatrixAt(idx, m4);
        cometMesh.setColorAt(idx, tmpC.copy(cm.color).multiplyScalar(3.2 * fade * fade));
      }
    }
    cometMesh.instanceMatrix.needsUpdate = true;
    if (cometMesh.instanceColor) cometMesh.instanceColor.needsUpdate = true;
  }

  // Anchor nodes and their request beads. Up to BEAD_RING beads sit on one orbit; past that they
  // pack into rings, BEAD_CAP drawn at most. The count eases toward its reading, so beads grow in
  // and fade out rather than snapping.
  function drawAnchors(dt, t, ease) {
    for (let i = 0; i < MAX_ANCHORS; i++) {
      const a = anchorState[i];
      const node = anchorNodes[i];
      const live = i < anchorCount;
      node.grp.visible = live;
      a.lit += (a.litTarget - a.lit) * ease;
      a.shown += ((live ? Math.min(a.active, BEAD_CAP) : 0) - a.shown) * ease;
      if (live) {
        node.grp.position.copy(a.centre);
        const r = ANCHOR_R_MIN + (ANCHOR_R_MAX - ANCHOR_R_MIN) * a.lit;
        node.core.scale.setScalar(r);
        node.core.material.color.copy(a.color).multiplyScalar(a.dim ? 0.6 : 1.1 + 0.5 * a.lit);
        node.core.material.opacity = a.dim ? 0.3 : 0.95;
        node.glow.scale.setScalar(r * 4.4);
        node.glowA.value = a.dim ? 0 : 0.12 + 0.13 * a.lit;
        node.ring.scale.setScalar(r * 2.3);
        node.ring.material.color.copy(a.color).multiplyScalar(a.dim ? 0.5 : 1);
        node.ring.material.opacity = a.dim ? 0.1 : 0.22;
        if (!RM) { node.core.rotation.y += dt * 0.4; node.core.rotation.x += dt * 0.15; node.ring.rotation.z += dt * 0.5; }
      }
      const drawn = live ? Math.min(a.active, BEAD_CAP) : 0;
      const n = Math.min(BEAD_CAP, Math.max(drawn, Math.ceil(a.shown - 1e-3)));
      const rings = n > BEAD_RING ? Math.ceil(n / BEAD_RING) : 1;
      for (let k = 0; k < BEAD_CAP; k++) {
        const idx = i * BEAD_CAP + k;
        const fade = k < n ? clamp(a.shown - k, 0, 1) : 0;
        if (fade <= 0) { beadMesh.setMatrixAt(idx, ZERO); continue; }
        const ring = k % rings;
        const j = Math.floor(k / rings);
        const inRing = Math.ceil((n - ring) / rings);
        const phi = (j / inRing) * Math.PI * 2 + ring * 0.9 + (ring % 2 ? -1 : 1) * (RM ? 0 : t) * (0.9 / (1 + ring * 0.35));
        const R = 14 + ring * 4.5;
        tmpV.set(Math.cos(phi) * R, Math.sin(phi) * R * 0.4, Math.sin(phi) * R * 0.4).add(a.centre);
        const size = (rings > 1 ? 1.1 : 1.5) * fade;
        m4.makeScale(size, size, size).setPosition(tmpV);
        beadMesh.setMatrixAt(idx, m4);
        beadMesh.setColorAt(idx, tmpC.copy(a.color).multiplyScalar(3 * fade));
      }
    }
    beadMesh.instanceMatrix.needsUpdate = true;
    if (beadMesh.instanceColor) beadMesh.instanceColor.needsUpdate = true;
  }

  function render(now) {
    // Reduced motion: no camera drift, no trails/aberration, a slowed flow and a ~8 fps redraw.
    if (RM && now - lastRender < 125) return;
    const dt = lastRender ? Math.min((now - lastRender) / 1000, 1 / 20) : 0;
    lastRender = now;
    adapt(now);
    const t = now / 1000;

    // Camera drift first, so the anchors are pinned against this frame's view.
    if (!RM) {
      cam.position.x = AIM.x + Math.sin(t * 0.07) * 24;
      cam.position.y = 14 + Math.sin(t * 0.05) * 10;
      cam.lookAt(AIM);
    }
    pinAnchors();

    const ease = 1 - Math.exp(-dt * 1.8);
    for (let i = 0; i < MAX_CORES; i++) {
      const s = state[i];
      if (s.anchor >= 0) s.target.copy(anchorState[s.anchor].centre).add(s.offset);
      else s.target.copy(ORIGIN);
      if (!s.radius) s.centre.copy(s.target);
      s.centre.lerp(s.target, ease);
      s.radius += (s.targetRadius - s.radius) * ease;
      s.bright += (s.targetBright - s.bright) * ease;
      s.color.lerp(s.targetColor, ease);
      coreA.array[i].set(s.centre.x, s.centre.y, s.centre.z, s.radius);
      coreB.array[i].set(s.flow * (RM ? 0.15 : 1), s.stream * (RM ? 0.15 : 1), s.bright, s.up ? 1 : 0);
      coreC.array[i].copy(s.color);
      const mesh = coreMeshes[i];
      mesh.visible = i < coreCount;
      if (mesh.visible) {
        mesh.position.copy(s.centre);
        mesh.scale.setScalar(Math.max(1, s.radius * 0.16));
        mesh.material.color.copy(s.color).multiplyScalar(0.6 + s.bright);
        if (!RM) { mesh.rotation.y += dt * (0.2 + s.flow * 0.5); mesh.rotation.x += dt * 0.11; }
      }
    }

    const perCore = coreCount ? Math.max(CHUNK, Math.round((PER_CORE * quality) / CHUNK) * CHUNK) : 0;
    const n = Math.min(MAX_PARTICLES, perCore * coreCount);
    particles.count = n;
    // Fewer particles -> brighter each, so a thinned nebula keeps roughly the same glow.
    uAlpha.value = clamp(0.07 * Math.sqrt(PER_CORE / Math.max(1, perCore)), 0.07, 0.3);
    uDt.value = dt;
    uTime.value = t;
    if (n) renderer.compute(kernelFor(n));

    if (!RM) {
      hub.rotation.y += dt * 0.35;
      hubRings.forEach((r, i) => { r.rotation.z += dt * (0.25 + i * 0.12) * (i % 2 ? -1 : 1); });
    }
    hubPulse *= Math.exp(-dt * 2.5);
    hubGlow.scale.setScalar(1 + hubPulse * 0.8 + (RM ? 0 : Math.sin(t * 1.8) * 0.08));
    hubGlowMat.opacity = 0.45 + Math.min(0.5, hubPulse * 0.4);
    drawComets(now);
    drawAnchors(dt, t, ease);

    const wantBloom = adaptiveBloomOn();
    if (wantBloom !== bloomOn) { bloomOn = wantBloom; pipeline.outputNode = bloomOn ? fullOut : liteOut; pipeline.needsUpdate = true; }
    pipeline.render();
  }

  function dispose() {
    ro.disconnect();
    pipeline.dispose();
    scene.traverse((obj) => {
      obj.geometry?.dispose?.();
      const mats = Array.isArray(obj.material) ? obj.material : obj.material ? [obj.material] : [];
      for (const m of mats) m.dispose?.();
    });
    renderer.dispose();
  }

  return { render, sync, layout, comet, dispose, backend: renderer.backend?.isWebGPUBackend ? 'webgpu' : 'webgl2' };
}
