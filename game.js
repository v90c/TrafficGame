(() => {
  'use strict';

  // ---------- Logical coordinate space (canvas is scaled to fit any screen) ----------
  const LW = 480;   // logical width
  const LH = 720;   // logical height
  const ROAD_MARGIN = 40;
  const ROAD_WIDTH = LW - ROAD_MARGIN * 2;
  const LANE_COUNT = 4;
  const LANE_WIDTH = ROAD_WIDTH / LANE_COUNT;
  const PLAYER_Y = LH - 170;

  function laneX(i) {
    return ROAD_MARGIN + LANE_WIDTH * i + LANE_WIDTH / 2;
  }

  // ---------- Difficulty presets ----------
  const DIFFICULTIES = {
    easy: {
      label: 'easy',
      baseSpeed: 240,      // px/sec closing speed of traffic toward player
      speedRamp: 3.0,       // px/sec added per second survived
      maxSpeed: 480,
      spawnInterval: 1050,  // ms between spawn waves
      minSpawnInterval: 620,
      spawnRampMs: 4,       // interval shrinks this many ms per second survived
      maxSimultaneous: 1,
      laneGapPx: 320,       // min vertical gap between cars in same lane
    },
    medium: {
      label: 'medium',
      baseSpeed: 330,
      speedRamp: 4.2,
      maxSpeed: 620,
      spawnInterval: 780,
      minSpawnInterval: 430,
      spawnRampMs: 5,
      maxSimultaneous: 2,
      laneGapPx: 280,
    },
    fast: {
      label: 'fast',
      baseSpeed: 430,
      speedRamp: 6,
      maxSpeed: 800,
      spawnInterval: 560,
      minSpawnInterval: 300,
      spawnRampMs: 6,
      maxSimultaneous: 2,
      laneGapPx: 250,
    },
  };

  const CAR_TYPES = [
    { key: 'sedan', w: 44, h: 74, speedMul: 1.0, weight: 5 },
    { key: 'suv',   w: 50, h: 82, speedMul: 0.9, weight: 3 },
    { key: 'truck', w: 48, h: 116, speedMul: 0.78, weight: 2 },
    { key: 'sport', w: 40, h: 68, speedMul: 1.2, weight: 2 },
    { key: 'moto',  w: 20, h: 52, speedMul: 1.35, weight: 2 },
  ];

  const TRAFFIC_COLORS = ['#e94f4f', '#4f8ce9', '#e9a94f', '#8a5fd6', '#d6d6d6', '#4f4f4f', '#e94f9d', '#5fd68a'];
  const PLAYER_COLOR = '#3ecfff';

  // ---------- Speed humps (non-fatal hazard: jolt + brief slowdown, not a crash) ----------
  const HUMP_H = 20;

  // ---------- Lane squeeze events (random temporary lane closures) ----------
  // Always keep the two center lanes open so the road narrows symmetrically
  // toward the middle instead of shifting left or right.
  const SQUEEZE_OPEN_LANES = [1, 2];

  // ---------- Audio (synthesized with Web Audio API, no external assets) ----------
  const Sound = (() => {
    let ctx = null;
    let masterGain = null;
    let engineOsc = null, engineGain = null, engineFilter = null;
    let muted = localStorage.getItem('laneDodger_muted') === '1';

    function ensureCtx() {
      if (!ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        ctx = new AC();
        masterGain = ctx.createGain();
        masterGain.gain.value = muted ? 0 : 0.8;
        masterGain.connect(ctx.destination);
      }
      if (ctx.state === 'suspended') ctx.resume();
      return ctx;
    }

    function isMuted() { return muted; }

    function setMuted(val) {
      muted = val;
      localStorage.setItem('laneDodger_muted', muted ? '1' : '0');
      if (masterGain) masterGain.gain.setTargetAtTime(muted ? 0 : 0.8, ctx.currentTime, 0.05);
    }

    function toggleMuted() { setMuted(!muted); return muted; }

    function blip({ freq = 440, duration = 0.12, type = 'sine', gainPeak = 0.3, freqEnd = null, delay = 0 }) {
      const c = ensureCtx();
      if (!c) return;
      const t0 = c.currentTime + delay;
      const osc = c.createOscillator();
      const g = c.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t0);
      if (freqEnd !== null) osc.frequency.exponentialRampToValueAtTime(Math.max(1, freqEnd), t0 + duration);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(gainPeak, t0 + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
      osc.connect(g);
      g.connect(masterGain);
      osc.start(t0);
      osc.stop(t0 + duration + 0.02);
    }

    function noiseBurst({ duration = 0.3, gainPeak = 0.5, delay = 0, filterFreq = 1200 }) {
      const c = ensureCtx();
      if (!c) return;
      const t0 = c.currentTime + delay;
      const bufferSize = Math.max(1, Math.floor(c.sampleRate * duration));
      const buffer = c.createBuffer(1, bufferSize, c.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;
      const noise = c.createBufferSource();
      noise.buffer = buffer;
      const filter = c.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = filterFreq;
      const g = c.createGain();
      g.gain.setValueAtTime(gainPeak, t0);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + duration);
      noise.connect(filter);
      filter.connect(g);
      g.connect(masterGain);
      noise.start(t0);
      noise.stop(t0 + duration);
    }

    function laneSwitch() {
      blip({ freq: 520, freqEnd: 780, duration: 0.09, type: 'triangle', gainPeak: 0.16 });
    }

    function nearMiss() {
      blip({ freq: 700, freqEnd: 1100, duration: 0.14, type: 'sine', gainPeak: 0.2 });
    }

    function uiClick() {
      blip({ freq: 340, duration: 0.05, type: 'square', gainPeak: 0.1 });
    }

    function countdownBeep(isFinal) {
      blip({ freq: isFinal ? 880 : 440, duration: isFinal ? 0.35 : 0.15, type: 'square', gainPeak: 0.22 });
    }

    function crash() {
      noiseBurst({ duration: 0.5, gainPeak: 0.55, filterFreq: 900 });
      blip({ freq: 140, freqEnd: 40, duration: 0.4, type: 'sawtooth', gainPeak: 0.35, delay: 0.02 });
    }

    function bump() {
      blip({ freq: 95, freqEnd: 50, duration: 0.12, type: 'sine', gainPeak: 0.32 });
      noiseBurst({ duration: 0.08, gainPeak: 0.22, filterFreq: 500 });
      blip({ freq: 300, freqEnd: 650, duration: 0.18, type: 'triangle', gainPeak: 0.14, delay: 0.02 });
    }

    function startEngine() {
      const c = ensureCtx();
      if (!c || engineOsc) return;
      engineOsc = c.createOscillator();
      engineOsc.type = 'sawtooth';
      engineOsc.frequency.value = 55;
      engineFilter = c.createBiquadFilter();
      engineFilter.type = 'lowpass';
      engineFilter.frequency.value = 200;
      engineGain = c.createGain();
      engineGain.gain.value = 0.05;
      engineOsc.connect(engineFilter);
      engineFilter.connect(engineGain);
      engineGain.connect(masterGain);
      engineOsc.start();
    }

    function updateEngine(speedRatio) {
      if (!engineOsc || !ctx) return;
      const r = Math.max(0, Math.min(1.3, speedRatio));
      engineOsc.frequency.setTargetAtTime(55 + r * 60, ctx.currentTime, 0.15);
      engineFilter.frequency.setTargetAtTime(190 + r * 280, ctx.currentTime, 0.15);
    }

    function stopEngine() {
      if (!engineOsc) return;
      try { engineOsc.stop(); } catch (e) { /* already stopped */ }
      engineOsc.disconnect(); engineGain.disconnect(); engineFilter.disconnect();
      engineOsc = null; engineGain = null; engineFilter = null;
    }

    function pauseAll() { if (ctx && ctx.state === 'running') ctx.suspend(); }
    function resumeAll() { if (ctx && ctx.state === 'suspended') ctx.resume(); }

    return {
      ensureCtx, isMuted, setMuted, toggleMuted,
      laneSwitch, nearMiss, uiClick, countdownBeep, crash, bump,
      startEngine, updateEngine, stopEngine, pauseAll, resumeAll,
    };
  })();

  // ---------- DOM ----------
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const hud = document.getElementById('hud');
  const scoreValueEl = document.getElementById('scoreValue');
  const bestValueEl = document.getElementById('bestValue');
  const pauseBtn = document.getElementById('pauseBtn');
  const muteBtn = document.getElementById('muteBtn');

  const ICON_UNMUTED = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 10v4h4l5 5V5L7 10H3z"/><path d="M16.5 12c0-1.77-.77-3.29-2-4.24v8.48c1.23-.95 2-2.47 2-4.24z"/><path d="M14.5 3.23v2.06c2.89 1.02 5 3.76 5 6.71s-2.11 5.69-5 6.71v2.06c4.01-1.09 7-4.72 7-8.77s-2.99-7.68-7-8.77z"/></svg>';
  const ICON_MUTED = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 10v4h4l5 5V5L7 10H3z"/><path d="M19.5 12l2.1 2.1-1.4 1.4-2.1-2.1-2.1 2.1-1.4-1.4 2.1-2.1-2.1-2.1 1.4-1.4 2.1 2.1 2.1-2.1 1.4 1.4z"/></svg>';

  function updateMuteIcon() {
    muteBtn.innerHTML = Sound.isMuted() ? ICON_MUTED : ICON_UNMUTED;
    muteBtn.setAttribute('aria-label', Sound.isMuted() ? 'Unmute sound' : 'Mute sound');
  }

  const startScreen = document.getElementById('startScreen');
  const pauseScreen = document.getElementById('pauseScreen');
  const gameOverScreen = document.getElementById('gameOverScreen');

  const startBtn = document.getElementById('startBtn');
  const resumeBtn = document.getElementById('resumeBtn');
  const quitBtn = document.getElementById('quitBtn');
  const retryBtn = document.getElementById('retryBtn');
  const menuBtn = document.getElementById('menuBtn');

  const finalScoreEl = document.getElementById('finalScore');
  const finalBestEl = document.getElementById('finalBest');
  const finalDiffLabelEl = document.getElementById('finalDiffLabel');
  const newBestBadge = document.getElementById('newBestBadge');

  const diffButtons = Array.from(document.querySelectorAll('.diff-btn'));

  // ---------- Persistent state ----------
  let selectedDiff = 'medium';

  function bestKey(diff) { return `laneDodger_best_${diff}`; }
  function getBest(diff) { return Number(localStorage.getItem(bestKey(diff)) || 0); }
  function setBest(diff, val) { localStorage.setItem(bestKey(diff), String(val)); }

  // ---------- Game state ----------
  const STATE = { MENU: 'menu', COUNTDOWN: 'countdown', PLAYING: 'playing', PAUSED: 'paused', GAMEOVER: 'gameover' };
  let gameState = STATE.MENU;

  const COUNTDOWN_STEPS = ['3', '2', '1', 'GO'];
  const COUNTDOWN_STEP_TIME = 0.7;
  let countdownIndex = 0;
  let countdownElapsed = 0;

  let player, traffic, particles, popups;
  let elapsed = 0;
  let distance = 0;
  let spawnTimer = 0;
  let laneLastY = [];
  let shake = 0;
  let scrollY = 0;
  let sceneryScrollY = 0;
  let scenery = [];
  let rng = Math.random;

  // squeeze event state: 'idle' | 'active'
  let squeezeState = 'idle';
  let squeezeStateTimer = 0;
  let squeezeOpenLanes = [0, 1, 2, 3];
  let squeezeClosedLanes = [];
  let nextSqueezeAt = 0;
  let squeezeAnimMin = 0;            // animated (float) road-width bounds, eases toward
  let squeezeAnimMax = LANE_COUNT - 1; // the target open-lane range instead of snapping

  let humpTimer = 0;         // ms until next speed hump spawns
  let playerBounce = 0; // 0..1, decays after hitting a hump (jump/lift arc)

  function resetGame() {
    const cfg = DIFFICULTIES[selectedDiff];
    player = {
      lane: 1,
      x: laneX(1),
      targetLane: 1,
      w: 44,
      h: 76,
      tilt: 0,
    };
    traffic = [];
    particles = [];
    popups = [];
    elapsed = 0;
    distance = 0;
    spawnTimer = cfg.spawnInterval * 0.5;
    laneLastY = new Array(LANE_COUNT).fill(-9999);
    shake = 0;
    scrollY = 0;

    squeezeState = 'idle';
    squeezeStateTimer = 0;
    squeezeOpenLanes = [0, 1, 2, 3];
    squeezeClosedLanes = [];
    nextSqueezeAt = 10 + rng() * 8;
    squeezeAnimMin = 0;
    squeezeAnimMax = LANE_COUNT - 1;

    humpTimer = 2500 + rng() * 2000;
    playerBounce = 0;

    scenery = [];
    for (let i = 0; i < 15; i++) {
      const r = rng();
      const type = r < 0.4 ? 'tree' : r < 0.65 ? 'bush' : r < 0.85 ? 'sign' : 'rock';
      scenery.push({
        type,
        side: rng() < 0.5 ? -1 : 1,
        y: rng() * LH,
        size: 10 + rng() * 16,
        depth: 0.5 + rng() * 0.4,
        seed: rng(),
      });
    }
  }

  // ---------- Input ----------
  const keysDown = new Set();

  function shiftLane(delta) {
    if (gameState !== STATE.PLAYING) return;
    const [minLane, maxLane] = squeezeLaneBounds();
    const newLane = Math.max(minLane, Math.min(maxLane, player.targetLane + delta));
    if (newLane !== player.targetLane) {
      player.targetLane = newLane;
      Sound.laneSwitch();
    }
  }

  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    switch (e.key) {
      case 'ArrowLeft':
      case 'a':
      case 'A':
        shiftLane(-1);
        break;
      case 'ArrowRight':
      case 'd':
      case 'D':
        shiftLane(1);
        break;
      case 'p':
      case 'P':
      case 'Escape':
        togglePause();
        break;
    }
  });

  // Pointer / touch: tap left or right half, or swipe, to flick lanes.
  let pointerStartX = null;
  let pointerStartY = null;
  let pointerStartT = 0;
  let pointerActive = false;

  function getCanvasLogicalX(clientX) {
    const rect = canvas.getBoundingClientRect();
    return ((clientX - rect.left) / rect.width) * LW;
  }

  canvas.addEventListener('pointerdown', (e) => {
    pointerActive = true;
    pointerStartX = e.clientX;
    pointerStartY = e.clientY;
    pointerStartT = performance.now();
  });

  canvas.addEventListener('pointerup', (e) => {
    if (!pointerActive) return;
    pointerActive = false;
    const dx = e.clientX - pointerStartX;
    const dy = e.clientY - pointerStartY;
    const dt = performance.now() - pointerStartT;
    const rect = canvas.getBoundingClientRect();
    const laneWidthPx = rect.width / LANE_COUNT;

    if (gameState !== STATE.PLAYING) return;

    if (Math.abs(dx) < 12 && dt < 400) {
      // simple tap: move toward the tapped side
      const lx = getCanvasLogicalX(e.clientX);
      shiftLane(lx < player.x ? -1 : 1);
      return;
    }

    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 18) {
      const lanes = Math.max(1, Math.min(3, Math.round(Math.abs(dx) / laneWidthPx)));
      shiftLane(dx > 0 ? lanes : -lanes);
    }
  });

  canvas.addEventListener('pointercancel', () => { pointerActive = false; });

  // ---------- UI wiring ----------
  diffButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      Sound.ensureCtx();
      Sound.uiClick();
      diffButtons.forEach((b) => b.classList.remove('selected'));
      btn.classList.add('selected');
      selectedDiff = btn.dataset.diff;
    });
  });

  function showScreen(el) {
    [startScreen, pauseScreen, gameOverScreen].forEach((s) => s.classList.add('hidden'));
    if (el) el.classList.remove('hidden');
  }

  function startGame() {
    resetGame();
    gameState = STATE.COUNTDOWN;
    countdownIndex = 0;
    countdownElapsed = 0;
    showScreen(null);
    hud.classList.remove('hidden');
    pauseBtn.classList.add('hidden');
    bestValueEl.textContent = getBest(selectedDiff);
    Sound.ensureCtx();
    Sound.startEngine();
    Sound.countdownBeep(false);
  }

  function togglePause() {
    if (gameState === STATE.PLAYING) {
      gameState = STATE.PAUSED;
      showScreen(pauseScreen);
      Sound.pauseAll();
    } else if (gameState === STATE.PAUSED) {
      gameState = STATE.PLAYING;
      showScreen(null);
      Sound.resumeAll();
    }
  }

  function endGame() {
    gameState = STATE.GAMEOVER;
    hud.classList.add('hidden');
    pauseBtn.classList.add('hidden');
    Sound.stopEngine();
    const score = Math.floor(distance);
    const best = getBest(selectedDiff);
    const isNew = score > best;
    if (isNew) setBest(selectedDiff, score);

    finalScoreEl.textContent = score;
    finalBestEl.textContent = isNew ? score : best;
    finalDiffLabelEl.textContent = selectedDiff;
    newBestBadge.classList.toggle('hidden', !isNew);
    showScreen(gameOverScreen);
  }

  startBtn.addEventListener('click', () => { Sound.ensureCtx(); Sound.uiClick(); startGame(); });
  resumeBtn.addEventListener('click', () => { Sound.uiClick(); togglePause(); });
  pauseBtn.addEventListener('click', () => { Sound.uiClick(); togglePause(); });
  quitBtn.addEventListener('click', () => {
    Sound.uiClick();
    Sound.stopEngine();
    Sound.resumeAll();
    gameState = STATE.MENU;
    hud.classList.add('hidden');
    pauseBtn.classList.add('hidden');
    showScreen(startScreen);
  });
  retryBtn.addEventListener('click', () => { Sound.uiClick(); startGame(); });
  menuBtn.addEventListener('click', () => {
    Sound.uiClick();
    gameState = STATE.MENU;
    showScreen(startScreen);
  });
  muteBtn.addEventListener('click', () => {
    Sound.toggleMuted();
    updateMuteIcon();
  });

  // ---------- Spawning ----------
  function weightedCarType() {
    const total = CAR_TYPES.reduce((s, t) => s + t.weight, 0);
    let r = rng() * total;
    for (const t of CAR_TYPES) {
      if (r < t.weight) return t;
      r -= t.weight;
    }
    return CAR_TYPES[0];
  }

  function trySpawnWave(cfg, speed) {
    const allowedLanes = squeezeState === 'idle' ? [0, 1, 2, 3] : squeezeOpenLanes;
    const laneOrder = allowedLanes.slice().sort(() => rng() - 0.5);
    const maxToSpawn = Math.min(cfg.maxSimultaneous, Math.max(1, allowedLanes.length - 1)); // always leave >=1 lane open
    const howMany = 1 + Math.floor(rng() * maxToSpawn);
    let spawned = 0;

    for (const lane of laneOrder) {
      if (spawned >= howMany) break;
      const topY = laneLastY[lane];
      if (topY > -cfg.laneGapPx) continue; // not enough gap yet in this lane
      const type = weightedCarType();
      const y = -type.h - rng() * 60;
      traffic.push({
        key: type.key,
        lane,
        x: laneX(lane),
        y,
        w: type.w,
        h: type.h,
        color: TRAFFIC_COLORS[Math.floor(rng() * TRAFFIC_COLORS.length)],
        speedMul: type.speedMul,
        scored: false,
      });
      laneLastY[lane] = y;
      spawned++;
    }
  }

  function squeezeLaneBounds() {
    if (squeezeState === 'active') {
      return [Math.min(...squeezeOpenLanes), Math.max(...squeezeOpenLanes)];
    }
    return [0, LANE_COUNT - 1];
  }

  // ---------- Lane squeeze state machine (road itself narrows from 4 lanes to 2) ----------
  function updateSqueeze(dt) {
    if (squeezeState === 'idle') {
      if (elapsed >= nextSqueezeAt) {
        squeezeOpenLanes = SQUEEZE_OPEN_LANES;
        squeezeClosedLanes = [0, 1, 2, 3].filter((l) => !squeezeOpenLanes.includes(l));
        squeezeState = 'active';
        squeezeStateTimer = 6 + rng() * 3;

        // clear out any traffic now sitting on what just became grass
        traffic = traffic.filter((c) => !squeezeClosedLanes.includes(c.lane));

        // snap the player into the nearest surviving lane if theirs just closed
        if (!squeezeOpenLanes.includes(player.targetLane)) {
          player.targetLane = squeezeOpenLanes.reduce((a, b) =>
            Math.abs(b - player.targetLane) < Math.abs(a - player.targetLane) ? b : a
          );
        }
      }
      return;
    }

    if (squeezeState === 'active') {
      squeezeStateTimer -= dt;
      if (squeezeStateTimer <= 0) {
        squeezeState = 'idle';
        squeezeOpenLanes = [0, 1, 2, 3];
        squeezeClosedLanes = [];
        nextSqueezeAt = elapsed + 14 + rng() * 8;
      }
    }
  }

  // Eases the rendered road-width bounds toward the current target instead of
  // snapping, so the 4-to-2-lane (and back) change reads as a smooth narrowing.
  function updateSqueezeAnim(dt) {
    const [targetMin, targetMax] = squeezeLaneBounds();
    const lerpSpeed = 7;
    squeezeAnimMin += (targetMin - squeezeAnimMin) * Math.min(1, lerpSpeed * dt);
    squeezeAnimMax += (targetMax - squeezeAnimMax) * Math.min(1, lerpSpeed * dt);
    if (Math.abs(targetMin - squeezeAnimMin) < 0.01) squeezeAnimMin = targetMin;
    if (Math.abs(targetMax - squeezeAnimMax) < 0.01) squeezeAnimMax = targetMax;
  }

  // ---------- Update ----------
  function update(dt) {
    const cfg = DIFFICULTIES[selectedDiff];
    elapsed += dt;

    playerBounce = Math.max(0, playerBounce - dt * 2.2); // slower decay = a visible hang-time in the air
    const speed = Math.min(cfg.maxSpeed, cfg.baseSpeed + cfg.speedRamp * elapsed);
    const spawnInterval = Math.max(cfg.minSpawnInterval, cfg.spawnInterval - cfg.spawnRampMs * 1000 * (elapsed / 1000) * 0.06);

    Sound.updateEngine(speed / cfg.maxSpeed);
    updateSqueeze(dt);
    updateSqueezeAnim(dt);

    distance += (speed * dt) / 60;
    scrollY = (scrollY + speed * dt) % 9999;
    sceneryScrollY += speed * dt * 0.6;

    // player lane animation (smooth flick easing between lane centers)
    player.lane = player.targetLane;
    if (player._currentX === undefined) player._currentX = laneX(player.lane);
    const desiredX = laneX(player.targetLane);
    const lerpSpeed = 10; // higher = snappier flick
    player._currentX += (desiredX - player._currentX) * Math.min(1, lerpSpeed * dt);
    player.tilt = Math.max(-0.22, Math.min(0.22, (desiredX - player._currentX) * -0.012));
    player.x = player._currentX;

    // spawn
    spawnTimer -= dt * 1000;
    if (spawnTimer <= 0) {
      trySpawnWave(cfg, speed);
      spawnTimer = spawnInterval;
    }

    humpTimer -= dt * 1000;
    if (humpTimer <= 0) {
      const allowedLanes = squeezeState === 'idle' ? [0, 1, 2, 3] : squeezeOpenLanes;
      const lane = allowedLanes[Math.floor(rng() * allowedLanes.length)];
      traffic.push({
        key: 'hump',
        lane,
        x: laneX(lane),
        y: -HUMP_H - rng() * 40,
        w: LANE_WIDTH * 0.78,
        h: HUMP_H,
        speedMul: 1,
        scored: true, // humps don't trigger near-miss scoring
        hit: false,
      });
      humpTimer = 3200 + rng() * 2600;
    }

    // move traffic + collisions + near-miss scoring
    const pRect = {
      x: player.x - player.w * 0.36,
      y: PLAYER_Y - player.h * 0.42,
      w: player.w * 0.72,
      h: player.h * 0.84,
    };

    for (let i = traffic.length - 1; i >= 0; i--) {
      const c = traffic[i];
      c.y += speed * c.speedMul * dt;

      const cRect = {
        x: c.x - c.w * 0.36,
        y: c.y - c.h * 0.42,
        w: c.w * 0.72,
        h: c.h * 0.84,
      };

      const overlap = pRect.x < cRect.x + cRect.w && pRect.x + pRect.w > cRect.x &&
                       pRect.y < cRect.y + cRect.h && pRect.y + pRect.h > cRect.y;

      if (overlap && c.key === 'hump') {
        if (!c.hit) {
          c.hit = true;
          hitSpeedHump();
        }
      } else if (overlap) {
        crash();
        return;
      }

      // near miss bonus: car's center has just passed player's center, was close laterally
      if (!c.scored && c.y > PLAYER_Y) {
        c.scored = true;
        const lateralGap = Math.abs(c.x - player.x);
        if (c.lane !== player.lane && lateralGap < LANE_WIDTH * 1.15) {
          distance += 18;
          popups.push({ x: player.x, y: PLAYER_Y - 60, text: '+close call', life: 0.8, color: '#35d488' });
          Sound.nearMiss();
        }
      }

      if (c.y > LH + 150) {
        traffic.splice(i, 1);
      }
    }

    // refresh laneLastY snapshot (topmost y per lane among active cars)
    laneLastY = new Array(LANE_COUNT).fill(-9999);
    for (const c of traffic) {
      if (c.y > laneLastY[c.lane]) laneLastY[c.lane] = c.y;
    }

    // popups
    for (let i = popups.length - 1; i >= 0; i--) {
      popups[i].life -= dt;
      popups[i].y -= dt * 30;
      if (popups[i].life <= 0) popups.splice(i, 1);
    }

    // particles (crash)
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 400 * dt;
      p.life -= dt;
      if (p.life <= 0) particles.splice(i, 1);
    }

    shake = Math.max(0, shake - dt * 3);

    scoreValueEl.textContent = Math.floor(distance);
  }

  function crash() {
    shake = 1;
    Sound.crash();
    Sound.stopEngine();
    for (let i = 0; i < 26; i++) {
      const ang = rng() * Math.PI * 2;
      const spd = 60 + rng() * 220;
      particles.push({
        x: player.x,
        y: PLAYER_Y,
        vx: Math.cos(ang) * spd,
        vy: Math.sin(ang) * spd - 80,
        life: 0.5 + rng() * 0.4,
        color: rng() < 0.5 ? '#ffce45' : '#ff5470',
        size: 2 + rng() * 3,
      });
    }
    setTimeout(() => endGame(), 420);
    gameState = STATE.GAMEOVER + '_pending';
  }

  function hitSpeedHump() {
    Sound.bump();
    playerBounce = 1;
  }

  // ---------- Drawing ----------
  function drawRoundedRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawCar(x, y, w, h, color, tilt, hopPhase = 0) {
    ctx.save();
    ctx.translate(x, y);

    // hitting a speed hump launches the car briefly into the air: the shadow
    // stays grounded (shrinking/fading as the car gets "further" from the
    // road) while the body itself lifts up and grows slightly toward camera.
    const air = Math.sin(Math.min(1, hopPhase) * Math.PI);

    ctx.save();
    ctx.globalAlpha *= 1 - air * 0.35;
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.translate(3, 6);
    ctx.scale(1 - air * 0.22, 1 - air * 0.22);
    drawRoundedRect(-w / 2, -h / 2, w, h, 9);
    ctx.fill();
    ctx.restore();

    ctx.translate(0, -air * 18);
    ctx.scale(1 + air * 0.22, 1 + air * 0.22);
    if (tilt) ctx.rotate(tilt);

    // body
    ctx.fillStyle = color;
    drawRoundedRect(-w / 2, -h / 2, w, h, 9);
    ctx.fill();

    // body highlight stripe
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    drawRoundedRect(-w / 2 + 3, -h / 2 + 3, w - 6, h * 0.28, 6);
    ctx.fill();

    // windshield (near top = front, direction of travel)
    ctx.fillStyle = 'rgba(20,26,36,0.75)';
    drawRoundedRect(-w / 2 + 6, -h / 2 + h * 0.16, w - 12, h * 0.22, 4);
    ctx.fill();

    // rear window
    ctx.fillStyle = 'rgba(20,26,36,0.6)';
    drawRoundedRect(-w / 2 + 7, h / 2 - h * 0.30, w - 14, h * 0.16, 4);
    ctx.fill();

    // headlights (top)
    ctx.fillStyle = '#fff6c9';
    ctx.fillRect(-w / 2 + 3, -h / 2 + 2, 6, 4);
    ctx.fillRect(w / 2 - 9, -h / 2 + 2, 6, 4);

    // taillights (bottom)
    ctx.fillStyle = '#ff4d4d';
    ctx.fillRect(-w / 2 + 3, h / 2 - 6, 6, 4);
    ctx.fillRect(w / 2 - 9, h / 2 - 6, 6, 4);

    // side mirrors
    ctx.fillStyle = color;
    ctx.fillRect(-w / 2 - 3, -h * 0.1, 3, 6);
    ctx.fillRect(w / 2, -h * 0.1, 3, 6);

    ctx.restore();
  }

  function drawSceneryItem(s, x, y) {
    ctx.save();
    ctx.translate(x, y);
    switch (s.type) {
      case 'tree': {
        ctx.fillStyle = '#5c4326';
        ctx.fillRect(-3, s.size * 0.25, 6, s.size * 0.9);
        ctx.fillStyle = '#2e7d43';
        ctx.beginPath(); ctx.arc(0, -s.size * 0.1, s.size, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#37914e';
        ctx.beginPath(); ctx.arc(-s.size * 0.4, s.size * 0.1, s.size * 0.62, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(s.size * 0.4, s.size * 0.1, s.size * 0.62, 0, Math.PI * 2); ctx.fill();
        break;
      }
      case 'bush': {
        ctx.fillStyle = 'rgba(32, 84, 47, 0.8)';
        ctx.beginPath(); ctx.arc(0, 0, s.size * 0.75, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(s.size * 0.5, s.size * 0.2, s.size * 0.5, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(-s.size * 0.5, s.size * 0.15, s.size * 0.45, 0, Math.PI * 2); ctx.fill();
        break;
      }
      case 'rock': {
        ctx.fillStyle = '#7c7f85';
        ctx.beginPath();
        ctx.ellipse(0, 0, s.size * 0.85, s.size * 0.55, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.16)';
        ctx.beginPath();
        ctx.ellipse(-s.size * 0.2, -s.size * 0.15, s.size * 0.32, s.size * 0.18, 0, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case 'sign': {
        ctx.fillStyle = '#8a8f98';
        ctx.fillRect(-2, -4, 4, s.size * 1.7);
        ctx.fillStyle = s.seed < 0.5 ? '#2f6fe0' : '#e0b02f';
        drawRoundedRect(-14, -s.size * 1.5, 28, 22, 4);
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.75)';
        ctx.lineWidth = 1.5;
        drawRoundedRect(-14, -s.size * 1.5, 28, 22, 4);
        ctx.stroke();
        break;
      }
    }
    ctx.restore();
  }

  function drawRoad() {
    // grass
    const grassGrad = ctx.createLinearGradient(0, 0, 0, LH);
    grassGrad.addColorStop(0, '#2f6b42');
    grassGrad.addColorStop(1, '#295c39');
    ctx.fillStyle = grassGrad;
    ctx.fillRect(0, 0, LW, LH);

    // scenery (parallax trees, bushes, signs, rocks)
    for (const s of scenery) {
      const y = ((s.y + sceneryScrollY * s.depth) % (LH + 80)) - 40;
      const x = s.side < 0 ? ROAD_MARGIN - 22 - s.size * 0.7 : LW - ROAD_MARGIN + 22 + s.size * 0.7;
      drawSceneryItem(s, x, y);
    }

    // asphalt (eases toward the currently-open lanes -- smoothly narrows/widens during a squeeze)
    const asphaltX = ROAD_MARGIN + LANE_WIDTH * squeezeAnimMin;
    const asphaltW = LANE_WIDTH * (squeezeAnimMax - squeezeAnimMin + 1);

    ctx.fillStyle = '#3a3f47';
    ctx.fillRect(asphaltX, 0, asphaltW, LH);

    // subtle asphalt texture
    ctx.fillStyle = 'rgba(255,255,255,0.02)';
    for (let i = 0; i < 40; i++) {
      const tx = asphaltX + ((i * 53 + (scrollY * 0.2)) % asphaltW);
      const ty = (i * 97) % LH;
      ctx.fillRect(tx, ty, 2, 10);
    }

    // road edge lines (sit at the edges of whatever's currently drivable)
    ctx.strokeStyle = '#f2e6b1';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(asphaltX, 0); ctx.lineTo(asphaltX, LH);
    ctx.moveTo(asphaltX + asphaltW, 0); ctx.lineTo(asphaltX + asphaltW, LH);
    ctx.stroke();

    // lane dividers (dashed, scrolling) -- only draw ones still within the asphalt
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.lineWidth = 3;
    const dashLen = 26, gapLen = 22;
    ctx.setLineDash([dashLen, gapLen]);
    ctx.lineDashOffset = -scrollY;
    for (let i = 1; i < LANE_COUNT; i++) {
      const x = ROAD_MARGIN + LANE_WIDTH * i;
      if (x <= asphaltX + 2 || x >= asphaltX + asphaltW - 2) continue;
      ctx.beginPath();
      ctx.moveTo(x, -dashLen);
      ctx.lineTo(x, LH);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  function draw() {
    // Clear the full physical pixel buffer regardless of the current logical
    // transform, so a stale/mismatched transform (e.g. from a mobile browser
    // resizing its viewport mid-frame) can never leave old pixels on screen.
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.restore();

    ctx.save();
    if (shake > 0) {
      const mag = shake * 10;
      ctx.translate((rng() - 0.5) * mag, (rng() - 0.5) * mag);
    }

    drawRoad();

    // traffic
    for (const c of traffic) {
      if (c.key === 'hump') {
        drawSpeedHump(c.x, c.y, c.w, c.h);
      } else if (c.key === 'moto') {
        drawMotorcycle(c.x, c.y, c.w, c.h, c.color);
      } else {
        drawCar(c.x, c.y, c.w, c.h, c.color, 0);
      }
    }

    // player
    if (gameState === STATE.COUNTDOWN || gameState === STATE.PLAYING || gameState === STATE.PAUSED || String(gameState).startsWith(STATE.GAMEOVER)) {
      drawCar(player.x, PLAYER_Y, player.w, player.h, PLAYER_COLOR, player.tilt || 0, playerBounce);
    }

    // particles
    for (const p of particles) {
      ctx.globalAlpha = Math.max(0, p.life);
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    }
    ctx.globalAlpha = 1;

    // popups
    ctx.textAlign = 'center';
    ctx.font = '700 16px -apple-system, sans-serif';
    for (const t of popups) {
      ctx.globalAlpha = Math.max(0, t.life / 0.8);
      ctx.fillStyle = t.color;
      ctx.fillText(t.text, t.x, t.y);
    }
    ctx.globalAlpha = 1;

    if (gameState === STATE.COUNTDOWN) {
      drawTrafficLight();
      drawCountdown();
    }

    ctx.restore();
  }

  function drawMotorcycle(x, y, w, h, color) {
    ctx.save();
    ctx.translate(x, y);

    // shadow
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.beginPath();
    ctx.ellipse(1, 3, w * 0.4, h * 0.46, 0, 0, Math.PI * 2);
    ctx.fill();

    // wheels
    ctx.fillStyle = '#161616';
    ctx.beginPath(); ctx.ellipse(0, h * 0.32, w * 0.42, w * 0.3, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(0, -h * 0.34, w * 0.4, w * 0.28, 0, 0, Math.PI * 2); ctx.fill();

    // body
    ctx.fillStyle = color;
    drawRoundedRect(-w * 0.28, -h * 0.32, w * 0.56, h * 0.64, w * 0.26);
    ctx.fill();

    // fuel tank / seat highlight
    ctx.fillStyle = 'rgba(255,255,255,0.2)';
    drawRoundedRect(-w * 0.2, -h * 0.2, w * 0.4, h * 0.22, w * 0.16);
    ctx.fill();

    // rider helmet
    ctx.fillStyle = '#26303c';
    ctx.beginPath();
    ctx.arc(0, -h * 0.16, w * 0.32, 0, Math.PI * 2);
    ctx.fill();

    // headlight
    ctx.fillStyle = '#fff6c9';
    ctx.beginPath();
    ctx.arc(0, -h / 2 + 4, w * 0.16, 0, Math.PI * 2);
    ctx.fill();

    // taillight
    ctx.fillStyle = '#ff4d4d';
    ctx.fillRect(-w * 0.12, h / 2 - 5, w * 0.24, 3);

    ctx.restore();
  }

  function drawSpeedHump(x, y, w, h) {
    ctx.save();
    ctx.translate(x, y);

    // shadow (suggests a raised ridge)
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    drawRoundedRect(-w / 2 + 2, -h / 2 + 3, w, h, h * 0.4);
    ctx.fill();

    // body with diagonal hazard stripes, clipped to a rounded bar
    drawRoundedRect(-w / 2, -h / 2, w, h, h * 0.4);
    ctx.save();
    ctx.clip();
    ctx.fillStyle = '#f2b400';
    ctx.fillRect(-w / 2, -h / 2, w, h);
    ctx.fillStyle = '#1a1a1a';
    const stripeW = 10;
    for (let sx = -w / 2 - h; sx < w / 2 + h; sx += stripeW * 2) {
      ctx.beginPath();
      ctx.moveTo(sx, -h / 2);
      ctx.lineTo(sx + stripeW, -h / 2);
      ctx.lineTo(sx + stripeW + h, h / 2);
      ctx.lineTo(sx + h, h / 2);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();

    // top highlight edge (raised look)
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(-w / 2 + 4, -h / 2 + 2);
    ctx.lineTo(w / 2 - 4, -h / 2 + 2);
    ctx.stroke();

    ctx.restore();
  }

  function drawTrafficLight() {
    const cx = LW / 2;
    const cy = 178;
    const w = 76, h = 172, r = 18;
    const lampR = 22;
    const offsets = [-52, 0, 52];
    const lamps = [
      { off: '#4a1c1c', on: '#ff3b3b' }, // red
      { off: '#4a3e14', on: '#ffd23b' }, // yellow
      { off: '#123f22', on: '#3bff7a' }, // green
    ];
    // 3 & 2 -> red, 1 -> yellow, GO -> green
    const lit = countdownIndex <= 1 ? 0 : countdownIndex === 2 ? 1 : 2;

    ctx.save();

    // housing
    ctx.fillStyle = '#14161c';
    drawRoundedRect(cx - w / 2, cy - h / 2, w, h, r);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.lineWidth = 2;
    drawRoundedRect(cx - w / 2, cy - h / 2, w, h, r);
    ctx.stroke();

    // mount bracket
    ctx.fillStyle = '#14161c';
    ctx.fillRect(cx - 5, cy - h / 2 - 14, 10, 14);

    for (let i = 0; i < 3; i++) {
      const ly = cy + offsets[i];
      const isLit = lit === i;
      ctx.beginPath();
      ctx.arc(cx, ly, lampR, 0, Math.PI * 2);
      if (isLit) {
        ctx.shadowColor = lamps[i].on;
        ctx.shadowBlur = 26;
      } else {
        ctx.shadowBlur = 0;
      }
      ctx.fillStyle = isLit ? lamps[i].on : lamps[i].off;
      ctx.fill();
      ctx.shadowBlur = 0;

      if (isLit) {
        ctx.beginPath();
        ctx.ellipse(cx - lampR * 0.32, ly - lampR * 0.32, lampR * 0.32, lampR * 0.2, -0.6, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,255,255,0.45)';
        ctx.fill();
      }
    }

    ctx.restore();
  }

  function drawCountdown() {
    const label = COUNTDOWN_STEPS[countdownIndex];
    if (!label) return;
    const t = countdownElapsed / COUNTDOWN_STEP_TIME;
    const scale = 1.5 - Math.min(1, t * 2.5) * 0.5;
    const alpha = t > 0.75 ? Math.max(0, 1 - (t - 0.75) / 0.25) : 1;

    ctx.save();
    ctx.translate(LW / 2, LH / 2);
    ctx.scale(scale, scale);
    ctx.globalAlpha = alpha;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '900 96px -apple-system, sans-serif';
    ctx.fillStyle = label === 'GO' ? '#35d488' : '#ffce45';
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 6;
    ctx.strokeText(label, 0, 0);
    ctx.fillText(label, 0, 0);
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  // ---------- Resize handling (crisp + responsive) ----------
  function resize() {
    // Fit the fixed 480:720 game area inside whatever space #app actually has,
    // computed entirely in JS -- avoids relying on CSS aspect-ratio's
    // interaction with vh/dvh, which had sub-pixel rounding quirks on iOS
    // Safari that let the canvas render a hair taller than intended.
    const container = canvas.parentElement.getBoundingClientRect();
    let cssW = container.width;
    let cssH = cssW * (LH / LW);
    if (cssH > container.height) {
      cssH = container.height;
      cssW = cssH * (LW / LH);
    }
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';

    const dpr = window.devicePixelRatio || 1;
    const scaleFactor = cssW / LW;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    ctx.setTransform(dpr * scaleFactor, 0, 0, dpr * scaleFactor, 0, 0);
  }
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', resize);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', resize);
  }

  // ---------- Main loop ----------
  let lastTime = performance.now();
  function loop(now) {
    const dt = Math.min(0.05, (now - lastTime) / 1000);
    lastTime = now;

    if (gameState === STATE.COUNTDOWN) {
      countdownElapsed += dt;
      if (countdownElapsed >= COUNTDOWN_STEP_TIME) {
        countdownElapsed -= COUNTDOWN_STEP_TIME;
        countdownIndex++;
        if (countdownIndex >= COUNTDOWN_STEPS.length) {
          gameState = STATE.PLAYING;
          pauseBtn.classList.remove('hidden');
        } else {
          Sound.countdownBeep(countdownIndex === COUNTDOWN_STEPS.length - 1);
        }
      }
    } else if (gameState === STATE.PLAYING) {
      update(dt);
    } else if (String(gameState).startsWith(STATE.GAMEOVER)) {
      // still animate particles during crash freeze-frame
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 400 * dt; p.life -= dt;
        if (p.life <= 0) particles.splice(i, 1);
      }
      shake = Math.max(0, shake - dt * 2);
    }

    draw();
    requestAnimationFrame(loop);
  }

  // ---------- PWA install (offline caching) ----------
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => { /* offline caching unavailable */ });
    });
  }

  // ---------- Init ----------
  function init() {
    resize();
    resetGame();
    bestValueEl.textContent = getBest(selectedDiff);
    updateMuteIcon();
    showScreen(startScreen);
    requestAnimationFrame((t) => { lastTime = t; requestAnimationFrame(loop); });
  }

  init();
})();
