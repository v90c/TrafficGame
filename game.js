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
  ];

  const TRAFFIC_COLORS = ['#e94f4f', '#4f8ce9', '#e9a94f', '#8a5fd6', '#d6d6d6', '#4f4f4f', '#e94f9d', '#5fd68a'];
  const PLAYER_COLOR = '#3ecfff';

  // ---------- DOM ----------
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const hud = document.getElementById('hud');
  const scoreValueEl = document.getElementById('scoreValue');
  const bestValueEl = document.getElementById('bestValue');
  const pauseBtn = document.getElementById('pauseBtn');

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
  const STATE = { MENU: 'menu', PLAYING: 'playing', PAUSED: 'paused', GAMEOVER: 'gameover' };
  let gameState = STATE.MENU;

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

    scenery = [];
    for (let i = 0; i < 10; i++) {
      scenery.push({
        side: rng() < 0.5 ? -1 : 1,
        y: rng() * LH,
        size: 10 + rng() * 18,
        depth: 0.5 + rng() * 0.4,
      });
    }
  }

  // ---------- Input ----------
  const keysDown = new Set();

  function shiftLane(delta) {
    if (gameState !== STATE.PLAYING) return;
    player.targetLane = Math.max(0, Math.min(LANE_COUNT - 1, player.targetLane + delta));
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
    gameState = STATE.PLAYING;
    showScreen(null);
    hud.classList.remove('hidden');
    pauseBtn.classList.remove('hidden');
    bestValueEl.textContent = getBest(selectedDiff);
  }

  function togglePause() {
    if (gameState === STATE.PLAYING) {
      gameState = STATE.PAUSED;
      showScreen(pauseScreen);
    } else if (gameState === STATE.PAUSED) {
      gameState = STATE.PLAYING;
      showScreen(null);
    }
  }

  function endGame() {
    gameState = STATE.GAMEOVER;
    hud.classList.add('hidden');
    pauseBtn.classList.add('hidden');
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

  startBtn.addEventListener('click', startGame);
  resumeBtn.addEventListener('click', togglePause);
  pauseBtn.addEventListener('click', togglePause);
  quitBtn.addEventListener('click', () => {
    gameState = STATE.MENU;
    hud.classList.add('hidden');
    pauseBtn.classList.add('hidden');
    showScreen(startScreen);
  });
  retryBtn.addEventListener('click', startGame);
  menuBtn.addEventListener('click', () => {
    gameState = STATE.MENU;
    showScreen(startScreen);
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
    const laneOrder = [0, 1, 2, 3].sort(() => rng() - 0.5);
    const maxToSpawn = Math.min(cfg.maxSimultaneous, LANE_COUNT - 1); // always leave >=1 lane open
    const howMany = 1 + Math.floor(rng() * maxToSpawn);
    let spawned = 0;

    for (const lane of laneOrder) {
      if (spawned >= howMany) break;
      const topY = laneLastY[lane];
      if (topY > -cfg.laneGapPx) continue; // not enough gap yet in this lane
      const type = weightedCarType();
      const y = -type.h - rng() * 60;
      traffic.push({
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

  // ---------- Update ----------
  function update(dt) {
    const cfg = DIFFICULTIES[selectedDiff];
    elapsed += dt;

    const speed = Math.min(cfg.maxSpeed, cfg.baseSpeed + cfg.speedRamp * elapsed);
    const spawnInterval = Math.max(cfg.minSpawnInterval, cfg.spawnInterval - cfg.spawnRampMs * 1000 * (elapsed / 1000) * 0.06);

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

      if (overlap) {
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

  function drawCar(x, y, w, h, color, tilt) {
    ctx.save();
    ctx.translate(x, y);
    if (tilt) ctx.rotate(tilt);

    // shadow
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    drawRoundedRect(-w / 2 + 3, -h / 2 + 6, w, h, 9);
    ctx.fill();

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

  function drawRoad() {
    // grass
    const grassGrad = ctx.createLinearGradient(0, 0, 0, LH);
    grassGrad.addColorStop(0, '#2f6b42');
    grassGrad.addColorStop(1, '#295c39');
    ctx.fillStyle = grassGrad;
    ctx.fillRect(0, 0, LW, LH);

    // scenery (parallax trees/bushes)
    for (const s of scenery) {
      const y = ((s.y + sceneryScrollY * s.depth) % (LH + 60)) - 30;
      const x = s.side < 0 ? ROAD_MARGIN - 20 - s.size * 0.6 : LW - ROAD_MARGIN + 20 + s.size * 0.6;
      ctx.fillStyle = 'rgba(20, 50, 28, 0.55)';
      ctx.beginPath();
      ctx.arc(x, y, s.size, 0, Math.PI * 2);
      ctx.fill();
    }

    // asphalt
    ctx.fillStyle = '#3a3f47';
    ctx.fillRect(ROAD_MARGIN, 0, ROAD_WIDTH, LH);

    // subtle asphalt texture
    ctx.fillStyle = 'rgba(255,255,255,0.02)';
    for (let i = 0; i < 40; i++) {
      const tx = ROAD_MARGIN + ((i * 53 + (scrollY * 0.2)) % ROAD_WIDTH);
      const ty = (i * 97) % LH;
      ctx.fillRect(tx, ty, 2, 10);
    }

    // road edge lines
    ctx.strokeStyle = '#f2e6b1';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(ROAD_MARGIN, 0); ctx.lineTo(ROAD_MARGIN, LH);
    ctx.moveTo(LW - ROAD_MARGIN, 0); ctx.lineTo(LW - ROAD_MARGIN, LH);
    ctx.stroke();

    // lane dividers (dashed, scrolling)
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.lineWidth = 3;
    const dashLen = 26, gapLen = 22;
    ctx.setLineDash([dashLen, gapLen]);
    ctx.lineDashOffset = -scrollY;
    for (let i = 1; i < LANE_COUNT; i++) {
      const x = ROAD_MARGIN + LANE_WIDTH * i;
      ctx.beginPath();
      ctx.moveTo(x, -dashLen);
      ctx.lineTo(x, LH);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  function draw() {
    ctx.save();
    if (shake > 0) {
      const mag = shake * 10;
      ctx.translate((rng() - 0.5) * mag, (rng() - 0.5) * mag);
    }

    drawRoad();

    // traffic
    for (const c of traffic) {
      drawCar(c.x, c.y, c.w, c.h, c.color, 0);
    }

    // player
    if (gameState === STATE.PLAYING || gameState === STATE.PAUSED || String(gameState).startsWith(STATE.GAMEOVER)) {
      drawCar(player.x, PLAYER_Y, player.w, player.h, PLAYER_COLOR, player.tilt || 0);
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

    ctx.restore();
  }

  // ---------- Resize handling (crisp + responsive) ----------
  function resize() {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const scaleFactor = rect.width / LW;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    ctx.setTransform(dpr * scaleFactor, 0, 0, dpr * scaleFactor, 0, 0);
  }
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', resize);

  // ---------- Main loop ----------
  let lastTime = performance.now();
  function loop(now) {
    const dt = Math.min(0.05, (now - lastTime) / 1000);
    lastTime = now;

    if (gameState === STATE.PLAYING) {
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

  // ---------- Init ----------
  function init() {
    resize();
    resetGame();
    bestValueEl.textContent = getBest(selectedDiff);
    showScreen(startScreen);
    requestAnimationFrame((t) => { lastTime = t; requestAnimationFrame(loop); });
  }

  init();
})();
