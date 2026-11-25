// Neon Cycle v0.1.0 — Three.js renderer + menus + game feel.
// The simulation lives in physics.js (pure, no DOM); this file owns
// the 3D scene, the screen stack, input, Web Audio SFX and the feel
// tiers. The rider rides a grid arena (sim x east, sim y north;
// world x = sim x - cols/2, world z = -(sim y - rows/2)); the
// camera chases from behind and above so the grid, every trail and
// the next wall are always readable.
import * as THREE from 'three';
import {
  VERSION, DT, ARENAS, arenaById, createRun, startRun, stepRun,
  decisionPolicy, playerSpeed,
  defaultSave, serializeSave, parseSave, recordBest, isArenaUnlocked, rankFor,
  FEEDBACK,
} from './physics.js';

const SAVE_KEY = 'neon-cycle-save-v1';
const FOV_BASE = 62;

// ---------------------------------------------------------------- save
let save = defaultSave();
try {
  const raw = localStorage.getItem(SAVE_KEY);
  if (raw) save = parseSave(raw);
} catch { /* storage unavailable — play without saving */ }
function persistSave() {
  try { localStorage.setItem(SAVE_KEY, serializeSave(save)); } catch { /* ignore */ }
}
const params = new URLSearchParams(location.search);
if (params.get('unlock') === '1') {
  save.unlocked = ARENAS.length;
  persistSave();
}

// ---------------------------------------------------------------- state
const state = {
  phase: 'menu', // 'menu' | 'playing' | 'paused' | 'complete' | 'gameover'
  arenaId: 1,
  run: null,
  demoRun: createRun(ARENAS[0]),
  autopilot: false,
  trauma: 0,
  hitStopT: 0,
  slowMoT: 0,
  timeScale: 1,
  fovPunch: 0,
  fovDip: 0,
  turnCount: 0,
  lastTrapAnnounced: null,
  lastDenied: null, // sticky copy of the last denied reason (for the render check + HUD cue)
  lastDeniedToast: 0, // performance.now() of the last denied toast — throttles repeat toasts
  musicActive: false,
  toastT: 0,
  muted: save.settings.muted,
  shakePct: save.settings.shake,
  flash: save.settings.flash,
  musicOn: true,
  sfxOn: true,
  volume: 0.6,
  textScale: 1,
  highContrast: false,
  endTimer: null, // pending setTimeout(() => endRun(...)) after a win/loss — cleared on quit / new run (race fix)
};
const screenStack = []; // screen ids, top = last

// ---------------------------------------------------------------- audio
let audioCtx = null;
let masterGain = null;
let musicNodes = null;
function ensureAudio() {
  if (audioCtx) return;
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    masterGain = audioCtx.createGain();
    masterGain.gain.value = state.volume;
    masterGain.connect(audioCtx.destination);
  } catch { audioCtx = null; }
}
function tone(freq, dur, type = 'sine', gain = 0.2, slideTo = null, delay = 0) {
  if (!audioCtx || !masterGain || state.muted || !state.sfxOn) return;
  const t0 = audioCtx.currentTime + delay;
  const osc = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t0 + dur);
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + 0.008);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  osc.connect(g).connect(masterGain);
  osc.start(t0);
  osc.stop(t0 + dur + 0.05);
}
function playSfx(name, energy = 0) {
  if (!audioCtx) return;
  switch (name) {
    case 'turn': tone(520 + energy * 200, 0.05, 'square', 0.07, 700 + energy * 200); break;
    case 'boost': tone(220, 0.25, 'sawtooth', 0.12, 880); break;
    case 'pickup': tone(1320, 0.1, 'sine', 0.16); tone(1760, 0.14, 'sine', 0.12, null, 0.06); break;
    case 'trap':
      [523, 659, 784].forEach((f, i) => tone(f, 0.16, 'sine', 0.16, null, i * 0.06));
      tone(180, 0.2, 'sawtooth', 0.1, 60);
      break;
    case 'crash': tone(200, 0.4, 'sawtooth', 0.22, 40); tone(90, 0.3, 'square', 0.12, 30, 0.05); break;
    case 'finish':
      [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.35, 'sine', 0.16, null, i * 0.09));
      break;
    case 'denied': tone(140, 0.08, 'square', 0.1); break;
    case 'tick': tone(1200, 0.03, 'sine', 0.06); break;
    default: break;
  }
}
// Generative music: a low pad (Am–F–C–G, one chord per bar) plus a
// bass pulse and a soft arpeggio, sequenced from the frame loop with
// a short lookahead. The arpeggio lifts an octave as the rider gains
// speed, so the music rides with you. Everything is scheduled through
// the audio clock — no timers to drift — and every note is guarded:
// with no AudioContext (or while muted) the scheduler simply does nothing.
const MUSIC_BPM = 112;
const MUSIC_STEP = 60 / MUSIC_BPM / 2; // 8th notes
const MUSIC_CHORDS = [
  { root: 110.00, tones: [220.00, 261.63, 329.63] }, // Am
  { root: 87.31, tones: [174.61, 220.00, 261.63] }, // F
  { root: 130.81, tones: [196.00, 261.63, 329.63] }, // C
  { root: 98.00, tones: [196.00, 246.94, 293.66] }, // G
];
let musicStep = 0;
let musicNextTime = 0;
function scheduleMusic() {
  if (!audioCtx || !masterGain || state.muted || !state.musicOn || !state.musicActive) return;
  const ahead = audioCtx.currentTime + 0.25;
  if (musicNextTime < audioCtx.currentTime) musicNextTime = audioCtx.currentTime + 0.05;
  const run = state.run || state.demoRun;
  const speed01 = run ? Math.min(1, Math.max(0, (playerSpeed(run) - 5) / 9)) : 0;
  while (musicNextTime < ahead) {
    const bar = Math.floor(musicStep / 8) % MUSIC_CHORDS.length;
    const chord = MUSIC_CHORDS[bar];
    const stepInBar = musicStep % 8;
    const t0 = musicNextTime;
    if (stepInBar === 0) {
      const osc = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = chord.root;
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(0.16, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + MUSIC_STEP * 7);
      osc.connect(g).connect(masterGain);
      osc.start(t0);
      osc.stop(t0 + MUSIC_STEP * 7 + 0.05);
    }
    const toneF = chord.tones[stepInBar % chord.tones.length] * (speed01 > 0.6 ? 2 : 1);
    const osc = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = toneF;
    const vol = 0.05 + speed01 * 0.05;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + MUSIC_STEP * 0.9);
    osc.connect(g).connect(masterGain);
    osc.start(t0);
    osc.stop(t0 + MUSIC_STEP + 0.05);
    musicStep++;
    musicNextTime += MUSIC_STEP;
  }
}
function startMusic() {
  ensureAudio();
  if (!audioCtx) return;
  state.musicActive = true;
  musicStep = 0;
  musicNextTime = audioCtx.currentTime + 0.05;
}
function stopMusic() {
  state.musicActive = false;
}

// ---------------------------------------------------------------- dom
const $ = (id) => document.getElementById(id);
const isTouch = () => 'ontouchstart' in window || (window.matchMedia && matchMedia('(pointer: coarse)').matches);

// ---------------------------------------------------------------- three
let renderer = null;
let webglOK = true;
try {
  renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
} catch {
  webglOK = false;
}
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x050514);
scene.fog = new THREE.Fog(0x050514, 45, 180);
const camera = new THREE.PerspectiveCamera(FOV_BASE, window.innerWidth / window.innerHeight, 0.1, 500);
const camFwd = new THREE.Vector3(1, 0, 0); // smoothed camera forward
let dprCap = 2;
let particleScale = 1;
let fpsEma = 60;
let fpsLowT = 0;
if (renderer) {
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, dprCap));
  renderer.setSize(window.innerWidth, window.innerHeight);
  $('game-container').appendChild(renderer.domElement);
}
scene.add(new THREE.HemisphereLight(0x8f7bff, 0x0a0a24, 0.9));
const dirLight = new THREE.DirectionalLight(0xffffff, 1.1);
dirLight.position.set(8, 20, 12);
scene.add(dirLight);
const pocketLight = new THREE.PointLight(0x22e6ff, 1.4, 40);
scene.add(pocketLight);

// Stars: a ring low on the horizon, all around the arena, unfogged.
// The chase camera looks down ~27°, so the visible sky is a thin
// band just above the horizon — stars high overhead never enter the
// frame (eye-check fix: the top of the frame was pure black void).
{
  const n = 600;
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const r = 140 + Math.random() * 220;
    const th = Math.random() * Math.PI * 2;
    pos[i * 3] = r * Math.cos(th);
    pos[i * 3 + 1] = 8 + Math.random() * 45;
    pos[i * 3 + 2] = r * Math.sin(th);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const stars = new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xaac4ff, size: 0.9, sizeAttenuation: false, fog: false }));
  scene.add(stars);
}

// A dark ground plane far beyond the arena so the horizon is a
// floor, not pure black void (eye-check fix, same as the stars).
// A faint radial glow around the arena keeps the floor reading as
// lit ground rather than void — a flat dark plane was
// indistinguishable from the sky in portrait.
{
  const gc = document.createElement('canvas');
  gc.width = 512; gc.height = 512;
  const g = gc.getContext('2d');
  g.fillStyle = '#070714';
  g.fillRect(0, 0, 512, 512);
  const grad = g.createRadialGradient(256, 256, 10, 256, 256, 256);
  grad.addColorStop(0, 'rgba(34, 230, 255, 0.13)');
  grad.addColorStop(0.5, 'rgba(34, 230, 255, 0.04)');
  grad.addColorStop(1, 'rgba(34, 230, 255, 0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 512, 512);
  const gtex = new THREE.CanvasTexture(gc);
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(600, 600),
    new THREE.MeshBasicMaterial({ map: gtex }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.06;
  scene.add(ground);
}

// ---------------------------------------------------------------- arena scene
// Sim (x, y) -> world (x - cols/2, 0, -(y - rows/2)): sim +x is world
// +x (east), sim +y is world -z (north), so a left turn in the sim
// is a left turn on screen (Drift M2 lesson).
let currentArena = null;
let arenaGroup = null;
let boostCellMeshes = [];
const unitBoxGeo = new THREE.BoxGeometry(1, 1, 1);

function simToWorld(x, y) {
  return {
    x: x - currentArena.cols / 2,
    z: -(y - currentArena.rows / 2),
  };
}

function makeGridTexture(arena) {
  const W = 512;
  const H = Math.round(512 * arena.rows / arena.cols);
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#07081c';
  ctx.fillRect(0, 0, W, H);
  // Subtle radial glow toward the centre.
  const grad = ctx.createRadialGradient(W / 2, H / 2, 10, W / 2, H / 2, Math.max(W, H) * 0.7);
  grad.addColorStop(0, 'rgba(34, 230, 255, 0.10)');
  grad.addColorStop(1, 'rgba(34, 230, 255, 0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(34, 230, 255, 0.35)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= arena.cols; i++) {
    const x = (i / arena.cols) * W;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
  }
  for (let j = 0; j <= arena.rows; j++) {
    const y = (j / arena.rows) * H;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.anisotropy = 4;
  return tex;
}

function disposeGroup(group) {
  if (!group) return;
  group.traverse((obj) => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
      else obj.material.dispose();
    }
  });
  scene.remove(group);
}

function buildArenaScene(arena) {
  currentArena = arena;
  disposeGroup(arenaGroup);
  boostCellMeshes = [];
  arenaGroup = new THREE.Group();
  pocketLight.color.set(arena.accent);

  // Grid floor.
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(arena.cols, arena.rows),
    new THREE.MeshBasicMaterial({ map: makeGridTexture(arena) }),
  );
  floor.rotation.x = -Math.PI / 2;
  arenaGroup.add(floor);

  // Boundary walls: glowing boxes along the arena edges.
  const wallMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(arena.accent) });
  const wallH = 1.6;
  const mkWall = (w, d, x, z) => {
    const wall = new THREE.Mesh(unitBoxGeo, wallMat);
    wall.scale.set(w, wallH, d);
    wall.position.set(x, wallH / 2, z);
    arenaGroup.add(wall);
  };
  mkWall(arena.cols + 0.4, 0.35, 0, -arena.rows / 2 - 0.17);
  mkWall(arena.cols + 0.4, 0.35, 0, arena.rows / 2 + 0.17);
  mkWall(0.35, arena.rows + 0.4, -arena.cols / 2 - 0.17, 0);
  mkWall(0.35, arena.rows + 0.4, arena.cols / 2 + 0.17, 0);

  // Pillars: glowing columns.
  const pillarMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(arena.accent), emissive: new THREE.Color(arena.accent),
    emissiveIntensity: 0.55, roughness: 0.35, metalness: 0.4,
  });
  for (const p of arena.pillars) {
    const mesh = new THREE.Mesh(unitBoxGeo, pillarMat);
    mesh.scale.set(p.w, 3, p.h);
    mesh.position.set(p.x + p.w / 2 - arena.cols / 2, 1.5, -(p.y + p.h / 2 - arena.rows / 2));
    arenaGroup.add(mesh);
  }

  // Boost cells: gold octahedrons at the cell centres.
  const cellGeo = new THREE.OctahedronGeometry(0.5);
  const cellMat = new THREE.MeshStandardMaterial({
    color: 0xffd75e, emissive: 0xffb52e, emissiveIntensity: 1.2, roughness: 0.3, metalness: 0.6,
  });
  for (const cell of arena.boostCells) {
    const mesh = new THREE.Mesh(cellGeo, cellMat);
    const w = simToWorld(cell.x + 0.5, cell.y + 0.5);
    mesh.position.set(w.x, 1.0, w.z);
    arenaGroup.add(mesh);
    boostCellMeshes.push(mesh);
  }
  scene.add(arenaGroup);
}

// ---------------------------------------------------------------- cycles + trails
function makeCycle(colorHex) {
  const group = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(colorHex), emissive: new THREE.Color(colorHex),
    emissiveIntensity: 0.9, roughness: 0.3, metalness: 0.5,
  });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x0a0a18, roughness: 0.6, metalness: 0.3 });
  const body = new THREE.Mesh(unitBoxGeo, bodyMat);
  body.scale.set(1.7, 0.28, 0.5);
  body.position.y = 0.42;
  group.add(body);
  const nose = new THREE.Mesh(unitBoxGeo, bodyMat);
  nose.scale.set(0.5, 0.2, 0.34);
  nose.position.set(0.95, 0.38, 0);
  group.add(nose);
  const wheelGeo = new THREE.CylinderGeometry(0.3, 0.3, 0.14, 16);
  wheelGeo.rotateX(Math.PI / 2);
  for (const wx of [-0.62, 0.62]) {
    const wheel = new THREE.Mesh(wheelGeo, darkMat);
    wheel.position.set(wx, 0.3, 0);
    group.add(wheel);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.05, 8, 20), bodyMat);
    rim.position.set(wx, 0.3, 0);
    group.add(rim);
  }
  const rider = new THREE.Mesh(unitBoxGeo, new THREE.MeshStandardMaterial({
    color: 0xffd75e, emissive: 0xffb52e, emissiveIntensity: 0.9, roughness: 0.3,
  }));
  rider.scale.set(0.4, 0.5, 0.3);
  rider.position.set(-0.15, 0.75, 0);
  group.add(rider);
  scene.add(group);
  return { group, visAngle: 0 };
}

const playerCycle = makeCycle('#22e6ff');
const rivalCycles = {}; // name -> cycle

// A trail is a polyline of axis-aligned segments, one mesh per
// straight run. The sim's trail is a Set of cells (no order), so
// the segments are tracked here from the rider's position + heading:
// when the heading changes, the old segment closes at the previous
// position and a new one starts.
// Trails read as flat ribbons when every face is the same unlit
// colour — a bright top face over darker sides makes the wall read
// as a wall (eye-check fix: the magenta rival trail was a flat slab).
// Trail height is 0.35, deliberately BELOW the cycle body top (0.56):
// a 1.3-tall wall occluded the rider from the chase camera (eye-check
// fix 2026-11-25 — the player cycle was invisible in every gameplay
// screenshot, 0 gold rider pixels at its projected screen position).
// The trail still reads as a glowing wall edge; the tall arena
// boundary slabs carry the "wall" look.
function makeTrailRenderer(colorHex) {
  const group = new THREE.Group();
  scene.add(group);
  const top = new THREE.Color(colorHex);
  const side = top.clone().multiplyScalar(0.38);
  const matTop = new THREE.MeshBasicMaterial({ color: top });
  const matSide = new THREE.MeshBasicMaterial({ color: side });
  // BoxGeometry face order: +x, -x, +y (top), -y, +z, -z.
  const mat = [matSide, matSide, matTop, matSide, matSide, matSide];
  const segs = []; // { mesh, x1, y1, x2, y2 }
  let lastDir = null;
  let lastPos = null;
  function layout(seg) {
    const w1 = simToWorld(seg.x1, seg.y1);
    const w2 = simToWorld(seg.x2, seg.y2);
    const dx = w2.x - w1.x;
    const dz = w2.z - w1.z;
    const len = Math.max(Math.abs(dx), Math.abs(dz)) + 0.9;
    seg.mesh.position.set((w1.x + w2.x) / 2, 0.175, (w1.z + w2.z) / 2);
    if (Math.abs(dx) >= Math.abs(dz)) seg.mesh.scale.set(len, 0.35, 0.45);
    else seg.mesh.scale.set(0.45, 0.35, len);
  }
  function reset() {
    for (const s of segs) group.remove(s.mesh);
    segs.length = 0;
    lastDir = null;
    lastPos = null;
  }
  function sync(rider) {
    if (!rider.alive && segs.length === 0) return;
    const pos = { x: rider.x, y: rider.y };
    if (!lastDir) {
      const seg = { mesh: new THREE.Mesh(unitBoxGeo, mat), x1: pos.x, y1: pos.y, x2: pos.x, y2: pos.y };
      segs.push(seg);
      group.add(seg.mesh);
      lastDir = { ...rider.dir };
      lastPos = { ...pos };
      return;
    }
    if (rider.dir.x !== lastDir.x || rider.dir.y !== lastDir.y) {
      // Turn: close the old segment at the previous position (just
      // before the turn point) and start a new one here.
      const cur = segs[segs.length - 1];
      cur.x2 = lastPos.x;
      cur.y2 = lastPos.y;
      layout(cur);
      const seg = { mesh: new THREE.Mesh(unitBoxGeo, mat), x1: pos.x, y1: pos.y, x2: pos.x, y2: pos.y };
      segs.push(seg);
      group.add(seg.mesh);
      lastDir = { ...rider.dir };
    }
    const cur = segs[segs.length - 1];
    cur.x2 = pos.x;
    cur.y2 = pos.y;
    layout(cur);
    lastPos = { ...pos };
  }
  function dispose() {
    reset();
    scene.remove(group);
    matTop.dispose();
    matSide.dispose();
  }
  return { group, reset, sync, dispose };
}

let playerTrail = null;
let rivalTrails = {}; // name -> trail renderer

function resetTrails(run) {
  if (playerTrail) playerTrail.dispose();
  for (const t of Object.values(rivalTrails)) t.dispose();
  rivalTrails = {};
  playerTrail = makeTrailRenderer('#22e6ff');
  for (const rival of run.rivals) {
    rivalTrails[rival.name] = makeTrailRenderer(rival.color);
  }
}

// Pooled spark particles (one Points cloud, dead particles parked far away).
const PARTICLE_N = 300;
const particleGeo = new THREE.BufferGeometry();
const particlePos = new Float32Array(PARTICLE_N * 3);
const particleVel = new Float32Array(PARTICLE_N * 3);
const particleLife = new Float32Array(PARTICLE_N);
for (let i = 0; i < PARTICLE_N; i++) particlePos[i * 3 + 1] = -999;
particleGeo.setAttribute('position', new THREE.BufferAttribute(particlePos, 3));
const particles = new THREE.Points(particleGeo, new THREE.PointsMaterial({
  color: 0x9beaff, size: 0.35, transparent: true, opacity: 0.9, depthWrite: false,
}));
scene.add(particles);
let particleCursor = 0;
function spawnParticles(x, y, z, n, spread = 3, up = 4) {
  const count = Math.max(1, Math.round(n * particleScale));
  for (let k = 0; k < count; k++) {
    const i = particleCursor;
    particleCursor = (particleCursor + 1) % PARTICLE_N;
    particlePos[i * 3] = x + (Math.random() - 0.5) * 1.2;
    particlePos[i * 3 + 1] = y + Math.random() * 0.5;
    particlePos[i * 3 + 2] = z + (Math.random() - 0.5) * 1.2;
    particleVel[i * 3] = (Math.random() - 0.5) * spread;
    particleVel[i * 3 + 1] = Math.random() * up + 1;
    particleVel[i * 3 + 2] = (Math.random() - 0.5) * spread;
    particleLife[i] = 0.5 + Math.random() * 0.5;
  }
  particleGeo.attributes.position.needsUpdate = true;
}
function updateParticles(dt) {
  for (let i = 0; i < PARTICLE_N; i++) {
    if (particleLife[i] <= 0) continue;
    particleLife[i] -= dt;
    if (particleLife[i] <= 0) {
      particlePos[i * 3 + 1] = -999;
      continue;
    }
    particleVel[i * 3 + 1] -= 9 * dt;
    particlePos[i * 3] += particleVel[i * 3] * dt;
    particlePos[i * 3 + 1] += particleVel[i * 3 + 1] * dt;
    particlePos[i * 3 + 2] += particleVel[i * 3 + 2] * dt;
  }
  particleGeo.attributes.position.needsUpdate = true;
}

// ---------------------------------------------------------------- feel
function addTrauma(amount) {
  state.trauma = Math.min(1, state.trauma + amount * (state.shakePct / 100));
}
function hitStop(dur) {
  state.hitStopT = Math.max(state.hitStopT, dur);
}
const DENIED_COPY = {
  'queue-full': 'Turn queue full — one turn at a time',
  'boost-empty': 'Boost empty — grab a boost cell',
};
function feedback(event, energy = 0) {
  const fb = FEEDBACK[event];
  if (!fb) return;
  addTrauma(fb.trauma);
  if (fb.hitStop) hitStop(fb.hitStop);
  if (fb.flash && state.flash) flashScreen(fb.flash);
  playSfx(fb.sfx, energy);
}
function flashScreen(strength) {
  const el = $('hit-flash');
  el.style.opacity = String(strength);
  setTimeout(() => { el.style.opacity = '0'; }, 90);
}
function scorePop(text, x, y) {
  const pops = $('pops');
  const el = document.createElement('div');
  el.className = 'pop';
  el.textContent = text;
  el.style.left = x + 'px';
  el.style.top = y + 'px';
  pops.appendChild(el);
  setTimeout(() => el.remove(), 900);
}
function toast(msg, seconds = 2.5) {
  const el = $('hud-toast');
  el.textContent = msg;
  el.style.opacity = '';
  el.classList.add('show');
  el.setAttribute('aria-hidden', 'false');
  state.toastT = seconds;
  $('sr-status').textContent = msg;
}
function hideToast() {
  const el = $('hud-toast');
  el.classList.remove('show');
  el.setAttribute('aria-hidden', 'true');
  // Hide instantly (no 200ms CSS fade): a toast fading over the menu
  // after quit is a real bug, not a timing caveat (Talon lesson).
  el.style.transition = 'none';
  el.style.opacity = '0';
  requestAnimationFrame(() => { el.style.transition = ''; });
  state.toastT = 0;
}

// ---------------------------------------------------------------- input
// Turns and boost are EDGES: one key press queues one turn / flips
// the boost switch once. The frame loop passes the pending edge to
// the first sim step of the frame, then clears it — passing it to
// every step would queue the same turn twice.
let turnEdge = 0;
let boostEdge = false;
// Turns/boost may be queued while PAUSED: the frame loop only
// consumes edges while playing, so a press during pause survives
// until the first sim step after resume. (Live playtest NO-GO fix
// 2026-11-25: queueTurn silently dropped presses while paused —
// the tester paused to plan, pressed a turn, resumed, and rode
// straight into the wall. Single presses while playing always
// worked; the pause was the hole.)
function queueTurn(dir) {
  if (state.phase !== 'playing' && state.phase !== 'paused') return;
  turnEdge = dir;
}
function queueBoostToggle() {
  if (state.phase !== 'playing' && state.phase !== 'paused') return;
  boostEdge = true;
}
window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  ensureAudio();
  switch (e.code) {
    case 'ArrowLeft':
    case 'KeyA': queueTurn(-1); e.preventDefault(); break;
    case 'ArrowRight':
    case 'KeyD': queueTurn(1); e.preventDefault(); break;
    case 'Space': queueBoostToggle(); e.preventDefault(); break;
    case 'KeyP': togglePause(); break;
    case 'KeyM': toggleMute(); break;
    case 'KeyR': if (state.phase === 'playing') restartArena(); break;
    case 'Escape': closeTopScreen(); break;
    case 'Enter': confirmFocused(); break;
    default: break;
  }
});
window.addEventListener('blur', () => {
  turnEdge = 0;
  boostEdge = false;
});
function bindTouchButton(id, down) {
  const el = $(id);
  if (!el) return;
  el.addEventListener('pointerdown', (e) => { e.preventDefault(); ensureAudio(); down(); });
}
bindTouchButton('btn-turn-left', () => queueTurn(-1));
bindTouchButton('btn-turn-right', () => queueTurn(1));
bindTouchButton('btn-boost', () => queueBoostToggle());

// ---------------------------------------------------------------- screens
function showOnly(id) {
  for (const el of document.querySelectorAll('.overlay')) el.classList.add('hidden');
  if (id) {
    const el = $(id);
    el.classList.remove('hidden');
    const focusable = el.querySelector('button:not([disabled]), input, select');
    if (focusable) focusable.focus();
  }
}
function pushScreen(id) {
  screenStack.push(id);
  showOnly(id);
}
function popScreen() {
  screenStack.pop();
  showOnly(screenStack.length ? screenStack[screenStack.length - 1] : null);
}
function closeTopScreen() {
  if (state.phase === 'playing') { togglePause(); return; }
  if (screenStack.length > 1) popScreen();
}
function confirmFocused() {
  const el = document.activeElement;
  if (el && el.tagName === 'BUTTON') el.click();
}
function hoverFeedback(el) {
  el.addEventListener('mouseenter', () => { playSfx('tick'); });
}
document.querySelectorAll('button').forEach((b) => hoverFeedback(b));

function fmtTime(t) {
  const m = Math.floor(t / 60);
  const s = (t % 60).toFixed(1).padStart(4, '0');
  return `${m}:${s}`;
}

function buildArenaCards() {
  const wrap = $('arena-select');
  wrap.innerHTML = '';
  for (const a of ARENAS) {
    const best = save.best[a.id];
    const locked = !isArenaUnlocked(save, a.id);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'track-card' + (a.id === state.arenaId ? ' selected' : '');
    btn.disabled = locked;
    btn.innerHTML = `<span class="tc-name">${a.id}. ${a.name}</span>`
      + `<span class="tc-meta">${a.cols}×${a.rows} · ${a.rivals.length} rival${a.rivals.length > 1 ? 's' : ''} · par ${a.par}s</span>`
      + (best ? `<span class="tc-best">Best ${best.score}</span>${best.rank ? ` <span class="tc-rank rank-${best.rank}">${best.rank}</span>` : ''}` : '<span class="tc-best">Not ridden yet</span>')
      + (locked ? '<span class="tc-meta">Locked</span>' : '');
    btn.addEventListener('click', () => {
      ensureAudio();
      state.arenaId = a.id;
      buildArenaCards();
      updateMenuText();
    });
    wrap.appendChild(btn);
  }
}
function updateMenuText() {
  const a = arenaById(state.arenaId);
  const best = save.best[a.id];
  $('menu-best').textContent = best
    ? `Best on ${a.name}: ${best.score} pts in ${fmtTime(best.time)}`
    : `Arena ${a.id} of ${ARENAS.length} — ${a.name}, ${a.cols}×${a.rows}.`;
  $('menu-hint').textContent = a.hint;
  $('arena-hint').textContent = save.unlocked >= ARENAS.length
    ? 'All arenas unlocked — pick any arena to ride.'
    : (a.id >= ARENAS.length
      ? 'Final arena — you have unlocked them all.'
      : `Clear ${a.name} to unlock arena ${a.id + 1}.`);
}
function updateMuteButtons() {
  const label = state.muted ? 'Sound: Off' : 'Sound: On';
  for (const id of ['btn-mute-hud', 'btn-mute-menu', 'btn-mute-pause']) {
    const el = $(id);
    if (el) el.textContent = label;
  }
}
function toggleMute() {
  state.muted = !state.muted;
  save.settings.muted = state.muted;
  persistSave();
  if (masterGain) masterGain.gain.value = state.muted ? 0 : state.volume;
  updateMuteButtons();
}
function showMenu() {
  state.phase = 'menu';
  state.run = null;
  state.autopilot = false;
  state.demoRun = createRun(ARENAS[0]);
  buildArenaScene(ARENAS[0]);
  resetTrails(state.demoRun);
  screenStack.length = 0;
  screenStack.push('menu');
  showOnly('menu');
  $('hud').classList.add('hidden');
  $('touch-controls').classList.add('hidden');
  hideToast();
  buildArenaCards();
  updateMenuText();
  updateMuteButtons();
  stopMusic();
}

// ---------------------------------------------------------------- run flow
function startArena(id, unlockedOverride = false) {
  const arena = arenaById(id);
  if (!arena) return;
  if (!unlockedOverride && !isArenaUnlocked(save, id)) {
    toast('That arena is locked — clear the previous arena first.');
    playSfx('denied');
    return;
  }
  if (state.endTimer) { clearTimeout(state.endTimer); state.endTimer = null; }
  state.arenaId = id;
  buildArenaScene(arena);
  state.run = startRun(id);
  resetTrails(state.run);
  state.phase = 'playing';
  state.autopilot = false;
  state.trauma = 0;
  state.hitStopT = 0;
  state.slowMoT = 0;
  state.timeScale = 1;
  state.turnCount = 0;
  state.lastTrapAnnounced = null;
  state.lastDenied = null;
  turnEdge = 0;
  boostEdge = false;
  screenStack.length = 0;
  showOnly(null);
  $('hud').classList.remove('hidden');
  if (isTouch()) $('touch-controls').classList.remove('hidden');
  hideToast();
  const best = save.best[id];
  $('hud-best').textContent = best ? `Best ${best.score}` : 'Best —';
  $('hud-arena').textContent = `Arena ${id} — ${arena.name}`;
  toast(`${arena.name} — ${arena.hint}`, 3.5);
  ensureAudio();
  startMusic();
  updateMuteButtons();
  // Snap the camera behind the rider (no long swoop from the menu).
  // Lower and closer than v0.1.0's first pass (8 high, look 6 ahead):
  // the grid filled only the bottom 60% and the rider sat behind the
  // touch BOOST button. Look 3 ahead puts the rider at ~65% down and
  // the far wall at ~11% from the top.
  const w = simToWorld(state.run.player.x, state.run.player.y);
  camFwd.set(state.run.player.dir.x, 0, -state.run.player.dir.y);
  camera.position.set(w.x - camFwd.x * 9, 6.5, w.z - camFwd.z * 9);
  camera.lookAt(w.x + camFwd.x * 3, 0.5, w.z + camFwd.z * 3);
}
function restartArena() {
  startArena(state.arenaId, true);
}
function endRun(won) {
  if (!state.run) return;
  const run = state.run;
  const arena = run.arena;
  const result = {
    won,
    score: run.score,
    time: run.time,
    traps: run.traps,
    pickups: run.pickups,
    par: arena.par,
  };
  recordBest(save, arena.id, result);
  persistSave();
  state.phase = won ? 'complete' : 'gameover';
  $('hud').classList.add('hidden');
  $('touch-controls').classList.add('hidden');
  hideToast();
  if (won) {
    state.slowMoT = 0.7;
    feedback('win');
    $('complete-score').textContent = `Score ${run.score}`;
    $('complete-detail').textContent = `${arena.name} cleared in ${fmtTime(run.time)} · ${run.traps} trap${run.traps === 1 ? '' : 's'} · ${run.pickups} boost cells`;
    const best = save.best[arena.id];
    $('complete-best').textContent = best ? `Best: ${best.score} pts` : '';
    $('complete-rank').textContent = best && best.rank ? `Rank: ${best.rank}` : '';
    $('complete-traps').textContent = `Rivals trapped: ${run.traps}/${run.rivals.length}`;
    pushScreen('complete');
  } else {
    feedback('crash');
    const cause = run.crashReason === 'wall' ? 'rode into the arena edge'
      : run.crashReason === 'pillar' ? 'rode into a pillar'
      : run.crashTarget ? `rode into ${run.crashTarget === 'YOU' ? 'your own trail' : run.crashTarget + "'s trail"}`
      : 'crashed';
    $('gameover-detail').textContent = `You ${cause} on ${arena.name} after ${fmtTime(run.time)} — ${run.traps} rival${run.traps === 1 ? '' : 's'} trapped.`;
    const best = save.best[arena.id];
    $('gameover-best').textContent = best ? `Best: ${best.score} pts` : '';
    pushScreen('gameover');
  }
  stopMusic();
}
function quitToMenu() {
  if (state.endTimer) { clearTimeout(state.endTimer); state.endTimer = null; }
  turnEdge = 0;
  boostEdge = false;
  showMenu();
}
function pauseGame() {
  if (state.phase !== 'playing') return;
  state.phase = 'paused';
  pushScreen('pause');
}
function resumeGame() {
  if (state.phase !== 'paused') return;
  popScreen();
  state.phase = 'playing';
}
function togglePause() {
  if (state.phase === 'playing') pauseGame();
  else if (state.phase === 'paused') resumeGame();
}

// Menu buttons.
$('btn-play').addEventListener('click', () => { ensureAudio(); startArena(state.arenaId); });
$('btn-howto').addEventListener('click', () => pushScreen('howto'));
$('btn-howto-close').addEventListener('click', () => popScreen());
$('btn-settings').addEventListener('click', () => pushScreen('settings'));
$('btn-settings-close').addEventListener('click', () => popScreen());
$('btn-mute-menu').addEventListener('click', toggleMute);
$('btn-mute-hud').addEventListener('click', toggleMute);
$('btn-mute-pause').addEventListener('click', toggleMute);
$('btn-pause').addEventListener('click', () => togglePause());
$('btn-resume').addEventListener('click', () => resumeGame());
$('btn-restart').addEventListener('click', () => { popScreen(); restartArena(); });
$('btn-quit').addEventListener('click', () => quitToMenu());
$('btn-next').addEventListener('click', () => {
  const nextId = Math.min(state.arenaId + 1, ARENAS.length);
  startArena(nextId, true);
});
$('btn-replay').addEventListener('click', () => restartArena());
$('btn-menu-complete').addEventListener('click', () => quitToMenu());
$('btn-retry').addEventListener('click', () => restartArena());
$('btn-menu-over').addEventListener('click', () => quitToMenu());

// Settings controls.
$('volume-range').addEventListener('input', (e) => {
  state.volume = Number(e.target.value) / 100;
  $('volume-value').textContent = `${e.target.value}%`;
  if (masterGain) masterGain.gain.value = state.muted ? 0 : state.volume;
});
$('shake-range').addEventListener('input', (e) => {
  state.shakePct = Number(e.target.value);
  $('shake-value').textContent = `${e.target.value}%`;
  save.settings.shake = state.shakePct;
  persistSave();
});
$('shake-range-pause').addEventListener('input', (e) => {
  state.shakePct = Number(e.target.value);
  $('shake-value-pause').textContent = `${e.target.value}%`;
  $('shake-value').textContent = `${e.target.value}%`;
  $('shake-range').value = e.target.value;
  save.settings.shake = state.shakePct;
  persistSave();
});
$('music-toggle').addEventListener('change', (e) => { state.musicOn = e.target.checked; });
$('sfx-toggle').addEventListener('change', (e) => { state.sfxOn = e.target.checked; });
$('reduce-flashing').addEventListener('change', (e) => {
  state.flash = !e.target.checked;
  save.settings.flash = state.flash;
  persistSave();
});
$('text-size-select').addEventListener('change', (e) => {
  state.textScale = Number(e.target.value);
  document.documentElement.style.fontSize = `${16 * state.textScale}px`;
});
$('high-contrast-toggle').addEventListener('change', (e) => {
  state.highContrast = e.target.checked;
  document.body.classList.toggle('high-contrast', state.highContrast);
});
// Restore saved settings into the controls.
$('shake-range').value = String(state.shakePct);
$('shake-value').textContent = `${state.shakePct}%`;
$('shake-range-pause').value = String(state.shakePct);
$('shake-value-pause').textContent = `${state.shakePct}%`;
if (!state.flash) $('reduce-flashing').checked = true;

// ---------------------------------------------------------------- camera + render
function worldToScreen(x, y, z) {
  const v = new THREE.Vector3(x, y, z).project(camera);
  return { x: (v.x * 0.5 + 0.5) * window.innerWidth, y: (-v.y * 0.5 + 0.5) * window.innerHeight, behind: v.z > 1 };
}

function placeCycle(cycle, rider, dt) {
  const w = simToWorld(rider.x, rider.y);
  cycle.group.position.set(w.x, 0, w.z);
  const targetAngle = Math.atan2(rider.dir.y, rider.dir.x);
  // Shortest-path angle lerp so the cycle swings the right way.
  let diff = targetAngle - cycle.visAngle;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  cycle.visAngle += diff * (1 - Math.exp(-14 * dt));
  cycle.group.rotation.y = cycle.visAngle;
  cycle.group.visible = rider.alive;
}

let lastT = performance.now();
let simAcc = 0;
let elapsed = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const rawDt = Math.min(0.05, (now - lastT) / 1000);
  lastT = now;
  elapsed += rawDt;

  // FPS guard: rolling average; under 28fps for 2s steps the render
  // scale down one rung (DPR 2 -> 1.5 -> 1) and thins particles.
  fpsEma = fpsEma * 0.95 + (rawDt > 0 ? 1 / rawDt : 60) * 0.05;
  if (fpsEma < 28) {
    fpsLowT += rawDt;
    if (fpsLowT > 2) { stepFpsGuard(); fpsLowT = 0; }
  } else {
    fpsLowT = 0;
  }

  // Hit-stop freezes the sim in real time; slow-mo stretches it.
  if (state.hitStopT > 0) {
    state.hitStopT -= rawDt;
    state.timeScale = 0;
  } else if (state.slowMoT > 0) {
    state.slowMoT -= rawDt;
    state.timeScale = 0.35;
  } else {
    state.timeScale = 1;
  }
  state.trauma = Math.max(0, state.trauma - rawDt * 1.6);

  const activeRun = state.phase === 'menu' ? state.demoRun : state.run;
  const dt = rawDt * state.timeScale;

  if (activeRun && (state.phase === 'playing' || state.phase === 'menu')) {
    simAcc += dt;
    let guard = 0;
    while (simAcc >= DT && guard < 5) {
      simAcc -= DT;
      guard++;
      const inp = state.phase === 'menu'
        ? decisionPolicy(activeRun)
        : state.autopilot ? decisionPolicy(activeRun) : { turn: turnEdge, toggleBoost: boostEdge };
      // Edges are consumed by the first step of the frame.
      turnEdge = 0;
      boostEdge = false;
      const before = {
        dir: activeRun.player.alive ? { ...activeRun.player.dir } : null,
        boostOn: activeRun.player.boostOn,
        traps: activeRun.traps,
        pickups: activeRun.pickups,
        phase: activeRun.phase,
      };
      stepRun(activeRun, inp);
      if (state.phase === 'playing') {
        // Turn feedback: the rider's heading changed this step.
        if (before.dir && activeRun.player.alive
          && (activeRun.player.dir.x !== before.dir.x || activeRun.player.dir.y !== before.dir.y)) {
          state.turnCount++;
          feedback('turn', playerSpeed(activeRun) / 12);
          const w = simToWorld(activeRun.player.x, activeRun.player.y);
          spawnParticles(w.x, 0.5, w.z, FEEDBACK.turn.particles, 2, 2);
        }
        // Boost toggle feedback.
        if (activeRun.player.boostOn && !before.boostOn) {
          feedback('boost');
          const w = simToWorld(activeRun.player.x, activeRun.player.y);
          spawnParticles(w.x, 0.5, w.z, FEEDBACK.boost.particles, 3, 3);
        }
        if (activeRun.player.boostOn) {
          const w = simToWorld(activeRun.player.x, activeRun.player.y);
          if (Math.random() < 0.5) spawnParticles(w.x, 0.3, w.z, 1, 1.5, 1.5);
        }
        // Trap feedback: names the rival and the banked score.
        if (activeRun.lastTrap && activeRun.lastTrap !== state.lastTrapAnnounced) {
          state.lastTrapAnnounced = activeRun.lastTrap;
          feedback('trap');
          const w = simToWorld(activeRun.player.x, activeRun.player.y);
          spawnParticles(w.x, 1, w.z, FEEDBACK.trap.particles, 6, 5);
          const s = worldToScreen(w.x, 2, w.z);
          const t = activeRun.lastTrap;
          const label = t.cause === 'player-trail'
            ? `TRAPPED ${t.name} +${t.score}`
            : `${t.name} wiped out +${t.score}`;
          toast(label);
          scorePop(`+${t.score}`, s.x, s.y);
          if (activeRun.combo > 1) scorePop(`COMBO x${activeRun.combo}`, s.x, s.y - 24);
        }
        if (activeRun.pickups > before.pickups) {
          feedback('pickup');
          const w = simToWorld(activeRun.player.x, activeRun.player.y);
          spawnParticles(w.x, 1, w.z, FEEDBACK.pickup.particles, 2, 3);
        }
        // A failed input names its reason (post-action only). The
        // toast is throttled so a queue-full spam cannot strobe it.
        if (activeRun.deniedReason) {
          state.lastDenied = activeRun.deniedReason;
          feedback('denied');
          const nowMs = performance.now();
          if (nowMs - state.lastDeniedToast > 1200) {
            state.lastDeniedToast = nowMs;
            toast(DENIED_COPY[activeRun.deniedReason] || activeRun.deniedReason);
          }
        }
        if (activeRun.phase !== before.phase) {
          if (activeRun.phase === 'won' || activeRun.phase === 'lost') {
            if (activeRun.phase === 'lost') {
              const w = simToWorld(activeRun.player.x, activeRun.player.y);
              spawnParticles(w.x, 1, w.z, FEEDBACK.crash.particles, 6, 5);
            }
            if (!state.endTimer) {
              state.endTimer = setTimeout(() => {
                state.endTimer = null;
                endRun(activeRun.phase === 'won');
              }, activeRun.phase === 'won' ? 700 : 900);
            }
          }
        }
      }
      // Menu demo: reset the demo run when it wins or loses so the
      // attract scene never stops moving.
      if (state.phase === 'menu' && activeRun.phase !== 'riding') {
        state.demoRun = createRun(ARENAS[0]);
        resetTrails(state.demoRun);
      }
    }
    if (guard >= 5) simAcc = 0;
  }

  // HUD.
  if (state.phase === 'playing' && state.run) {
    const run = state.run;
    $('hud-time').textContent = fmtTime(run.time);
    $('hud-score').textContent = `Score ${Math.floor(run.score)}`;
    $('hud-traps').textContent = `Traps ${run.traps}/${run.rivals.length}`;
    const fill = $('hud-boost-fill');
    fill.style.width = `${Math.round(run.player.boost)}%`;
    fill.classList.toggle('low', run.player.boost < 25);
    const boostState = $('hud-boost-state');
    boostState.textContent = run.player.boostOn ? 'ON' : 'OFF';
    boostState.classList.toggle('on', run.player.boostOn);
    const boostBtn = $('btn-boost');
    if (boostBtn) boostBtn.classList.toggle('on', run.player.boostOn);
    if (state.toastT > 0) {
      state.toastT -= rawDt;
      if (state.toastT <= 0) hideToast();
    }
  }
  // Settings performance readout.
  if (!$('settings').classList.contains('hidden')) {
    $('perf-line').textContent = `Performance: ${Math.round(fpsEma)} fps · render scale ${renderer.getPixelRatio().toFixed(1)}×`;
  }

  // Scene: trails + cycles + boost cells + camera.
  if (renderer && currentArena) {
    const run = activeRun;
    const t = elapsed;
    for (let i = 0; i < boostCellMeshes.length; i++) {
      const mesh = boostCellMeshes[i];
      const cell = run ? run.boostCells[i] : currentArena.boostCells[i];
      if (run && cell) {
        const w = simToWorld(cell.x + 0.5, cell.y + 0.5);
        mesh.position.set(w.x, 1.0 + Math.sin(t * 2 + i) * 0.2, w.z);
        mesh.visible = !cell.taken;
      } else {
        mesh.visible = true;
      }
      mesh.rotation.y = t * 1.5 + i;
    }
    if (run) {
      // Trails.
      if (playerTrail) playerTrail.sync(run.player);
      for (const rival of run.rivals) {
        const tr = rivalTrails[rival.name];
        if (tr) tr.sync(rival);
      }
      // Cycles.
      placeCycle(playerCycle, run.player, rawDt);
      for (const rival of run.rivals) {
        let cyc = rivalCycles[rival.name];
        if (!cyc) {
          cyc = makeCycle(rival.color);
          rivalCycles[rival.name] = cyc;
        }
        placeCycle(cyc, rival, rawDt);
      }
      for (const [name, cyc] of Object.entries(rivalCycles)) {
        if (!run.rivals.some((r) => r.name === name)) cyc.group.visible = false;
      }
      const w = simToWorld(run.player.x, run.player.y);
      pocketLight.position.set(w.x, 3, w.z);
      // Camera: chase behind and above, looking down the rider's line.
      const fwd = new THREE.Vector3(run.player.dir.x, 0, -run.player.dir.y);
      camFwd.lerp(fwd, 1 - Math.exp(-8 * rawDt));
      camFwd.normalize();
      const shake = state.trauma * state.trauma * (state.shakePct / 100);
      const shX = (Math.random() - 0.5) * shake * 1.2;
      const shY = (Math.random() - 0.5) * shake * 1.2;
      const targetPos = new THREE.Vector3(
        w.x - camFwd.x * 9 + shX,
        6.5 + shY,
        w.z - camFwd.z * 9,
      );
      camera.position.lerp(targetPos, 1 - Math.exp(-6 * rawDt));
      camera.lookAt(w.x + camFwd.x * 3, 0.5, w.z + camFwd.z * 3);
      const targetFov = FOV_BASE + state.fovPunch * 6 - state.fovDip * 4;
      state.fovPunch = Math.max(0, state.fovPunch - rawDt * 2);
      state.fovDip = Math.max(0, state.fovDip - rawDt * 2);
      if (Math.abs(camera.fov - targetFov) > 0.05) {
        camera.fov = targetFov;
        camera.updateProjectionMatrix();
      }
    }
    updateParticles(rawDt);
    scheduleMusic();
    renderer.render(scene, camera);
  }
}
function stepFpsGuard() {
  if (dprCap > 1.5) dprCap = 1.5;
  else if (dprCap > 1) dprCap = 1;
  else return dprCap;
  particleScale = dprCap === 1.5 ? 0.6 : 0.35;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, dprCap));
  renderer.setSize(window.innerWidth, window.innerHeight);
  return dprCap;
}

window.addEventListener('resize', () => {
  if (!renderer) return;
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, dprCap));
  renderer.setSize(window.innerWidth, window.innerHeight);
});
window.addEventListener('webglcontextlost', (e) => {
  e.preventDefault();
  if (state.phase === 'playing') pauseGame();
});
window.addEventListener('webglcontextrestored', () => { /* renderer recovers on next frame */ });

// ---------------------------------------------------------------- test hooks
function info() {
  const run = state.phase === 'menu' ? state.demoRun : state.run;
  const arena = run ? run.arena : currentArena;
  return {
    phase: state.phase,
    version: VERSION,
    arenaId: state.arenaId,
    x: run ? +run.player.x.toFixed(2) : null,
    y: run ? +run.player.y.toFixed(2) : null,
    dir: run ? { ...run.player.dir } : null,
    speed: run ? +playerSpeed(run).toFixed(2) : null,
    boost: run ? Math.round(run.player.boost) : 0,
    boostOn: run ? run.player.boostOn : false,
    traps: run ? run.traps : 0,
    rivalsAlive: run ? run.rivals.filter((r) => r.alive).length : 0,
    rivalsTotal: run ? run.rivals.length : 0,
    turns: state.turnCount,
    lastDenied: state.lastDenied,
    lastTrap: state.lastTrapAnnounced,
    runPhase: run ? run.phase : null,
    crashReason: run ? run.crashReason : null,
    crashTarget: run ? run.crashTarget : null,
    screen: run ? (() => { const w = simToWorld(run.player.x, run.player.y); return worldToScreen(w.x, 1, w.z); })() : null,
    centreScreen: arena ? worldToScreen(0, 1, 0) : null,
    score: run ? run.score : 0,
    time: run ? +run.time.toFixed(2) : 0,
    trauma: +state.trauma.toFixed(3),
    timeScale: state.timeScale,
    fov: +camera.fov.toFixed(1),
    autopilot: state.autopilot,
    unlocked: save.unlocked,
    endTimerPending: state.endTimer !== null,
    fps: Math.round(fpsEma),
    fpsGuard: {
      dprCap,
      pixelRatio: renderer ? +renderer.getPixelRatio().toFixed(2) : 0,
      particleScale,
    },
  };
}
window.__cycle = {
  version: VERSION,
  get run() { return state.run; },
  get demoRun() { return state.demoRun; },
  get phase() { return state.phase; },
  get state() { return state; },
  get save() { return save; },
  arenas: ARENAS,
  info,
  startArena: (id) => startArena(id, true),
  autopilot(on) { state.autopilot = !!on; },
  pause: pauseGame,
  resume: resumeGame,
  quitToMenu,
  setMuted(m) { if (!!m !== state.muted) toggleMute(); },
  triggerFpsGuard() { stepFpsGuard(); return dprCap; },
  get dprCap() { return dprCap; },
  setShake(p) { state.shakePct = p; },
  setFlash(b) { state.flash = !!b; },
  turn(dir) { queueTurn(dir); },
  toggleBoost() { queueBoostToggle(); },
  worldToScreen,
  feel: FEEDBACK,
};

// ---------------------------------------------------------------- boot
if (!webglOK || !renderer) {
  $('webgl-error').classList.remove('hidden');
} else {
  buildArenaScene(ARENAS[0]);
  resetTrails(state.demoRun);
  showMenu();
  const arenaParam = Number(params.get('arena'));
  if (arenaParam >= 1 && arenaParam <= ARENAS.length) {
    startArena(arenaParam, true);
  }
  requestAnimationFrame(frame);
}
