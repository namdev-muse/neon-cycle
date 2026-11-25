// Neon Cycle v0.1.0 — bot harness gates.
// The decision bot must clear every arena with real lookahead /
// turn-timing (and a cut-off bias that genuinely tries to trap
// rivals); the bots that must lose (hold straight, fixed-rhythm
// turns, no input, random turns) must lose on every arena. If a
// hold-one-button bot clears an arena, the arena is not done.
// The decision bot is also checked on seeds 1-2: a skilled player
// must win reliably, not by one lucky RNG roll.
import { ARENAS, simulateRun } from '../physics.js';

let failed = 0;
function gate(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failed++;
}

for (const arena of ARENAS) {
  const decision = simulateRun(arena, 'decision');
  gate(
    `decision bot clears arena ${arena.id} (${arena.name})`,
    decision.won,
    `time ${decision.time}s (par ${arena.par}s), traps ${decision.traps}/${decision.rivalsTotal}, pickups ${decision.pickups}, score ${decision.score}`,
  );
  gate(
    `decision bot traps every rival on arena ${arena.id}`,
    decision.won && decision.traps === decision.rivalsTotal,
    `traps ${decision.traps}/${decision.rivalsTotal}`,
  );
  for (const seed of [1, 2]) {
    const seeded = simulateRun(arena, 'decision', 400, seed);
    gate(
      `decision bot clears arena ${arena.id} on seed ${seed} (reliable, not one lucky roll)`,
      seeded.won,
      `time ${seeded.time}s, traps ${seeded.traps}/${seeded.rivalsTotal}`,
    );
  }

  const hold = simulateRun(arena, 'hold');
  gate(
    `hold-straight bot LOSES arena ${arena.id}`,
    !hold.won,
    `time ${hold.time}s, crash ${hold.crashReason || '-'}, traps ${hold.traps}`,
  );

  const rhythm = simulateRun(arena, 'rhythm');
  gate(
    `fixed-rhythm bot LOSES arena ${arena.id}`,
    !rhythm.won,
    `time ${rhythm.time}s, crash ${rhythm.crashReason || '-'}, traps ${rhythm.traps}`,
  );

  const none = simulateRun(arena, 'none');
  gate(
    `no-input bot LOSES arena ${arena.id}`,
    !none.won && none.lost,
    `lost=${none.lost}, time ${none.time}s, crash ${none.crashReason || '-'}`,
  );

  const random = simulateRun(arena, 'random');
  gate(
    `random-input bot LOSES arena ${arena.id}`,
    !random.won,
    `time ${random.time}s, crash ${random.crashReason || '-'}, traps ${random.traps}`,
  );
}

// Difficulty note (M1): the decision bot's clear times are reported
// but not gated on strict increase — the 12-arena curve is M2's job.
// They are recorded here so M2 can see the baseline.
{
  const times = ARENAS.map((a) => simulateRun(a, 'decision').time);
  console.log(`decision-bot clear times (seed 0): ${times.join('s, ')}s (pars ${ARENAS.map((a) => a.par).join('s, ')}s)`);
}

if (failed > 0) {
  console.error(`bot gates: ${failed} FAILED`);
  process.exit(1);
}
console.log('bot gates: all pass');
