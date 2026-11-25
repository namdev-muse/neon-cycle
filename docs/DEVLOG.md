# Neon Cycle — devlog

## M1 — Core (setup run, v0.1.0, local only)

Setup run built the M1 core locally: grid light-cycle sim (discrete 90° turn queuing, permanent trail walls, boost toggle with meter + cells, rival AI with flood-fill lookahead, trap detection with player-trail bonus + combo, per-arena best + ranks + unlock chain), 3 dense hand-crafted arenas (First Grid 24×16, Crossroads 26×18 with a central pillar block, The Gauntlet 28×18 with pillar walls), live animated menu with screen stack and juice, no assist of any kind. Public unlock/seed path `?arena=N` / `?unlock=1` (not in the player-facing UI). Tests + CI/Pages workflow.

Physics tuning found in the setup run:

- Rival AI first turned randomly on open road — a rival U-turned into its own trail within 0.5s, which read as broken, not as a trap. Rivals now ride straight while clearance ahead exceeds their look distance, and only choose a side when blocked (flood-fill both sides from the current cell, take the bigger space, mistake chance grows as free space shrinks).
- `floodArea` seeds its start cell as free, which is only correct for a rider's own head cell — callers must guard with `isBlocked` first, and the rival's side-choice had an off-by-one (it flooded from the next centre instead of the current cell).
- Decision bot's greedy rollout scored a direction by flood area alone, but the flood counts the region *behind* the rider, which it can never reach without reversing through its own trail. The fix: a rollout that finds no valid move from the entry cell scores 0 (certain death); a later greedy-line death scores the moves survived. That one fix turned seed 3 on arena 2 from a loss into a win.
- ORION (arena 3) started heading north straight into the north wall and died in 0.3s — start direction fixed to south.
- The decision bot wins partly by active cut-off trapping (arena 3 clears in 3.2s–13.62s across seeds — rivals can die fast on pillar-lane arenas). M2 tuning note: rival durability on arena 3.

Eye-check fixes (screenshots inspected at 1280x720 / 2560x1080 / 1080x2340, two rounds):

- HUD score showed the raw float (`58.49999999999997`) — now floored for display.
- Trails were unlit single-colour boxes and read as flat roads, not walls. Now two-tone (bright top face, darker sides), narrower (0.45) and taller (1.3) — the magenta rival trail reads as a wall with a visible side face.
- Chase camera was 8 high looking 6 ahead: the grid filled only the bottom 60% and the rider sat behind the touch BOOST button. Now 6.5 high, looking 3 ahead — rider at ~56% down (measured), far wall at ~11% from the top.
- The sky above the horizon was pure black void (stars were placed high overhead, outside the camera's frustum, and fogged out). Stars now ring the horizon, unfogged, and a dark ground plane with a radial glow extends the floor beyond the arena — ultrawide and portrait both read as a coherent scene now.
- Portrait HUD wrapped mid-text ("Best —" and the boost line broke onto their own lines). The three HUD groups now stack as a column under 700px.
- Render-check lesson: under swiftshader the sim runs at ~10–20% of real time (5-step/frame cap), so the boost-drain assertion now checks the drain *rate* against sim time (~30/s) instead of a wall-clock drop. The material-array change also taught the trail `dispose()` to dispose both materials, not `mat.dispose()`.

Local suite: smoke 111/111, bot gates all pass (decision bot clears all 3 arenas on seeds 0–4, traps every rival; hold-straight / fixed-rhythm / no-input / random bots lose on all 3), render-check PASS (zero console errors, autopilot clears arena 1 live in 9.52s with score 3005 — identical to the Node sim, confirming determinism; screen-space turn offset −20 → −52).

M1 is NOT done until the 14:30 run's live real-browser FUN playtest says GO — repo creation + browser upload + live playtest belong to that run.
