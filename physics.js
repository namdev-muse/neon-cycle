// Neon Cycle v0.1.0 — pure simulation core (no DOM, no Three.js).
// A 3D neon light-cycle arena: the rider's cycle leaves a solid neon
// trail on a grid arena. Turns are DISCRETE 90 deg (A/D or arrows,
// queued so a fast double-tap works). Boost is a TOGGLE on Space
// (press to switch on/off, drains a meter, refills from boost cells)
// — NEVER a hold. That is deliberate: the live-browser playtest
// tooling can only tap keys (the Tide sprint's launch was never
// human-verified for exactly this reason), and a discrete-turn +
// toggle core is a core the tooling can genuinely play.
// Rival riders carve their own trails. Trap a rival by cutting it
// off (force it into any trail or the wall) to bank its score;
// crash into any trail or the arena edge and the run ends. Score
// from survival time + traps + boost cells + combo; best saved per
// arena; unlock chain. 3 dense hand-crafted arenas in M1.
//
// Coordinates: sim (x, y) in cell units, x east, y north; a cell is
// (col, row) = (floor(x), floor(y)), its centre at (col+0.5,
// row+0.5). Riders travel along lines through cell centres; a queued
// turn executes exactly when the rider crosses the next cell centre,
// so trails always sit on grid lines and a double-tap queues two
// turns for two successive centres. Trails are permanent walls: the
// set of cells a rider has occupied. A rider crashes when it enters
// a cell that is out of bounds, a pillar, or in any rider's trail
// (including its own).
//
// Deterministic: every arena is hand-built from fixed numbers, the
// rival decisions draw from a run-seeded RNG, and the fixed-step
// simulation gives identical results for identical inputs.

export const VERSION = '0.1.0';
export const DT = 1 / 60;
export const TURN_QUEUE_MAX = 2;
export const BOOST_DRAIN = 30; // meter per second while boosting
export const BOOST_REFILL = 6; // meter per second while not boosting
export const BOOST_CELL_REFILL = 40;
export const BOOST_CELL_SCORE = 50;
export const BOOST_CELL_RESPAWN = 10; // seconds after collection
export const BOOST_MULT = 1.55;
export const SURVIVAL_SCORE = 10; // per second alive
export const TRAP_BASE = 500;
export const TRAP_BONUS_PLAYER_TRAIL = 200; // a real cut-off pays more than a rival blunder
export const TRAP_COMBO_STEP = 100;
export const COMBO_WINDOW = 10; // seconds between traps to keep the combo
export const WIN_BONUS = 1000;
export const WIN_TIME_BONUS = 20; // per second under par
export const MAX_SECONDS = 400; // bot harness cap; a run that long without a result is a failure

// ---------------------------------------------------------------- helpers
export function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function key(c, r) { return c + ',' + r; }

// Directions: 'E' | 'N' | 'W' | 'S' in sim space (x east, y north).
// A LEFT turn is a 90 deg counter-clockwise rotation in that plane:
// (dx, dy) -> (-dy, dx). World mapping (game.js) is sim +x -> world
// +x, sim +y -> world -z, so a left turn is left on screen too —
// turning left moves the rider left on screen (Drift M2 lesson).
export const DIRS = {
  E: { x: 1, y: 0 },
  N: { x: 0, y: 1 },
  W: { x: -1, y: 0 },
  S: { x: 0, y: -1 },
};
export function rotateDir(dir, turn) {
  // turn: -1 = left, +1 = right. A 180 deg reversal is never produced
  // by one turn; two same-direction turns in the queue do reverse the
  // rider — and ride it into its own trail, which is a real mistake.
  if (turn === -1) return { x: -dir.y, y: dir.x };
  if (turn === 1) return { x: dir.y, y: -dir.x };
  return { x: dir.x, y: dir.y };
}

// ---------------------------------------------------------------- arenas
// An arena is a grid of cells with pillar rects, boost cells, a
// player start and rival starts. Rival speed is in cells/second;
// mistake is the per-decision probability of picking the worse side
// (or turning at random on an open road); look is how many clear
// cells ahead a rival needs before it stops worrying.
export const ARENAS = [
  {
    id: 1,
    name: 'First Grid',
    hint: 'Open grid, one slow rival. Learn the turn, then cut it off.',
    accent: '#22e6ff',
    accentName: 'cyan',
    par: 75,
    cols: 24,
    rows: 16,
    pillars: [],
    boostCells: [
      { x: 12, y: 8 }, { x: 18, y: 12 }, { x: 10, y: 3 },
      { x: 20, y: 8 }, { x: 14, y: 13 }, { x: 6, y: 12 },
    ],
    playerStart: { x: 6.5, y: 8.5, dir: 'E' },
    rivals: [
      { name: 'VEX', color: '#ff3df0', start: { x: 17.5, y: 4.5, dir: 'W' }, speed: 5.0, mistake: 0.20, look: 5 },
    ],
    baseSpeed: 6.0,
    ramp: 0.015,
  },
  {
    id: 2,
    name: 'Crossroads',
    hint: 'A pillar block in the middle and two rivals — own the crossroads.',
    accent: '#ff3df0',
    accentName: 'magenta',
    par: 90,
    cols: 26,
    rows: 18,
    pillars: [
      { x: 12, y: 8, w: 2, h: 2 },
      { x: 5, y: 4, w: 1, h: 1 },
      { x: 20, y: 4, w: 1, h: 1 },
      { x: 5, y: 13, w: 1, h: 1 },
      { x: 20, y: 13, w: 1, h: 1 },
    ],
    boostCells: [
      { x: 8, y: 9 }, { x: 17, y: 5 }, { x: 13, y: 2 }, { x: 13, y: 15 },
      { x: 22, y: 9 }, { x: 4, y: 6 }, { x: 21, y: 12 }, { x: 10, y: 14 },
    ],
    playerStart: { x: 4.5, y: 15.5, dir: 'E' },
    rivals: [
      { name: 'VEX', color: '#ff3df0', start: { x: 21.5, y: 3.5, dir: 'W' }, speed: 5.2, mistake: 0.16, look: 5 },
      { name: 'NOVA', color: '#ff8a3d', start: { x: 21.5, y: 14.5, dir: 'W' }, speed: 5.4, mistake: 0.14, look: 6 },
    ],
    baseSpeed: 6.5,
    ramp: 0.02,
  },
  {
    id: 3,
    name: 'The Gauntlet',
    hint: 'Pillar lanes and three rivals. Every turn is a decision now.',
    accent: '#b26bff',
    accentName: 'violet',
    par: 105,
    cols: 28,
    rows: 18,
    pillars: [
      { x: 9, y: 3, w: 1, h: 4 },
      { x: 9, y: 11, w: 1, h: 4 },
      { x: 18, y: 3, w: 1, h: 4 },
      { x: 18, y: 11, w: 1, h: 4 },
      { x: 13, y: 8, w: 2, h: 2 },
    ],
    boostCells: [
      { x: 5, y: 5 }, { x: 22, y: 5 }, { x: 5, y: 12 }, { x: 22, y: 12 },
      { x: 11, y: 2 }, { x: 16, y: 15 }, { x: 11, y: 15 }, { x: 16, y: 2 },
      { x: 24, y: 9 }, { x: 3, y: 9 },
    ],
    playerStart: { x: 4.5, y: 9.5, dir: 'E' },
    rivals: [
      { name: 'VEX', color: '#ff3df0', start: { x: 23.5, y: 4.5, dir: 'W' }, speed: 5.4, mistake: 0.14, look: 6 },
      { name: 'NOVA', color: '#ff8a3d', start: { x: 23.5, y: 14.5, dir: 'W' }, speed: 5.6, mistake: 0.12, look: 6 },
      { name: 'ORION', color: '#3d7bff', start: { x: 14.5, y: 16.5, dir: 'S' }, speed: 5.8, mistake: 0.10, look: 7 },
    ],
    baseSpeed: 7.0,
    ramp: 0.025,
  },
];

export function arenaById(id) {
  return ARENAS.find((a) => a.id === id) || null;
}

export function pillarAt(arena, c, r) {
  for (const p of arena.pillars) {
    if (c >= p.x && c < p.x + p.w && r >= p.y && r < p.y + p.h) return p;
  }
  return null;
}

export function arenaCellCount(arena) {
  let pillars = 0;
  for (const p of arena.pillars) pillars += p.w * p.h;
  return arena.cols * arena.rows - pillars;
}

export function arenaThreat(a) {
  // Rough difficulty measure: size + pillars + rivals + speed.
  return a.cols * a.rows + a.pillars.length * 20 + a.rivals.length * 60
    + a.rivals.reduce((s, r) => s + r.speed * 10, 0) + a.baseSpeed * 20;
}

// ---------------------------------------------------------------- geometry
// The next cell centre ahead of a rider along its current direction,
// and how far away it is. Centres sit at half-integers.
export function nextCentre(rider) {
  const { x, y, dir } = rider;
  if (dir.x !== 0) {
    const cx = dir.x > 0 ? Math.floor(x - 0.5) + 1.5 : Math.ceil(x - 0.5) - 0.5;
    return { x: cx, y, dist: Math.abs(cx - x) };
  }
  const cy = dir.y > 0 ? Math.floor(y - 0.5) + 1.5 : Math.ceil(y - 0.5) - 0.5;
  return { x, y: cy, dist: Math.abs(cy - y) };
}

// Is a cell blocked for movement (wall / pillar / any trail /
// extraBlocked)? The caller's own current cell is in its trail, so
// pass it as `freeCell` when the flood starts there.
export function isBlocked(run, c, r, extraBlocked, freeCell) {
  const arena = run.arena;
  if (c < 0 || c >= arena.cols || r < 0 || r >= arena.rows) return true;
  if (freeCell && c === freeCell.c && r === freeCell.r) return false;
  if (pillarAt(arena, c, r)) return true;
  if (extraBlocked && extraBlocked.has(key(c, r))) return true;
  const k = key(c, r);
  if (run.player.trail.has(k)) return true;
  for (const rival of run.rivals) {
    if (rival.trail.has(k)) return true;
  }
  return false;
}

// Flood-fill reachable free area (in cells) from a start cell.
// The start cell itself counts as free even if it sits in a trail
// (a rider's head cell is in its own trail); neighbours must be free.
export function floodArea(run, cell, extraBlocked) {
  const arena = run.arena;
  if (cell.c < 0 || cell.c >= arena.cols || cell.r < 0 || cell.r >= arena.rows) return 0;
  if (pillarAt(arena, cell.c, cell.r)) return 0;
  const seen = new Set([key(cell.c, cell.r)]);
  const queue = [cell];
  let count = 0;
  while (queue.length > 0) {
    const cur = queue.pop();
    count++;
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nc = cur.c + dc;
      const nr = cur.r + dr;
      const k = key(nc, nr);
      if (seen.has(k)) continue;
      if (isBlocked(run, nc, nr, extraBlocked)) continue;
      seen.add(k);
      queue.push({ c: nc, r: nr });
    }
  }
  return count;
}

// Free cells straight ahead of a rider along a direction (0..30).
export function clearanceAhead(run, rider, dir) {
  let c = Math.floor(rider.x);
  let r = Math.floor(rider.y);
  let n = 0;
  for (let i = 0; i < 30; i++) {
    c += dir.x;
    r += dir.y;
    if (isBlocked(run, c, r, null, { c: Math.floor(rider.x), r: Math.floor(rider.y) })) break;
    n++;
  }
  return n;
}

// Fraction of the arena's cells still free (no trail, no pillar).
export function freeFraction(run) {
  const arena = run.arena;
  let free = 0;
  for (let c = 0; c < arena.cols; c++) {
    for (let r = 0; r < arena.rows; r++) {
      if (!isBlocked(run, c, r)) free++;
    }
  }
  return free / arenaCellCount(arena);
}

// ---------------------------------------------------------------- run state
function makeRider(kind, def, start) {
  const dir = { ...DIRS[start.dir] };
  const rider = {
    kind,
    name: def.name || 'YOU',
    color: def.color || '#22e6ff',
    alive: true,
    x: start.x,
    y: start.y,
    dir,
    cellC: Math.floor(start.x),
    cellR: Math.floor(start.y),
    trail: new Set([key(Math.floor(start.x), Math.floor(start.y))]),
    turnQueue: [],
    speed: def.speed || 0,
    mistake: def.mistake || 0,
    look: def.look || 5,
    boostOn: false,
    boost: 100,
    crashReason: null,
    crashTarget: null,
    crashCause: null,
  };
  return rider;
}

export function createRun(arena, seed = 0) {
  const player = makeRider('player', { name: 'YOU', color: '#22e6ff' }, arena.playerStart);
  const rivals = arena.rivals.map((def) => makeRider('rival', def, def.start));
  return {
    arena,
    phase: 'riding', // 'riding' | 'won' | 'lost'
    time: 0,
    score: 0,
    traps: 0,
    combo: 0,
    comboT: -999,
    pickups: 0,
    player,
    rivals,
    boostCells: arena.boostCells.map((c) => ({ x: c.x, y: c.y, taken: false, respawnT: 0 })),
    rng: mulberry32(1000 + arena.id * 101 + seed),
    deniedReason: null, // why the last input failed ('queue-full' | 'boost-empty') — cleared every step, read by the game for the post-action cue
    lastTrap: null, // { name, score, cause } — the trap the game should announce
    crashReason: null, // why the player lost ('wall' | 'trail' | 'pillar')
    crashTarget: null, // whose trail the player rode into, if any
    winner: null,
  };
}

export function startRun(arenaId, seed = 0) {
  const arena = arenaById(arenaId);
  if (!arena) return null;
  return createRun(arena, seed);
}

export function playerSpeed(run) {
  const p = run.player;
  const base = run.arena.baseSpeed + run.arena.ramp * Math.min(run.time, 90);
  return base * (p.boostOn ? BOOST_MULT : 1);
}

function riderSpeed(run, rider) {
  if (rider.kind === 'player') return playerSpeed(run);
  return rider.speed;
}

function finishScore(run) {
  if (run.phase === 'won') {
    run.score += WIN_BONUS;
    run.score += Math.max(0, Math.round((run.arena.par - run.time) * WIN_TIME_BONUS));
  }
  run.score = Math.max(0, Math.round(run.score));
}

// A rival crashed. If the player is still alive the player banks it:
// a real cut-off (into the player's trail) pays a bonus over a rival
// blundering into a wall or its own trail. If every rival is gone,
// the player has cleared the arena.
function onRivalCrash(run, rival) {
  if (run.player.alive) {
    if (run.time - run.comboT <= COMBO_WINDOW) run.combo++;
    else run.combo = 1;
    run.comboT = run.time;
    const score = TRAP_BASE
      + (rival.crashCause === 'player-trail' ? TRAP_BONUS_PLAYER_TRAIL : 0)
      + (run.combo - 1) * TRAP_COMBO_STEP;
    run.score += score;
    run.traps++;
    run.lastTrap = { name: rival.name, score, cause: rival.crashCause };
    if (run.rivals.every((r) => !r.alive)) {
      run.phase = 'won';
      run.winner = 'player';
      finishScore(run);
    }
  }
}

function crashRider(run, rider, crash) {
  rider.alive = false;
  rider.crashReason = crash.reason;
  rider.crashTarget = crash.target || null;
  rider.crashCause = crash.cause || null;
  if (rider.kind === 'player') {
    run.phase = 'lost';
    run.crashReason = crash.reason;
    run.crashTarget = crash.target || null;
    finishScore(run);
    return;
  }
  onRivalCrash(run, rider);
}

// What happens if a rider enters cell (c, r)? null = free to enter;
// otherwise the crash that follows.
function checkCell(run, rider, c, r) {
  const arena = run.arena;
  if (c < 0 || c >= arena.cols || r < 0 || r >= arena.rows) return { reason: 'wall' };
  if (pillarAt(arena, c, r)) return { reason: 'pillar' };
  const k = key(c, r);
  if (rider.trail.has(k)) return { reason: 'trail', target: rider.name, cause: 'own-trail' };
  if (run.player !== rider && run.player.trail.has(k)) {
    return { reason: 'trail', target: 'YOU', cause: 'player-trail' };
  }
  for (const other of run.rivals) {
    if (other === rider) continue;
    if (other.trail.has(k)) return { reason: 'trail', target: other.name, cause: 'rival-trail' };
  }
  return null;
}

// One rider moves one fixed step. Rivals move before the player each
// step, so a rival that rides into the player's head cell dies
// first — that is a trap, not a loss.
function riderStep(run, rider, dt) {
  if (!rider.alive || run.phase !== 'riding') return;
  const speed = riderSpeed(run, rider);
  let remaining = speed * dt;
  let guard = 0;
  while (remaining > 1e-9 && guard < 4) {
    guard++;
    const centre = nextCentre(rider);
    if (centre.dist <= remaining + 1e-9) {
      // Reach the centre, then apply one queued turn (player) or the
      // rival's decision, and keep the leftover distance along the
      // new heading.
      rider.x = centre.x;
      rider.y = centre.y;
      remaining -= centre.dist;
      const turn = rider.kind === 'player'
        ? (rider.turnQueue.shift() || 0)
        : rivalDecide(run, rider);
      if (turn !== 0) rider.dir = rotateDir(rider.dir, turn);
    } else {
      rider.x += rider.dir.x * remaining;
      rider.y += rider.dir.y * remaining;
      remaining = 0;
    }
  }
  // Cell entry: the rider's centre crossed into a new cell.
  const c = Math.floor(rider.x);
  const r = Math.floor(rider.y);
  if (c !== rider.cellC || r !== rider.cellR) {
    rider.cellC = c;
    rider.cellR = r;
    const crash = checkCell(run, rider, c, r);
    if (crash) {
      crashRider(run, rider, crash);
      return;
    }
    rider.trail.add(key(c, r));
    if (rider.kind === 'player') collectBoostCell(run, c, r);
  }
}

function collectBoostCell(run, c, r) {
  for (const cell of run.boostCells) {
    if (!cell.taken && cell.x === c && cell.y === r) {
      cell.taken = true;
      cell.respawnT = run.time + BOOST_CELL_RESPAWN;
      run.player.boost = Math.min(100, run.player.boost + BOOST_CELL_REFILL);
      run.score += BOOST_CELL_SCORE;
      run.pickups++;
      return;
    }
  }
}

// A taken boost cell comes back after its respawn delay, at a random
// free cell (never on a trail, a pillar, another cell, or near a
// rider's head). If no free cell is found it retries in 5s.
function respawnBoostCells(run) {
  const arena = run.arena;
  for (const cell of run.boostCells) {
    if (!cell.taken || run.time < cell.respawnT) continue;
    let placed = false;
    for (let tries = 0; tries < 50 && !placed; tries++) {
      const c = Math.floor(run.rng() * arena.cols);
      const r = Math.floor(run.rng() * arena.rows);
      if (isBlocked(run, c, r)) continue;
      if (run.boostCells.some((b) => !b.taken && b.x === c && b.y === r)) continue;
      let nearRider = false;
      for (const rider of [run.player, ...run.rivals]) {
        if (!rider.alive) continue;
        if (Math.abs(rider.x - (c + 0.5)) < 2.5 && Math.abs(rider.y - (r + 0.5)) < 2.5) { nearRider = true; break; }
      }
      if (nearRider) continue;
      cell.x = c;
      cell.y = r;
      cell.taken = false;
      placed = true;
    }
    if (!placed) cell.respawnT = run.time + 5;
  }
}

// ---------------------------------------------------------------- rival AI
// A rival decides at each cell centre. On an open road it usually
// rides straight and sometimes (mistake) turns at random; with a
// wall/trail close ahead it flood-fills both sides and takes the
// bigger open space — with a mistake chance of taking the worse side.
// As the arena fills up the rivals panic: their mistake rate grows,
// so the shrinking free space eventually boxes one of them in.
export function rivalDecide(run, rival) {
  const ahead = clearanceAhead(run, rival, rival.dir);
  const freeFrac = freeFraction(run);
  const mistake = clamp(rival.mistake + (1 - freeFrac) * 0.25, 0, 0.5);
  const rng = run.rng;
  if (ahead > rival.look) {
    // Open road: ride straight. A random turn here would be a
    // coin-flip suicide — two random turns in a row reverse the
    // rider into its own trail within half a second, which reads as
    // broken, not as a trap. Mistakes belong at the decision points.
    return 0;
  }
  const leftDir = rotateDir(rival.dir, -1);
  const rightDir = rotateDir(rival.dir, 1);
  // The rider is AT a centre when it decides (riderStep snaps it
  // there first), so the entry cell for a turn is the rider's
  // CURRENT cell plus the new direction — not nextCentre, which is
  // the centre after this one. (Before this fix the evaluation was
  // off by one cell along the old heading.)
  const cur = { c: Math.floor(rival.x), r: Math.floor(rival.y) };
  const leftCell = { c: cur.c + leftDir.x, r: cur.r + leftDir.y };
  const rightCell = { c: cur.c + rightDir.x, r: cur.r + rightDir.y };
  // A candidate entry cell that is already a wall, a pillar or any
  // trail has area 0 — floodArea seeds its start cell as free (that
  // convention is for a rider's own head cell), so a blocked entry
  // must be rejected here or the rival will turn into its own trail
  // thinking it is open water.
  const leftArea = isBlocked(run, leftCell.c, leftCell.r) ? 0 : floodArea(run, leftCell);
  const rightArea = isBlocked(run, rightCell.c, rightCell.r) ? 0 : floodArea(run, rightCell);
  if (leftArea === 0 && rightArea === 0) return 0; // doomed — ride on
  let choice = leftArea >= rightArea ? -1 : 1;
  if (rng() < mistake) choice = -choice;
  return choice;
}

// ---------------------------------------------------------------- step
// One fixed step. input: { turn: -1 | 0 | 1, toggleBoost: boolean }.
// turn is an edge (one key press queues one turn); toggleBoost is an
// edge (one Space press flips the boost switch).
export function stepRun(run, input, dt = DT) {
  if (run.phase !== 'riding') return run;
  run.time += dt;
  run.deniedReason = null; // cleared every step — a denial is visible for exactly the step it happens on
  run.lastTrap = null;
  const p = run.player;
  const turn = clamp(input.turn || 0, -1, 1);
  if (turn !== 0) {
    if (p.turnQueue.length < TURN_QUEUE_MAX) p.turnQueue.push(turn);
    else run.deniedReason = 'queue-full';
  }
  if (input.toggleBoost) {
    if (p.boostOn) {
      p.boostOn = false;
    } else if (p.boost > 0) {
      p.boostOn = true;
    } else {
      run.deniedReason = 'boost-empty';
    }
  }
  // Boost meter: drains while boosting, refills while not. Hitting
  // zero switches boost off and names the reason (post-action cue).
  if (p.boostOn) {
    p.boost -= BOOST_DRAIN * dt;
    if (p.boost <= 0) {
      p.boost = 0;
      p.boostOn = false;
      run.deniedReason = 'boost-empty';
    }
  } else {
    p.boost = Math.min(100, p.boost + BOOST_REFILL * dt);
  }
  // Survival score accrues while riding.
  run.score += SURVIVAL_SCORE * dt;
  // Rivals move first (a rival riding into the player's head cell
  // dies first — that is a trap), then the player.
  for (const rival of run.rivals) riderStep(run, rival, dt);
  if (run.phase === 'riding') riderStep(run, p, dt);
  respawnBoostCells(run);
  return run;
}

// ---------------------------------------------------------------- bots
export function noInputPolicy() {
  return { turn: 0, toggleBoost: false };
}

export function holdPolicy() {
  // Never turns, never boosts: the hold-straight bot that must lose.
  return { turn: 0, toggleBoost: false };
}

export function rhythmPolicy(state) {
  // Turns left on a fixed 2s rhythm, never boosts: the fixed-rhythm
  // bot that must lose. state is a caller-owned { step } counter.
  state.step++;
  return { turn: state.step % 120 === 0 ? -1 : 0, toggleBoost: false };
}

export function randomPolicy(rng, state) {
  // A fresh random turn roughly every half second, plus random boost
  // toggles: the random-input bot that must lose.
  state.step++;
  if (state.step % 30 === 0) {
    state.cached = {
      turn: rng() < 0.4 ? (rng() < 0.5 ? -1 : 1) : 0,
      toggleBoost: rng() < 0.2,
    };
  }
  return state.cached || { turn: 0, toggleBoost: false };
}

// Rollout score: simulate greedy play from a candidate entry cell
// for a few moves and return the flood area at the end. A 1-ply
// flood area lies: a 1-wide corridor between two trails can have a
// huge flood area (the whole region beyond it) while being a pocket
// that seals behind the rider — the rider walks in, lays trail, and
// the exit is gone. The rollout grows a scratch trail as the
// simulated rider moves, so a sealing pocket scores low and the bot
// avoids walking into it. Rivals are frozen in the rollout (their
// trails are already walls); the simulated rider picks the max-area
// move at each step, exactly like the 1-ply policy.
export function rolloutScore(run, startCell, startDir, rivalPath, depth = 8) {
  const scratch = new Set();
  let cell = { c: startCell.c, r: startCell.r };
  let dir = { x: startDir.x, y: startDir.y };
  let area = floodArea(run, cell, rivalPath);
  if (area === 0) return 0;
  for (let step = 0; step < depth; step++) {
    scratch.add(key(cell.c, cell.r));
    const blocked = new Set([...scratch, ...(rivalPath || [])]);
    let best = null;
    let bestArea = -1;
    for (const opt of [0, -1, 1]) {
      const nd = rotateDir(dir, opt);
      const nc = { c: cell.c + nd.x, r: cell.r + nd.y };
      if (isBlocked(run, nc.c, nc.r, blocked)) continue;
      const a = floodArea(run, nc, blocked);
      if (a > bestArea) {
        bestArea = a;
        best = { cell: nc, dir: nd, area: a };
      }
    }
    if (!best) {
      // The greedy line dies here. A death on the very first move
      // (no valid move from the entry cell at all) is CERTAIN death:
      // the entry cell is a 1-cell pocket the rider cannot leave,
      // even though the direction-blind flood from it looks big
      // (it counts the region behind the rider, which the rider can
      // never reach without reversing through its own trail). Score
      // it 0. A later death is only a greedy-line failure: score
      // the moves survived, so the bot still prefers the
      // longest-lived line when every option is tight.
      return step === 0 ? 0 : step;
    }
    cell = best.cell;
    dir = best.dir;
    area = best.area;
  }
  return area;
}

// The decision bot: real lookahead/turn-timing through the same
// public input hooks a human uses.
// - Near a cell centre, score the three options (straight / left /
//   right) by a greedy rollout from the cell each would enter next,
//   and take the best — with a cut-off bias: a move that shrinks a
//   nearby rival's reachable space is worth extra, so the bot
//   genuinely tries to trap rivals instead of only out-surviving
//   them. A move into less than 20 cells of space is never taken
//   for a trap — survival comes first.
// - Boost is a decision too: on when the road ahead is long and the
//   meter is healthy, off when the road shortens or the meter runs low.
export function decisionPolicy(run) {
  const p = run.player;
  if (!p.alive || run.phase !== 'riding') return { turn: 0, toggleBoost: false };
  const centre = nextCentre(p);
  let turn = 0;
  if (p.turnQueue.length === 0 && centre.dist <= 0.55) {
    const rivalsAlive = run.rivals.filter((r) => r.alive);
    const rivalHead = rivalsAlive.length
      ? { c: Math.floor(rivalsAlive[0].x), r: Math.floor(rivalsAlive[0].y) }
      : null;
    const rivalAreaBefore = rivalHead ? floodArea(run, rivalHead) : 0;
    // A rival's imminent path is effectively a wall too: the rival
    // moves first each step, so a cell it is about to enter will be
    // its trail by the time the rider gets there. Turning into it
    // is a crash, not a free cell — treat the head cell plus the
    // next 3 cells along each rival's heading as blocked.
    const rivalPath = new Set();
    for (const rv of rivalsAlive) {
      let c = Math.floor(rv.x);
      let r = Math.floor(rv.y);
      for (let i = 0; i < 4; i++) {
        rivalPath.add(key(c, r));
        c += rv.dir.x;
        r += rv.dir.y;
      }
    }
    let bestTurn = 0;
    let bestScore = -Infinity;
    for (const opt of [0, -1, 1]) {
      const dir = rotateDir(p.dir, opt);
      const cell = { c: Math.floor(centre.x + dir.x), r: Math.floor(centre.y + dir.y) };
      // A blocked entry cell kills the rider outright — it is not
      // open water just because floodArea seeds its start cell.
      // A rival's imminent path is dangerous but not certainly
      // fatal (the rival may turn away), so it costs 60 points
      // instead of zeroing the option — the bot avoids it when a
      // safe alternative exists, but takes it over certain death.
      if (isBlocked(run, cell.c, cell.r)) continue;
      const ownArea = rolloutScore(run, cell, dir, rivalPath);
      if (ownArea === 0) continue; // that move kills the rider outright
      let score = ownArea;
      if (rivalPath.has(key(cell.c, cell.r))) score -= 60;
      // Cut-off bias: only when the rider has room to spare.
      if (rivalHead && ownArea >= 20) {
        const extra = new Set([key(cell.c, cell.r)]);
        const rivalAreaAfter = floodArea(run, rivalHead, extra);
        score += 0.7 * Math.max(0, rivalAreaBefore - rivalAreaAfter);
      }
      // Tie-break: prefer straight, then left (strict > keeps the
      // first — straight — on a tie).
      if (score > bestScore) {
        bestScore = score;
        bestTurn = opt;
      }
    }
    turn = bestTurn;
  }
  const clearance = clearanceAhead(run, p, p.dir);
  let toggleBoost = false;
  if (p.boostOn && (clearance < 6 || p.boost < 12)) toggleBoost = true;
  else if (!p.boostOn && clearance > 14 && p.boost > 40) toggleBoost = true;
  return { turn, toggleBoost };
}

export function simulateRun(arena, policy, maxSeconds = MAX_SECONDS, seed = 0) {
  const run = createRun(arena, seed);
  const maxSteps = Math.floor(maxSeconds / DT);
  let steps = 0;
  const rng = mulberry32(4242 + arena.id * 17 + seed);
  const state = { step: 0, cached: null };
  while (run.phase === 'riding' && steps < maxSteps) {
    let input;
    if (policy === 'none') input = noInputPolicy();
    else if (policy === 'hold') input = holdPolicy();
    else if (policy === 'rhythm') input = rhythmPolicy(state);
    else if (policy === 'random') input = randomPolicy(rng, state);
    else if (policy === 'decision') input = decisionPolicy(run);
    else throw new Error('unknown policy: ' + policy);
    stepRun(run, input);
    steps++;
  }
  return {
    policy,
    arenaId: arena.id,
    won: run.phase === 'won',
    lost: run.phase === 'lost',
    time: +run.time.toFixed(2),
    traps: run.traps,
    rivalsTrapped: run.rivals.filter((r) => !r.alive).length,
    rivalsTotal: run.rivals.length,
    pickups: run.pickups,
    score: run.score,
    crashReason: run.crashReason,
    crashTarget: run.crashTarget,
    steps,
  };
}

// ---------------------------------------------------------------- save
export const RANK_ORDER = { B: 1, A: 2, S: 3 };
export function defaultSave() {
  return {
    version: 1,
    best: {}, // arenaId -> { score, time, traps, pickups, won, rank? }
    unlocked: 1, // highest arena id unlocked
    settings: { muted: false, shake: 100, flash: true },
  };
}

export function serializeSave(save) {
  return JSON.stringify(save);
}

export function parseSave(raw) {
  try {
    const s = JSON.parse(raw);
    if (!s || typeof s !== 'object') return defaultSave();
    const d = defaultSave();
    const best = {};
    for (const [id, entry] of Object.entries(s.best || {})) {
      if (!entry || typeof entry !== 'object') continue;
      const kept = { ...entry };
      if (kept.rank !== undefined && !['S', 'A', 'B'].includes(kept.rank)) delete kept.rank;
      best[id] = kept;
    }
    return {
      version: 1,
      best,
      unlocked: Number.isInteger(s.unlocked) ? clamp(s.unlocked, 1, ARENAS.length) : 1,
      settings: { ...d.settings, ...(s.settings || {}) },
    };
  } catch {
    return defaultSave();
  }
}

export function recordBest(save, arenaId, result) {
  const prev = save.best[arenaId];
  if (!result.won) return save;
  const better = !prev || result.score > prev.score;
  let rank = prev ? prev.rank : undefined;
  if (typeof result.par === 'number') {
    const r = rankFor(result);
    if (r && (!rank || RANK_ORDER[r] > RANK_ORDER[rank])) rank = r;
  }
  if (better) {
    save.best[arenaId] = {
      score: result.score,
      time: result.time,
      traps: result.traps,
      pickups: result.pickups,
      won: true,
    };
  }
  if (rank) save.best[arenaId].rank = rank;
  if (arenaId < ARENAS.length && save.unlocked < arenaId + 1) {
    save.unlocked = arenaId + 1;
  }
  return save;
}

export function isArenaUnlocked(save, arenaId) {
  return arenaId <= save.unlocked;
}

export function rankFor(result) {
  // S: won under par. A: won under 1.5x par. B: won over that.
  if (!result.won) return null;
  if (result.time <= result.par) return 'S';
  if (result.time <= result.par * 1.5) return 'A';
  return 'B';
}

// ---------------------------------------------------------------- feedback
// Game-feel tiers (same shape as the other games): every event fires a
// bundle of layered responses within ~100ms.
export const FEEDBACK = {
  turn: { trauma: 0.1, hitStop: 0, sfx: 'turn', flash: 0, particles: 2 },
  boost: { trauma: 0.12, hitStop: 0, sfx: 'boost', flash: 0, particles: 8 },
  pickup: { trauma: 0.15, hitStop: 0, sfx: 'pickup', flash: 0, particles: 14 },
  trap: { trauma: 0.5, hitStop: 0.06, sfx: 'trap', flash: 0.1, particles: 30 },
  crash: { trauma: 0.8, hitStop: 0.12, sfx: 'crash', flash: 0.2, particles: 40 },
  win: { trauma: 0.8, hitStop: 0.12, sfx: 'finish', flash: 0.2, particles: 60 },
  denied: { trauma: 0.08, hitStop: 0, sfx: 'denied', flash: 0, particles: 0 },
};
export const FEEDBACK_TIERS = {
  small: { trauma: [0.1, 0.2], hitStop: 0 },
  medium: { trauma: [0.3, 0.5], hitStop: [0.04, 0.06] },
  large: { trauma: [0.7, 1.0], hitStop: [0.1, 0.15] },
};
export const FEEDBACK_LAYERS = ['sound', 'particles', 'shake', 'flash', 'number-pop'];
