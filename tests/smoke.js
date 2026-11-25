// Neon Cycle v0.1.0 — Node smoke tests for physics.js (no DOM, no Three.js).
import {
  VERSION, ARENAS, arenaById, arenaThreat, arenaCellCount, DT,
  DIRS, rotateDir, nextCentre, floodArea, clearanceAhead, freeFraction,
  pillarAt, createRun, startRun, stepRun, playerSpeed,
  BOOST_DRAIN, BOOST_REFILL, BOOST_CELL_REFILL, BOOST_CELL_SCORE,
  BOOST_MULT, SURVIVAL_SCORE, TRAP_BASE, TRAP_BONUS_PLAYER_TRAIL,
  TURN_QUEUE_MAX, MAX_SECONDS,
  noInputPolicy, holdPolicy, rhythmPolicy, randomPolicy, decisionPolicy, simulateRun,
  defaultSave, serializeSave, parseSave, recordBest, isArenaUnlocked,
  rankFor, FEEDBACK, FEEDBACK_TIERS, FEEDBACK_LAYERS, WIN_BONUS,
} from '../physics.js';
import { key } from '../physics.js';

let passed = 0, failed = 0;
const failures = [];
function check(name, cond) {
  if (cond) passed++;
  else { failed++; failures.push(name); console.error('FAIL:', name); }
}
function approx(a, b, eps = 1e-9) { return Math.abs(a - b) <= eps; }

check('physics version is 0.1.0', VERSION === '0.1.0');
check('3 arenas defined', ARENAS.length === 3);
check('arena ids are 1..3 in order', ARENAS.every((a, i) => a.id === i + 1));
check('every arena has a name and a hint', ARENAS.every((a) => a.name && a.hint));
check('every arena has a distinct accent', new Set(ARENAS.map((a) => a.accent)).size === 3);
check('arenaById finds arena 1', arenaById(1) && arenaById(1).name === 'First Grid');
check('arenaById finds arena 3', arenaById(3) && arenaById(3).name === 'The Gauntlet');
check('arenaById returns null for unknown id', arenaById(99) === null);
check('every arena has 1+ rivals', ARENAS.every((a) => a.rivals.length >= 1));
check('rival count grows with arena number', ARENAS[0].rivals.length === 1 && ARENAS[1].rivals.length === 2 && ARENAS[2].rivals.length === 3);
check('every arena has 4+ boost cells', ARENAS.every((a) => a.boostCells.length >= 4));
check('threat grows with arena number', ARENAS.every((a, i) => i === 0 || arenaThreat(a) > arenaThreat(ARENAS[i - 1])));
check('no difficulty cliff: each arena within 1.6x of the previous threat',
  ARENAS.every((a, i) => i === 0 || arenaThreat(a) < arenaThreat(ARENAS[i - 1]) * 1.6));
check('boost cells sit inside the grid', ARENAS.every((a) =>
  a.boostCells.every((c) => c.x >= 0 && c.x < a.cols && c.y >= 0 && c.y < a.rows)));
check('boost cells never sit on a pillar', ARENAS.every((a) =>
  a.boostCells.every((c) => !pillarAt(a, c.x, c.y))));
check('boost cells are unique per arena', ARENAS.every((a) =>
  new Set(a.boostCells.map((c) => c.x + ',' + c.y)).size === a.boostCells.length));
check('player start is inside the grid and not on a pillar', ARENAS.every((a) => {
  const s = a.playerStart;
  return s.x > 0 && s.x < a.cols && s.y > 0 && s.y < a.rows
    && !pillarAt(a, Math.floor(s.x), Math.floor(s.y));
}));
check('rival starts are inside the grid and not on a pillar', ARENAS.every((a) =>
  a.rivals.every((r) => {
    const s = r.start;
    return s.x > 0 && s.x < a.cols && s.y > 0 && s.y < a.rows
      && !pillarAt(a, Math.floor(s.x), Math.floor(s.y));
  })));
check('player start has clear space ahead (8+ cells)', ARENAS.every((a) => {
  const run = createRun(a);
  return clearanceAhead(run, run.player, run.player.dir) >= 8;
}));
check('the arena is mostly reachable from the player start', ARENAS.every((a) => {
  const run = createRun(a);
  const area = floodArea(run, { c: Math.floor(a.playerStart.x), r: Math.floor(a.playerStart.y) });
  return area > arenaCellCount(a) * 0.6;
}));

// --- directions: left is counter-clockwise, right is clockwise ---
check('left turn rotates east to north', rotateDir(DIRS.E, -1).x === 0 && rotateDir(DIRS.E, -1).y === 1);
check('left turn rotates north to west', rotateDir(DIRS.N, -1).x === -1 && rotateDir(DIRS.N, -1).y === 0);
check('right turn rotates east to south', rotateDir(DIRS.E, 1).x === 0 && rotateDir(DIRS.E, 1).y === -1);
check('right turn rotates north to east', rotateDir(DIRS.N, 1).x === 1 && rotateDir(DIRS.N, 1).y === 0);
check('no turn keeps the direction', rotateDir(DIRS.W, 0).x === -1 && rotateDir(DIRS.W, 0).y === 0);

// --- run lifecycle ---
const run1 = startRun(1);
check('startRun returns a run on arena 1', !!run1 && run1.arena.id === 1);
check('run starts in riding phase', run1.phase === 'riding');
check('run starts with the player alive', run1.player.alive === true);
check('run starts with 1 rival alive', run1.rivals.length === 1 && run1.rivals[0].alive === true);
check('run starts with a full boost meter', run1.player.boost === 100);
check('run starts with boost off', run1.player.boostOn === false);
check('run starts with score 0', run1.score === 0);
check('startRun returns null for unknown arena', startRun(99) === null);
check('player starts on its start cell', Math.floor(run1.player.x) === 6 && Math.floor(run1.player.y) === 8);
check('player trail starts with the start cell', run1.player.trail.size === 1);

// --- turn queuing: a turn executes at the next cell centre ---
{
  const r = startRun(1);
  const p = r.player;
  // Ride straight to just before the next centre (7.5), then queue a left.
  stepRun(r, { turn: 0, toggleBoost: false });
  const dir0 = { ...p.dir };
  stepRun(r, { turn: -1, toggleBoost: false });
  check('a queued turn does not fire before the next centre', p.dir.x === dir0.x && p.dir.y === dir0.y);
  check('a queued turn sits in the queue', p.turnQueue.length === 1);
  let turned = false;
  for (let i = 0; i < 120 && !turned; i++) {
    stepRun(r, { turn: 0, toggleBoost: false });
    if (p.dir.x !== dir0.x || p.dir.y !== dir0.y) turned = true;
  }
  check('a queued turn fires at the next cell centre', turned);
  check('turning left from east heads north', p.dir.x === 0 && p.dir.y === 1);
  check('the queue drains when the turn fires', p.turnQueue.length === 0);
}
// --- turn queuing: a fast double-tap queues two turns for two centres ---
{
  const r = startRun(1);
  const p = r.player;
  stepRun(r, { turn: -1, toggleBoost: false });
  stepRun(r, { turn: -1, toggleBoost: false });
  check('a double-tap queues two turns', p.turnQueue.length === 2);
  let turns = 0;
  let lastDir = { ...p.dir };
  for (let i = 0; i < 300 && turns < 2; i++) {
    stepRun(r, { turn: 0, toggleBoost: false });
    if (p.dir.x !== lastDir.x || p.dir.y !== lastDir.y) { turns++; lastDir = { ...p.dir }; }
  }
  check('both queued turns fire in order', turns === 2);
  check('two lefts reverse the rider (east -> west)', p.dir.x === -1 && p.dir.y === 0);
}
// --- turn queue full: a third turn in one cell names the reason ---
{
  const r = startRun(1);
  const p = r.player;
  stepRun(r, { turn: -1, toggleBoost: false });
  stepRun(r, { turn: -1, toggleBoost: false });
  stepRun(r, { turn: -1, toggleBoost: false });
  check('a third queued turn is dropped and named', r.deniedReason === 'queue-full' && p.turnQueue.length === TURN_QUEUE_MAX);
  stepRun(r, { turn: 0, toggleBoost: false });
  check('denied reason clears on the next step', r.deniedReason === null);
}
// --- turning left moves the rider left in world space ---
// Sim +x is east, sim +y is north; world is sim +x -> world +x,
// sim +y -> world -z. Facing east, screen-left is world -z, which
// is sim +y — so a left turn (east -> north) must move the rider
// toward sim +y, i.e. world -z, i.e. left on screen.
{
  const r = startRun(1);
  const p = r.player;
  const y0 = p.y;
  stepRun(r, { turn: -1, toggleBoost: false });
  for (let i = 0; i < 120 && p.dir.y !== 1; i++) stepRun(r, { turn: 0, toggleBoost: false });
  for (let i = 0; i < 30; i++) stepRun(r, { turn: 0, toggleBoost: false });
  check('turning left moves the rider toward sim +y (screen-left when facing east)', p.y > y0 + 1);
  const r2 = startRun(1);
  const p2 = r2.player;
  const y02 = p2.y;
  stepRun(r2, { turn: 1, toggleBoost: false });
  for (let i = 0; i < 120 && p2.dir.y !== -1; i++) stepRun(r2, { turn: 0, toggleBoost: false });
  for (let i = 0; i < 30; i++) stepRun(r2, { turn: 0, toggleBoost: false });
  check('turning right moves the rider toward sim -y (screen-right when facing east)', p2.y < y02 - 1);
}
// --- trail: the rider leaves a trail behind it ---
{
  const r = startRun(1);
  const p = r.player;
  for (let i = 0; i < 60; i++) stepRun(r, { turn: 0, toggleBoost: false });
  check('the trail grows as the rider rides', p.trail.size > 3);
  check('the trail contains the cells the rider passed through', p.trail.has('6,8') && p.trail.has('7,8'));
}
// --- trail collision: riding into your own trail crashes the run ---
{
  const r = startRun(1);
  const p = r.player;
  // Ride a small square: east 2 cells, north 2, west 2, south into
  // the trail just laid. Queue turns one at a time at centres.
  const rideTo = (targetDir, maxSteps = 400) => {
    for (let i = 0; i < maxSteps; i++) {
      if (p.dir.x === targetDir.x && p.dir.y === targetDir.y) return true;
      stepRun(r, { turn: 0, toggleBoost: false });
      if (r.phase !== 'riding') return false;
    }
    return false;
  };
  // Drive east 2 cells, then turn north, west, south back into the trail.
  for (let i = 0; i < 25; i++) stepRun(r, { turn: 0, toggleBoost: false }); // ~2.5 cells east
  stepRun(r, { turn: -1, toggleBoost: false }); // north at next centre
  for (let i = 0; i < 60 && p.dir.y !== 1; i++) stepRun(r, { turn: 0, toggleBoost: false });
  for (let i = 0; i < 25; i++) stepRun(r, { turn: 0, toggleBoost: false }); // ~2.5 cells north
  stepRun(r, { turn: -1, toggleBoost: false }); // west
  for (let i = 0; i < 60 && p.dir.x !== -1; i++) stepRun(r, { turn: 0, toggleBoost: false });
  for (let i = 0; i < 25; i++) stepRun(r, { turn: 0, toggleBoost: false }); // ~2.5 cells west
  stepRun(r, { turn: -1, toggleBoost: false }); // south — into the trail laid on the way out
  let crashed = false;
  for (let i = 0; i < 120 && r.phase === 'riding'; i++) stepRun(r, { turn: 0, toggleBoost: false });
  crashed = r.phase === 'lost';
  check('riding back into your own trail crashes the run', crashed);
  check('the crash names the trail', r.crashReason === 'trail');
  check('the run is lost after a trail crash', r.phase === 'lost' && !r.player.alive);
}
// --- wall crash: riding straight into the arena edge ends the run ---
{
  const r = startRun(1);
  for (let i = 0; i < 600 && r.phase === 'riding'; i++) stepRun(r, { turn: 0, toggleBoost: false });
  check('riding into the arena edge crashes the run', r.phase === 'lost');
  check('the wall crash names the wall', r.crashReason === 'wall');
}
// --- pillar crash: riding into a pillar ends the run ---
{
  const r = startRun(2);
  const p = r.player;
  // Arena 2: player starts at (4.5, 15.5) heading east; the corner
  // pillar at (5, 13) is two rows south. Turn right at the first
  // centre and ride south along col 5 into it.
  stepRun(r, { turn: 1, toggleBoost: false });
  for (let i = 0; i < 120 && p.dir.y !== -1; i++) stepRun(r, { turn: 0, toggleBoost: false });
  // Now heading north along col ~5; the pillar (5,13) is ahead.
  // Nudge the rider onto col 5 exactly: it turned at a centre, so
  // it is on a centre line already.
  let crashed = false;
  for (let i = 0; i < 600 && r.phase === 'riding'; i++) stepRun(r, { turn: 0, toggleBoost: false });
  crashed = r.phase === 'lost';
  check('riding into a pillar crashes the run', crashed);
  check('the pillar crash names the pillar', r.crashReason === 'pillar');
}
// --- boost toggle: Space flips the switch, never a hold ---
// The player turns north first: the arena-1 opening line holds a
// boost cell at (12,8) that would mask the drain, and arena 3's
// central pillar block sits on its opening line. Heading north
// along col 7 there is no boost cell and 7 cells of clear grid.
{
  const r = startRun(1);
  const p = r.player;
  const s0 = playerSpeed(r);
  stepRun(r, { turn: -1, toggleBoost: false });
  for (let i = 0; i < 120 && p.dir.y !== 1; i++) stepRun(r, { turn: 0, toggleBoost: false });
  stepRun(r, { turn: 0, toggleBoost: true });
  check('toggling boost on switches it on', p.boostOn === true);
  check('boost raises the speed', playerSpeed(r) > s0 * 1.4);
  const boost0 = p.boost;
  for (let i = 0; i < 30; i++) stepRun(r, { turn: 0, toggleBoost: false });
  check('boosting drains the meter', p.boost < boost0 - 10);
  stepRun(r, { turn: 0, toggleBoost: true });
  check('toggling boost again switches it off', p.boostOn === false);
  check('speed drops back when boost switches off', approx(playerSpeed(r), s0, 0.5));
  const b1 = p.boost;
  for (let i = 0; i < 15; i++) stepRun(r, { turn: 0, toggleBoost: false });
  check('the meter refills while boost is off', p.boost > b1 + 1);
}
// --- boost toggle with an empty meter names the reason ---
{
  const r = startRun(1);
  const p = r.player;
  p.boost = 0;
  stepRun(r, { turn: 0, toggleBoost: true });
  check('toggling boost on with an empty meter is denied', p.boostOn === false && r.deniedReason === 'boost-empty');
  // Boost drains to zero mid-ride and switches itself off.
  const r2 = startRun(3);
  const p2 = r2.player;
  p2.boost = 5;
  stepRun(r2, { turn: 0, toggleBoost: true });
  check('boost switches on with a sliver of meter', p2.boostOn === true);
  p2.boost = 0.4; // one step of drain (0.5) takes it to zero
  stepRun(r2, { turn: 0, toggleBoost: false });
  check('boost switches itself off at zero and names it', p2.boostOn === false && r2.deniedReason === 'boost-empty');
}
// --- boost cells: riding over one refills the meter and scores ---
{
  const r = startRun(1);
  const p = r.player;
  const cell = r.boostCells[0]; // (12, 8) — straight ahead on the opening line
  p.boost = 30;
  const score0 = r.score;
  // Ride east along row 8 to the cell.
  for (let i = 0; i < 600 && r.phase === 'riding' && !cell.taken; i++) stepRun(r, { turn: 0, toggleBoost: false });
  check('riding over a boost cell collects it', cell.taken === true);
  check('a boost cell refills the meter', p.boost > 30 + BOOST_CELL_REFILL - 5);
  check('a boost cell scores', r.score >= score0 + BOOST_CELL_SCORE);
  check('pickups count increments', r.pickups === 1);
  // The cell respawns after its delay at a free cell. (The delay is
  // shortened for the test — a full 10s run would end first, since
  // the decision bot traps the arena-1 rival in ~5s.)
  const oldPos = { x: cell.x, y: cell.y };
  cell.respawnT = r.time + 0.5;
  for (let i = 0; i < 60 * 3 && r.phase === 'riding' && cell.taken; i++) {
    // Keep riding safely: decision bot input keeps the run alive.
    stepRun(r, decisionPolicy(r));
  }
  check('a collected boost cell respawns', cell.taken === false);
  check('the respawned cell moved', cell.x !== oldPos.x || cell.y !== oldPos.y);
}
// --- trap detection: a rival riding into the player's trail is banked ---
{
  const r = startRun(1);
  const rival = r.rivals[0];
  // Put the rival one cell west of the player's trail, heading east
  // into it: player trail covers (6,8)..(7,8) at the start; place the
  // rival at (5.5, 8.5) heading east — it will enter (6,8) next.
  rival.x = 5.5;
  rival.y = 8.5;
  rival.dir = { ...DIRS.E };
  rival.cellC = 5;
  rival.cellR = 8;
  rival.trail = new Set(['5,8']);
  const score0 = r.score;
  const traps0 = r.traps;
  for (let i = 0; i < 60 && rival.alive; i++) stepRun(r, { turn: 0, toggleBoost: false });
  check('a rival riding into the player trail crashes', !rival.alive);
  check('the rival crash is a player-trail trap', rival.crashCause === 'player-trail');
  check('the trap is banked (traps count)', r.traps === traps0 + 1);
  check('the trap scores the base plus the cut-off bonus', r.lastTrap && r.lastTrap.score === TRAP_BASE + TRAP_BONUS_PLAYER_TRAIL);
  check('the trap is announced for the game', !!r.lastTrap && r.lastTrap.name === 'VEX');
  check('trapping the last rival wins the arena', r.phase === 'won');
}
// --- a rival blundering into a wall still banks (smaller) ---
{
  const r = startRun(1);
  const rival = r.rivals[0];
  rival.x = 23.5;
  rival.y = 4.5;
  rival.dir = { ...DIRS.E }; // east wall is one cell away
  rival.cellC = 23;
  rival.cellR = 4;
  const score0 = r.score;
  for (let i = 0; i < 60 && rival.alive; i++) stepRun(r, { turn: 0, toggleBoost: false });
  check('a rival riding into the wall crashes', !rival.alive && rival.crashReason === 'wall');
  check('a wall blunder banks the base trap score (no cut-off bonus)', r.lastTrap && r.lastTrap.score === TRAP_BASE);
  check('trapping the last rival wins the arena (blunder)', r.phase === 'won');
}
// --- combo: two traps inside the window pay more than two apart ---
{
  const r = startRun(2);
  // First let the player lay a trail east along row 15 (~10 cells).
  for (let i = 0; i < 90; i++) stepRun(r, { turn: 0, toggleBoost: false });
  check('setup: the player laid a trail along row 15', r.player.trail.has('8,15') && r.player.trail.has('10,15'));
  // Place both rivals on a collision course with that trail: one
  // rides north into (8,15), the other south into (10,15).
  const place = (rival, x, y, dir) => {
    rival.x = x; rival.y = y;
    rival.dir = { ...dir };
    rival.cellC = Math.floor(x); rival.cellR = Math.floor(y);
    rival.trail = new Set([key(Math.floor(x), Math.floor(y))]);
  };
  place(r.rivals[0], 8.5, 14.5, DIRS.N);
  place(r.rivals[1], 10.5, 16.5, DIRS.S);
  for (let i = 0; i < 60 && r.rivals[1].alive; i++) stepRun(r, { turn: 0, toggleBoost: false });
  check('both rivals trapped', r.traps === 2);
  check('both traps were real cut-offs', r.rivals.every((rv) => rv.crashCause === 'player-trail'));
  check('the combo paid the second trap more', r.lastTrap && r.lastTrap.score > TRAP_BASE + TRAP_BONUS_PLAYER_TRAIL);
  check('combo is 2 after two quick traps', r.combo === 2);
}
// --- scoring: survival time accrues ---
// 30 steps (0.5s): short enough that no rival can have crashed yet
// and the arena-1 boost cell at (12,8) is still 0.4s away.
{
  const r = startRun(1);
  for (let i = 0; i < 30; i++) stepRun(r, { turn: 0, toggleBoost: false });
  check('survival time scores', r.score >= SURVIVAL_SCORE * 0.4 && r.score <= SURVIVAL_SCORE * 0.6);
}
// --- determinism: identical inputs give identical runs ---
{
  const a = startRun(2, 3);
  const b = startRun(2, 3);
  for (let i = 0; i < 600; i++) {
    stepRun(a, decisionPolicy(a));
    stepRun(b, decisionPolicy(b));
  }
  check('identical inputs give identical runs',
    a.phase === b.phase && a.player.x === b.player.x && a.player.y === b.player.y && a.score === b.score && a.traps === b.traps);
}
// --- flood / clearance helpers ---
{
  const r = startRun(1);
  check('clearance ahead is long on the open first arena', clearanceAhead(r, r.player, r.player.dir) >= 10);
  check('flood area from the start covers most of the arena', floodArea(r, { c: 6, r: 8 }) > arenaCellCount(ARENAS[0]) * 0.8);
  check('flood area from a blocked cell is 0', floodArea(r, { c: -1, r: 8 }) === 0);
  check('the arena starts almost entirely free', freeFraction(r) > 0.95);
}
// --- save / unlock / ranks ---
{
  const s = defaultSave();
  check('fresh save unlocks only arena 1', s.unlocked === 1 && isArenaUnlocked(s, 1) && !isArenaUnlocked(s, 2));
  recordBest(s, 1, { won: true, score: 1500, time: 60, traps: 1, pickups: 3, par: 75 });
  check('clearing arena 1 unlocks arena 2', s.unlocked === 2 && isArenaUnlocked(s, 2));
  check('best score recorded', s.best[1].score === 1500);
  const s2 = parseSave(serializeSave(s));
  check('save round-trips through JSON', s2.unlocked === 2 && s2.best[1].score === 1500);
  check('corrupt save falls back to defaults', parseSave('not json').unlocked === 1);
  check('S rank is a win under par', rankFor({ won: true, time: 60, par: 75 }) === 'S');
  check('A rank is a win under 1.5x par', rankFor({ won: true, time: 100, par: 75 }) === 'A');
  check('B rank is a win over 1.5x par', rankFor({ won: true, time: 200, par: 75 }) === 'B');
  check('no rank without a win', rankFor({ won: false, time: 60, par: 75 }) === null);
  check('a loss does not record a best', (() => {
    const s3 = defaultSave();
    recordBest(s3, 1, { won: false, score: 9999, time: 10, traps: 0, pickups: 0, par: 75 });
    return !s3.best[1];
  })());
  check('a better rank upgrades the saved rank even on a lower score', (() => {
    const s4 = defaultSave();
    recordBest(s4, 1, { won: true, score: 1000, time: 200, traps: 1, pickups: 2, par: 75 });
    if (s4.best[1].rank !== 'B') return false;
    recordBest(s4, 1, { won: true, score: 900, time: 60, traps: 1, pickups: 2, par: 75 });
    return s4.best[1].rank === 'S' && s4.best[1].score === 1000;
  })());
}
// --- feedback table is complete and tiered ---
check('feedback events exist for every game event',
  ['turn', 'boost', 'pickup', 'trap', 'crash', 'win', 'denied'].every((e) => !!FEEDBACK[e]));
check('every feedback entry carries a full bundle (sfx, particles, trauma, hit-stop, flash)',
  Object.values(FEEDBACK).every((fb) =>
    typeof fb.sfx === 'string' && fb.sfx.length > 0 &&
    Number.isInteger(fb.particles) && fb.particles >= 0 &&
    fb.trauma >= 0 && fb.trauma <= 1 &&
    fb.hitStop >= 0 && fb.hitStop <= 0.15 &&
    fb.flash >= 0 && fb.flash <= 0.2));
check('feedback tiers match the game-feel skill ranges',
  FEEDBACK_TIERS.small.trauma[0] === 0.1 && FEEDBACK_TIERS.small.trauma[1] === 0.2 && FEEDBACK_TIERS.small.hitStop === 0 &&
  FEEDBACK_TIERS.medium.trauma[0] === 0.3 && FEEDBACK_TIERS.medium.trauma[1] === 0.5 &&
  FEEDBACK_TIERS.medium.hitStop[0] === 0.04 && FEEDBACK_TIERS.medium.hitStop[1] === 0.06 &&
  FEEDBACK_TIERS.large.trauma[0] === 0.7 && FEEDBACK_TIERS.large.trauma[1] === 1.0 &&
  FEEDBACK_TIERS.large.hitStop[0] === 0.1 && FEEDBACK_TIERS.large.hitStop[1] === 0.15);
check('every feedback event sits inside its tier (trauma within the matching tier band)',
  FEEDBACK.turn.trauma <= FEEDBACK_TIERS.small.trauma[1] &&
  FEEDBACK.boost.trauma <= FEEDBACK_TIERS.small.trauma[1] &&
  FEEDBACK.pickup.trauma <= FEEDBACK_TIERS.small.trauma[1] &&
  FEEDBACK.trap.trauma >= FEEDBACK_TIERS.medium.trauma[0] && FEEDBACK.trap.trauma <= FEEDBACK_TIERS.medium.trauma[1] &&
  FEEDBACK.trap.hitStop >= FEEDBACK_TIERS.medium.hitStop[0] && FEEDBACK.trap.hitStop <= FEEDBACK_TIERS.medium.hitStop[1] &&
  FEEDBACK.crash.trauma >= FEEDBACK_TIERS.large.trauma[0] && FEEDBACK.crash.hitStop >= FEEDBACK_TIERS.large.hitStop[0]);
check('feedback tiers cover small/medium/large',
  !!FEEDBACK_TIERS.small && !!FEEDBACK_TIERS.medium && !!FEEDBACK_TIERS.large);
check('feedback layers list sound, particles, shake, flash, number-pop',
  FEEDBACK_LAYERS.join(',') === 'sound,particles,shake,flash,number-pop');
check('win is the biggest feedback (trauma >= trap)',
  FEEDBACK.win.trauma >= FEEDBACK.trap.trauma && FEEDBACK.win.hitStop >= FEEDBACK.trap.hitStop);
check('fixed step is 1/60', approx(DT, 1 / 60));
check('boost multiplies speed by a real margin', BOOST_MULT > 1.3 && BOOST_MULT < 2);

console.log(`smoke: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('failures:', failures.join(' | '));
  process.exit(1);
}
