// Neon Cycle v0.1.0 — headless browser render check.
// Serves the game dir over local HTTP, loads it in a headless
// browser, and asserts the M1 core, by hook and by eye:
//   - the menu renders over a LIVE 3D scene (the attract demo
//     actually rides — the demo run advances), with no
//     version/engine text anywhere the player can see, one clear
//     primary Play action, and 3 arena cards (arena 1 unlocked,
//     arenas 2-3 locked on a fresh save)
//   - Play starts arena 1 with the HUD; the rider starts at the
//     start speed with a full boost meter
//   - turning is asserted in SCREEN space: ArrowLeft moves the
//     rider LEFT on screen relative to the arena centre (the Drift
//     M2 lesson — a mirrored input bug survived every world-space test)
//   - Space TOGGLES boost (never a hold): boost switches on, the
//     speed rises, the meter drains; Space again switches it off
//   - the autopilot (decision bot) clears arena 1 in the real browser
//   - with no input the rider crashes into the arena edge and the
//     run ends
//   - pause focuses Resume; Enter resumes; R restarts
//   - shake 0 suppresses trauma; the rest state settles clean
//     (trauma 0, FOV 62, time scale 1)
//   - ?arena=2 reaches arena 2 and ?arena=3 reaches arena 3 (public unlock/seed path — Apex lesson)
//   - the canvas pixels actually change during a run
//   - the FPS guard is present and steps the render scale down on demand
//   - zero console errors and zero page errors, and a WebGL context exists
//
// Run: node tests/render-check.js
//
// CDN note: the repo pins Three.js 0.160.0 from jsdelivr and does NOT
// vendor it. The sandboxed browser cannot reach the jsdelivr CDN (the VM
// egress proxy answers policy_denied to every non-curl/wget client,
// including Chromium), even though curl gets HTTP 200 for the pinned
// URL from this VM. So this check downloads the pinned module with
// curl into the OS temp dir and fulfils that one request locally via
// page.route. The shipped game still loads Three.js from the CDN.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';

const GAME_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS_DIR = path.join(os.tmpdir(), 'neon-cycle-render-check');
const THREE_URL = 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';
const THREE_CACHE = path.join(os.tmpdir(), 'neon-cycle-three-0.160.0.module.js');

async function fetchThreeModule() {
  try {
    const st = fs.statSync(THREE_CACHE);
    if (st.size > 100000) return THREE_CACHE;
  } catch { /* not cached yet */ }
  await new Promise((resolve, reject) => {
    execFile('curl', ['-s', '-o', THREE_CACHE, THREE_URL], (err) => (err ? reject(err) : resolve()));
  });
  const st = fs.statSync(THREE_CACHE);
  if (st.size < 100000) throw new Error(`downloaded Three.js module is unexpectedly small (${st.size} bytes)`);
  return THREE_CACHE;
}

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

function findHeadlessShell() {
  const base = path.join(os.homedir(), '.cache', 'ms-playwright');
  try {
    for (const entry of fs.readdirSync(base)) {
      const candidate = path.join(base, entry, 'chrome-headless-shell-linux64', 'chrome-headless-shell');
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch { /* cache dir missing */ }
  return null;
}

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const file = path.join(GAME_DIR, urlPath === '/' ? 'index.html' : urlPath);
  if (!file.startsWith(GAME_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

const require = createRequire(import.meta.url);
const playwrightPath = fileURLToPath(new URL('../../neon-hexfall/node_modules/playwright-core', import.meta.url));
const { chromium } = require(playwrightPath);
const executablePath = findHeadlessShell();
console.log('render-check: chromium executable:', executablePath || '(playwright default)');

const errors = [];
const T0 = Date.now();
const stamp = () => ((Date.now() - T0) / 1000).toFixed(1) + 's';
let browser;
try {
  browser = await chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    timezoneId: 'Asia/Bangkok',
    hasTouch: true,
  });
  const page = await context.newPage();
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(stamp() + ' console: ' + msg.text()); });
  page.on('pageerror', (err) => errors.push(stamp() + ' pageerror: ' + String(err)));

  if (!process.env.NO_THREE_CACHE) {
    const cached = await fetchThreeModule();
    console.log(`render-check: fulfilling pinned three@0.160.0 from local curl cache (${cached}) — sandboxed browser cannot reach jsdelivr directly`);
    await page.route(THREE_URL, (route) => route.fulfill({ path: cached }));
  }

  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });

  try {
    await page.waitForFunction(() => window.__cycle, null, { timeout: 30000 });
  } catch {
    console.error('render-check: window.__cycle never appeared — the pinned Three.js module failed to load.');
    console.error('CDN check from this VM: curl -sI ' + THREE_URL + ' (expect HTTP 200).');
    throw new Error('game module did not initialise (see CDN note above)');
  }

  const version = await page.evaluate(() => window.__cycle.version);
  if (version !== '0.1.0') throw new Error(`expected version 0.1.0, got ${version}`);
  console.log('render-check: game module initialised, version 0.1.0');

  // WebGL context exists and the canvas is on screen.
  const gl = await page.evaluate(() => {
    const canvas = document.querySelector('#game-container canvas');
    if (!canvas) return null;
    const ctx = canvas.getContext('webgl2') || canvas.getContext('webgl');
    return ctx ? { width: canvas.width, height: canvas.height } : null;
  });
  if (!gl) throw new Error('no WebGL context on the game canvas');
  console.log(`render-check: WebGL context live (${gl.width}x${gl.height} canvas)`);

  // The FPS guard is present (rolling FPS average, one-way DPR
  // ladder 2 → 1.5 → 1 + reduced particle spawn). The manual trigger
  // steps the cap down one rung and the renderer keeps working.
  const guard0 = await page.evaluate(() => window.__cycle.info().fpsGuard);
  if (!guard0 || ![2, 1.5, 1].includes(guard0.dprCap)) throw new Error(`FPS guard state missing or bad dprCap: ${JSON.stringify(guard0)}`);
  if (!(guard0.pixelRatio >= 1 && guard0.pixelRatio <= 2)) throw new Error(`FPS guard pixel ratio out of range: ${guard0.pixelRatio}`);
  if (!(guard0.particleScale > 0 && guard0.particleScale <= 1)) throw new Error(`FPS guard particle scale out of range: ${guard0.particleScale}`);
  await page.evaluate(() => window.__cycle.triggerFpsGuard());
  const guard1 = await page.evaluate(() => window.__cycle.info().fpsGuard);
  if (guard1.dprCap > guard0.dprCap) throw new Error(`triggerFpsGuard must not raise the cap (${guard0.dprCap} -> ${guard1.dprCap})`);
  if (guard0.dprCap > 1 && guard1.dprCap >= guard0.dprCap) throw new Error(`triggerFpsGuard should step the cap down (${guard0.dprCap} -> ${guard1.dprCap})`);
  if (guard1.particleScale > guard0.particleScale) throw new Error('FPS guard should reduce particle spawn when stepping down');
  const fpsVal = await page.evaluate(() => window.__cycle.info().fps);
  if (!Number.isFinite(fpsVal) || fpsVal < 0) throw new Error(`FPS guard should report a sane fps, got ${fpsVal}`);
  console.log(`render-check: FPS guard present (dprCap ${guard0.dprCap} -> ${guard1.dprCap}, pixelRatio ${guard1.pixelRatio}, particleScale ${guard1.particleScale}, fps ${fpsVal})`);

  // The menu: title, one primary Play, 3 arena cards, NO version/engine
  // text anywhere the player can see. Arena 1 unlocked, arenas 2-3 locked.
  const menuText = await page.textContent('#menu');
  if (!menuText.includes('NEON CYCLE')) throw new Error('menu title missing');
  if (menuText.includes('v0.1.0') || menuText.includes('Three.js') || menuText.includes('0.160.0')) {
    throw new Error('menu shows version/engine text — it must live in the README only');
  }
  const playClass = await page.getAttribute('#btn-play', 'class');
  if (!playClass || !playClass.includes('primary')) throw new Error('Play is not the primary action');
  const arenaCards = await page.locator('#arena-select .track-card').count();
  if (arenaCards !== 3) throw new Error(`expected 3 arena cards, got ${arenaCards}`);
  const arenas = await page.evaluate(() => window.__cycle.arenas.map((a) => a.name));
  if (arenas.length !== 3 || arenas[0] !== 'First Grid' || arenas[2] !== 'The Gauntlet') {
    throw new Error(`arena list wrong: ${JSON.stringify(arenas)}`);
  }
  const unlocked = await page.evaluate(() => window.__cycle.save.unlocked);
  if (unlocked !== 1) throw new Error(`fresh save should unlock only arena 1, got ${unlocked}`);
  const lockedCards = await page.locator('#arena-select .track-card:disabled').count();
  if (lockedCards !== 2) throw new Error(`expected 2 locked arena cards on a fresh save, got ${lockedCards}`);
  console.log('render-check: menu renders — live 3D behind it, no version text, Play primary, 3 arenas, arena 1 unlocked only');

  // The accessibility toggles work and restore cleanly.
  await page.click('#btn-settings');
  await page.waitForFunction(() => !document.getElementById('settings').classList.contains('hidden'), null, { timeout: 5000 });
  await page.check('#reduce-flashing');
  const flashOff = await page.evaluate(() => window.__cycle.state.flash);
  if (flashOff !== false) throw new Error('reduce-flashing should turn state.flash off');
  // The Settings panel shows a live performance readout (fps +
  // FPS-guard render scale) — real state, not empty space.
  const perfLine = await page.textContent('#perf-line');
  if (!/^Performance: \d+ fps · render scale [\d.]+×/.test(perfLine.trim())) throw new Error(`settings performance line wrong: ${perfLine}`);
  await page.selectOption('#text-size-select', '1.2');
  const fsLarge = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
  if (!(fsLarge > 16)) throw new Error(`text size Large should grow the root font, got ${fsLarge}px`);
  await page.check('#high-contrast-toggle');
  const hc = await page.evaluate(() => document.body.classList.contains('high-contrast'));
  if (!hc) throw new Error('high-contrast toggle should add the high-contrast class');
  await page.uncheck('#reduce-flashing');
  await page.selectOption('#text-size-select', '1');
  await page.uncheck('#high-contrast-toggle');
  const flashBack = await page.evaluate(() => window.__cycle.state.flash);
  if (flashBack !== true) throw new Error('unchecking reduce-flashing should restore flash');
  const fsBack = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
  if (Math.abs(fsBack - 16) > 0.5) throw new Error(`text size should restore to 16px, got ${fsBack}px`);
  const hcBack = await page.evaluate(() => document.body.classList.contains('high-contrast'));
  if (hcBack) throw new Error('high-contrast toggle should remove the class when unchecked');
  await page.click('#btn-settings-close');
  await page.waitForFunction(() => document.getElementById('settings').classList.contains('hidden'), null, { timeout: 5000 });
  console.log('render-check: accessibility toggles work — reduce-flashing, text size, high contrast, all restored');

  // The attract demo rides behind the menu: the demo run advances.
  const demo0 = await page.evaluate(() => window.__cycle.info());
  if (!demo0) throw new Error('no demo info in the menu phase');
  await page.waitForFunction((t0) => {
    const i = window.__cycle.info();
    return i && i.time > t0 + 5;
  }, demo0.time, { timeout: 60000 });
  const demo1 = await page.evaluate(() => window.__cycle.info());
  console.log(`render-check: attract demo alive — demo rider riding (t ${demo0.time.toFixed(1)} -> ${demo1.time.toFixed(1)}, traps ${demo1.traps})`);

  // Menu screenshot for the by-eye check.
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(SHOTS_DIR, 'menu-1280x720.png'), timeout: 60000 });
  console.log(`render-check: menu screenshot saved to ${SHOTS_DIR}/menu-1280x720.png — INSPECT BY EYE (live 3D scene, no clipped cards)`);

  // PLAY starts arena 1 with the HUD; the rider starts at the start speed with a full boost meter.
  await page.click('#btn-play');
  await page.waitForFunction(() => window.__cycle.phase === 'playing', null, { timeout: 5000 });
  if (!await page.isVisible('#hud')) throw new Error('HUD not visible after PLAY');
  const hudArena = await page.textContent('#hud-arena');
  if (!hudArena.includes('First Grid')) throw new Error(`expected arena 1 First Grid, got: ${hudArena}`);
  const hudTraps = await page.textContent('#hud-traps');
  if (!/^Traps 0\/1$/.test(hudTraps.trim())) throw new Error(`HUD traps should be "Traps 0/1", got: ${hudTraps}`);
  const startInfo = await page.evaluate(() => window.__cycle.info());
  if (Math.abs(startInfo.speed - 6) > 0.5) throw new Error(`rider should start at the start speed 6, got ${startInfo.speed}`);
  if (startInfo.boost !== 100) throw new Error(`rider should start with a full boost meter, got ${startInfo.boost}`);
  console.log('render-check: PLAY starts arena 1 (First Grid), HUD visible, rider riding at start speed, boost meter full');

  // The generative music starts with the arena.
  const musicActive = await page.evaluate(() => window.__cycle.state.musicActive);
  if (!musicActive) throw new Error('music should be active after Play');
  console.log('render-check: generative music active after Play');

  // Turning is asserted in SCREEN space: ArrowLeft must move the
  // rider LEFT on screen relative to the arena centre. The camera
  // follows the player, so the raw screen x barely moves — the
  // rider-vs-centre offset is the real screen-space signal.
  // The rider starts heading east with a long runway; one left turn
  // swings the chase camera north and the arena centre slides right.
  const relX0 = await page.evaluate(() => {
    const i = window.__cycle.info();
    return i.screen.x - i.centreScreen.x;
  });
  const turns0 = await page.evaluate(() => window.__cycle.info().turns);
  await page.keyboard.press('ArrowLeft');
  await page.waitForFunction((t0) => window.__cycle.info().turns > t0, turns0, { timeout: 10000 });
  try {
    await page.waitForFunction((x0) => {
      const i = window.__cycle.info();
      return i && (i.screen.x - i.centreScreen.x) < x0 - 20;
    }, relX0, { timeout: 10000 });
  } catch {
    const relX1 = await page.evaluate(() => {
      const i = window.__cycle.info();
      return i.screen.x - i.centreScreen.x;
    });
    throw new Error(`ArrowLeft should move the rider left on screen vs the arena centre (offset ${relX0.toFixed(0)} -> ${relX1.toFixed(0)})`);
  }
  const relX1 = await page.evaluate(() => {
    const i = window.__cycle.info();
    return i.screen.x - i.centreScreen.x;
  });
  console.log(`render-check: ArrowLeft turns the rider left on screen vs the arena centre (offset ${relX0.toFixed(0)} -> ${relX1.toFixed(0)})`);

  // Boost is a TOGGLE, never a hold: one Space press switches it on
  // (speed rises, meter drains), a second press switches it off.
  // Restart first so the rider has a long runway ahead.
  await page.keyboard.press('KeyR');
  await page.waitForTimeout(500);
  const boostOff0 = await page.evaluate(() => window.__cycle.info().boostOn);
  if (boostOff0) throw new Error('boost should start off');
  await page.keyboard.press('Space');
  await page.waitForFunction(() => window.__cycle.info().boostOn === true, null, { timeout: 5000 });
  const boostInfo = await page.evaluate(() => window.__cycle.info());
  if (boostInfo.speed < 8) throw new Error(`boost should raise the speed above 8, got ${boostInfo.speed}`);
  const boostStateOn = await page.textContent('#hud-boost-state');
  if (boostStateOn.trim() !== 'ON') throw new Error(`HUD boost state should read ON, got: ${boostStateOn}`);
  console.log(`render-check: Space toggles boost ON (speed ${boostInfo.speed}, meter ${boostInfo.boost})`);
  // The meter drains while boosting. Under swiftshader the headless
  // sim runs well below real time (the 5-step/frame cap), so assert
  // the drain RATE against sim time (30/s), not against wall time.
  const meter0 = boostInfo.boost;
  const time0 = boostInfo.time;
  await page.waitForTimeout(2500);
  const drain = await page.evaluate(() => window.__cycle.info());
  const rate = (meter0 - drain.boost) / Math.max(0.01, drain.time - time0);
  if (rate < 20 || rate > 40) throw new Error(`boost meter should drain ~30/s of sim time, got ${rate.toFixed(1)}/s (${meter0} -> ${drain.boost} over ${(drain.time - time0).toFixed(2)}s sim)`);
  const meter1 = drain.boost;
  // The meter must actually RENDER, not just carry a width.
  const meterVisible = await page.evaluate(() => {
    const el = document.getElementById('hud-boost-fill');
    const cs = getComputedStyle(el);
    return { h: el.getBoundingClientRect().height, bg: cs.backgroundImage, color: cs.backgroundColor, w: el.style.width };
  });
  if (meterVisible.h <= 0) throw new Error(`BOOST meter fill must have height, got ${meterVisible.h}`);
  if (meterVisible.bg === 'none' && (meterVisible.color === 'rgba(0, 0, 0, 0)' || meterVisible.color === 'transparent')) {
    throw new Error('BOOST meter fill must have a visible background');
  }
  if (!meterVisible.w || parseFloat(meterVisible.w) <= 0) throw new Error(`BOOST meter should show energy, fill width is ${meterVisible.w}`);
  console.log(`render-check: BOOST meter drains (${meter0} -> ${meter1}) and renders (fill ${meterVisible.w})`);
  await page.keyboard.press('Space');
  await page.waitForFunction(() => window.__cycle.info().boostOn === false, null, { timeout: 5000 });
  const boostStateOff = await page.textContent('#hud-boost-state');
  if (boostStateOff.trim() !== 'OFF') throw new Error(`HUD boost state should read OFF, got: ${boostStateOff}`);
  console.log('render-check: Space toggles boost OFF again (a toggle, never a hold)');

  // Shake 0 suppresses trauma: turn while shake is 0, trauma stays 0.
  await page.evaluate(() => window.__cycle.setShake(0));
  await page.waitForFunction(() => window.__cycle.info().trauma === 0, null, { timeout: 30000 });
  const turns1 = await page.evaluate(() => window.__cycle.info().turns);
  await page.keyboard.press('ArrowLeft');
  await page.waitForFunction((t0) => window.__cycle.info().turns > t0, turns1, { timeout: 10000 });
  await page.waitForTimeout(500);
  const trauma0 = await page.evaluate(() => window.__cycle.info().trauma);
  if (trauma0 !== 0) throw new Error(`shake 0 should suppress trauma, got ${trauma0}`);
  await page.evaluate(() => window.__cycle.setShake(100));
  console.log('render-check: shake 0 suppresses trauma (0 after a turn)');

  // The autopilot (decision bot) clears arena 1 in the real browser.
  await page.keyboard.press('KeyR');
  await page.waitForTimeout(500);
  await page.evaluate(() => window.__cycle.autopilot(true));
  await page.waitForFunction(() => window.__cycle.phase === 'complete', null, { timeout: 240000 });
  const clearInfo = await page.evaluate(() => window.__cycle.info());
  console.log(`render-check: autopilot cleared arena 1 live (score ${clearInfo.score}, time ${clearInfo.time}s, traps ${clearInfo.traps}, turns ${clearInfo.turns})`);
  if (clearInfo.traps < 1) throw new Error(`autopilot should have trapped the rival, got ${clearInfo.traps}`);
  if (!await page.isVisible('#complete')) throw new Error('complete screen not visible after the clear');
  const completeText = await page.textContent('#complete');
  if (!completeText.includes('Arena Cleared')) throw new Error('complete screen title wrong');
  console.log('render-check: Arena Cleared screen shows with score + rank');

  // Back to the menu, then start arena 1 again with NO input: the
  // rider crashes into the arena edge and the run ends.
  // The arena-1 card shows the rank badge earned by the clear.
  await page.click('#btn-menu-complete');
  await page.waitForFunction(() => window.__cycle.phase === 'menu', null, { timeout: 5000 });
  const rankBadge = await page.locator('#arena-select .track-card').first().locator('.tc-rank').textContent().catch(() => null);
  if (!rankBadge || !/^[SAB]$/.test(rankBadge.trim())) throw new Error(`arena-1 card should show a rank badge after the clear, got: ${rankBadge}`);
  const savedRank = await page.evaluate(() => window.__cycle.save.best[1] && window.__cycle.save.best[1].rank);
  console.log(`render-check: arena-1 card shows rank badge "${rankBadge.trim()}" (saved rank ${savedRank})`);
  await page.click('#btn-play');
  await page.waitForFunction(() => window.__cycle.phase === 'playing', null, { timeout: 5000 });
  await page.waitForFunction(() => window.__cycle.phase === 'gameover', null, { timeout: 60000 });
  if (!await page.isVisible('#gameover')) throw new Error('game-over screen not visible after the no-input crash');
  const overDetail = await page.textContent('#gameover-detail');
  if (!/arena edge/.test(overDetail)) throw new Error(`game-over should name the arena edge, got: ${overDetail}`);
  console.log('render-check: no-input rider crashes into the arena edge — Crashed Out screen shows');

  // Pause focuses Resume; Enter resumes; R restarts.
  await page.click('#btn-retry');
  await page.waitForFunction(() => window.__cycle.phase === 'playing', null, { timeout: 5000 });
  await page.keyboard.press('KeyP');
  await page.waitForFunction(() => window.__cycle.phase === 'paused', null, { timeout: 5000 });
  if (!await page.isVisible('#pause')) throw new Error('pause screen not visible');
  const focused = await page.evaluate(() => document.activeElement && document.activeElement.id);
  if (focused !== 'btn-resume') throw new Error(`pause should focus Resume, focused ${focused}`);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__cycle.phase === 'playing', null, { timeout: 5000 });
  console.log('render-check: pause focuses Resume, Enter resumes');
  await page.keyboard.press('KeyR');
  await page.waitForTimeout(500);
  const afterRestart = await page.evaluate(() => window.__cycle.info());
  if (afterRestart.time > 2 || afterRestart.traps !== 0) throw new Error(`R should restart the arena (time ${afterRestart.time}, traps ${afterRestart.traps})`);
  console.log('render-check: R restarts the arena');

  // The canvas must actually update during a run.
  const shotA = await page.screenshot({ timeout: 60000 });
  await page.waitForTimeout(1000);
  const shotB = await page.screenshot({ timeout: 60000 });
  if (shotA.equals(shotB)) throw new Error('canvas did not change between two screenshots during a run — the render loop may be frozen');
  console.log('render-check: canvas updates during a run (two screenshots differ)');

  // Gameplay screenshot for the by-eye check.
  await page.evaluate(() => window.__cycle.autopilot(true));
  await page.waitForTimeout(3000);
  await page.screenshot({ path: path.join(SHOTS_DIR, 'gameplay-1280x720.png'), timeout: 60000 });
  console.log(`render-check: gameplay screenshot saved to ${SHOTS_DIR}/gameplay-1280x720.png — INSPECT BY EYE (3D depth, grid, trails, HUD)`);
  await page.evaluate(() => window.__cycle.autopilot(false));

  // Rest state settles clean (trauma 0, FOV 62, time scale 1).
  await page.evaluate(() => window.__cycle.quitToMenu());
  await page.waitForTimeout(1500);
  const rest = await page.evaluate(() => window.__cycle.info());
  if (rest.trauma !== 0) throw new Error(`rest state trauma should be 0, got ${rest.trauma}`);
  if (Math.abs(rest.fov - 62) > 0.5) throw new Error(`rest state FOV should be 62, got ${rest.fov}`);
  if (rest.timeScale !== 1) throw new Error(`rest state timeScale should be 1, got ${rest.timeScale}`);
  console.log('render-check: rest state clean (trauma 0, FOV 62, timeScale 1)');

  // ?arena=2 reaches arena 2 (public unlock/seed path — Apex lesson).
  await page.goto(`http://127.0.0.1:${port}/?arena=2`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => window.__cycle && window.__cycle.phase === 'playing', null, { timeout: 30000 });
  const arena2 = await page.evaluate(() => window.__cycle.info());
  if (arena2.arenaId !== 2) throw new Error(`?arena=2 should start arena 2, got ${arena2.arenaId}`);
  const arena2Name = await page.textContent('#hud-arena');
  if (!arena2Name.includes('Crossroads')) throw new Error(`?arena=2 should start Crossroads, got: ${arena2Name}`);
  console.log('render-check: ?arena=2 jumps straight into Crossroads (unlock path works)');

  // ?arena=3 reaches the last arena (The Gauntlet).
  await page.goto(`http://127.0.0.1:${port}/?arena=3`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => window.__cycle && window.__cycle.phase === 'playing', null, { timeout: 30000 });
  const arena3 = await page.evaluate(() => window.__cycle.info());
  if (arena3.arenaId !== 3) throw new Error(`?arena=3 should start arena 3, got ${arena3.arenaId}`);
  const arena3Name = await page.textContent('#hud-arena');
  if (!arena3Name.includes('The Gauntlet')) throw new Error(`?arena=3 should start The Gauntlet, got: ${arena3Name}`);
  console.log('render-check: ?arena=3 jumps straight into The Gauntlet (unlock path reaches the last arena)');

  // Regression: Try Again after losing a deep-linked LOCKED arena.
  // The retry button must restart the arena you are already in — the
  // lock gates menu entry only. Also asserts the game-over detail
  // never goes negative and the trap toast is cleared on run end.
  await page.evaluate(() => {
    const run = window.__cycle.run;
    // Drive the player into the nearest wall: hold a straight line.
    run.player.dir = { x: 1, y: 0 };
  });
  await page.waitForFunction(() => window.__cycle.phase === 'gameover', null, { timeout: 60000 });
  if (!await page.isVisible('#gameover')) throw new Error('game-over screen not visible after the forced loss on arena 3');
  const toastHidden = await page.evaluate(() => !document.getElementById('hud-toast').classList.contains('show'));
  if (!toastHidden) throw new Error('toast must be cleared when the run ends');
  await page.click('#btn-retry');
  await page.waitForFunction(() => window.__cycle.phase === 'playing', null, { timeout: 5000 });
  const retryInfo = await page.evaluate(() => window.__cycle.info());
  if (retryInfo.arenaId !== 3 || retryInfo.traps !== 0) throw new Error(`Try Again should restart arena 3 fresh, got ${JSON.stringify({ id: retryInfo.arenaId, traps: retryInfo.traps })}`);
  console.log('render-check: Try Again restarts a deep-linked locked arena (retry bypasses the menu lock); toast cleared');

  // Regression: the endRun setTimeout race. Losing an arena schedules
  // endRun ~900ms later; quitting to the menu inside that window must
  // cancel the timer — the game-over panel must not open over the menu.
  await page.evaluate(() => {
    const run = window.__cycle.run;
    run.player.x = run.arena.cols - 0.6;
    run.player.y = 9.5;
    run.player.dir = { x: 1, y: 0 };
    run.player.cellC = run.arena.cols - 1;
    run.player.cellR = 9;
  });
  await page.waitForFunction(() => window.__cycle.run && window.__cycle.run.phase === 'lost', null, { timeout: 60000, polling: 50 });
  const timerPending = await page.evaluate(() => window.__cycle.info().endTimerPending);
  if (!timerPending) throw new Error('expected a pending endRun timer right after the loss');
  await page.evaluate(() => window.__cycle.quitToMenu());
  // The toast must be fully hidden the moment the menu opens, with no wait.
  const toastOpacity = await page.evaluate(() => getComputedStyle(document.getElementById('hud-toast')).opacity);
  if (toastOpacity !== '0') throw new Error(`toast must be fully hidden the moment the menu opens, opacity is ${toastOpacity}`);
  const timerCleared = await page.evaluate(() => window.__cycle.info().endTimerPending);
  if (timerCleared) throw new Error('quitToMenu should clear the pending endRun timer');
  await page.waitForTimeout(1500);
  const afterQuit = await page.evaluate(() => window.__cycle.info());
  if (afterQuit.phase !== 'menu') throw new Error(`after quitting inside the loss window the phase should be menu, got ${afterQuit.phase}`);
  if (await page.isVisible('#gameover')) throw new Error('game-over panel opened over the menu after quitting inside the loss window');
  console.log('render-check: endRun race fixed — quitting inside the loss window leaves the menu clean (timer cleared, no game-over panel)');

  if (errors.length > 0) {
    console.error('render-check: console/page errors seen:');
    errors.forEach((e) => console.error('  ' + e));
    throw new Error(`${errors.length} console/page error(s) during the check`);
  }
  console.log('render-check: PASS — zero console errors, zero page errors');
} catch (err) {
  console.error('render-check: FAIL —', err.message);
  if (errors.length > 0) errors.forEach((e) => console.error('  ' + e));
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  server.close();
}
