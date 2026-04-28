/* ═══════════════════════════════════════════════════════════════════
   racing.js — Rod Wave Worlds · Race Mode
   Depends on globals from index.html:
     scene, camera, renderer, isMobile, gameRunning, dt, lastTime, clock
     touchJoystickX, touchJoystickY, touchJoystickId
     animFrameId, setVH, checkOrientation, backToMenu
   ═══════════════════════════════════════════════════════════════════ */

// raceState is declared as `var raceState` in index.html so it's accessible cross-script

const RACE_CONFIG = {
  lapsTotal:      3,
  maxSpeed:       44,   // units / sec
  boostSpeed:     66,
  accel:          88,   // units / sec²  (reaches maxSpeed in ~0.5 s full throttle)
  brake:          160,  // deceleration when pressing reverse while moving forward
  reverseSpeed:  -18,
  drag:           0.55, // fraction of speed remaining after 1 second of coasting
  offTrackDrag:   0.25, // much heavier drag on grass
  turnRate:       2.2,  // rad / sec at optimal cornering speed
  driftTurnBonus: 1.55, // extra turn multiplier while drifting
  kartCount:      6,
  trackWidth:     22,
};

/* ─── INIT / RESTART ────────────────────────────────────────────── */
function initRace() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x86c8f2);
  scene.fog = new THREE.FogExp2(0xb0d8f0, 0.004);

  camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.1, 2000);
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.setPixelRatio(isMobile ? Math.min(devicePixelRatio, 1.5) : Math.min(devicePixelRatio, 2));
  document.body.appendChild(renderer.domElement);
  renderer.domElement.classList.add('game-canvas');

  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  scene.add(new THREE.HemisphereLight(0xc8e8ff, 0x557744, 0.5));
  const sun = new THREE.DirectionalLight(0xfff5e0, 1.1);
  sun.position.set(60, 100, 40);
  sun.castShadow = true;
  sun.shadow.mapSize.set(isMobile ? 1024 : 2048, isMobile ? 1024 : 2048);
  sun.shadow.camera.near = 1; sun.shadow.camera.far = 400;
  sun.shadow.camera.left = -120; sun.shadow.camera.right = 120;
  sun.shadow.camera.top = 120; sun.shadow.camera.bottom = -120;
  scene.add(sun);

  raceState = {
    karts: [],
    waypoints: [],
    itemBoxes: [],
    bananas: [],
    shells: [],
    particles: [],
    boostRamps: [],
    lightningFlashTimer: 0,
    countdown: 2.99,
    started: false,
    finished: false,
    startTime: 0,
    elapsed: 0,
    playerFinishMsgTimer: 0,
    trackMeshes: [],
    camAngle: undefined,
    screenShake: 0,       // wall-hit shake magnitude (decays each frame)
  };

  buildRaceTrack();
  spawnRaceKarts();
  spawnRaceItemBoxes();
  if (typeof AbilityManager !== 'undefined') AbilityManager.init(raceState);
  setupRaceControls();

  if (isMobile) {
    document.getElementById('touch-controls').style.display = 'block';
    document.getElementById('joystick-zone').classList.remove('dpad');
    document.getElementById('touch-jump-btn').textContent = 'DRIFT';
    document.getElementById('touch-dash-btn').textContent = 'ITEM';
    setupRaceMobileControls();
  }

  // Sky dome
  (function () {
    const geo = new THREE.SphereGeometry(900, 32, 16);
    const c = document.createElement('canvas');
    c.width = 2; c.height = 512;
    const ctx = c.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 0, 512);
    g.addColorStop(0, '#3a72b8');
    g.addColorStop(0.5, '#86c8f2');
    g.addColorStop(1, '#dff1ff');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 2, 512);
    const tex = new THREE.CanvasTexture(c);
    const sky = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, fog: false }));
    scene.add(sky);
    raceState.skyDome = sky;
  })();

  for (let i = 0; i < 30; i++) {
    spawnCloud(
      (Math.random() - 0.5) * 400,
      25 + Math.random() * 25,
      (Math.random() - 0.5) * 400
    );
  }

  updateRaceHUD();
  updateSpeedometer(0);
  lastTime = performance.now();
  clock.start();
  gameRunning = true;
  showCountdown('3');
  animateRace();
}

function restartRace() {
  document.getElementById('race-finish').style.display = 'none';
  if (animFrameId) { cancelAnimationFrame(animFrameId); animFrameId = null; }
  if (renderer && renderer.domElement && renderer.domElement.parentNode) {
    renderer.domElement.parentNode.removeChild(renderer.domElement);
  }
  raceState = null;
  window.removeEventListener('keydown', raceKeyDown);
  window.removeEventListener('keyup', raceKeyUp);
  if (typeof AbilityManager !== 'undefined') AbilityManager.cleanup();
  initRace();
}

/* ─── STATE BRIDGE ───────────────────────────────────────────────────
   switchState('OBBY') — tears down the race scene and hands control
   to ObbyManager so the player can transition mid-session without a
   full page reload.
   ─────────────────────────────────────────────────────────────────── */
function switchState(target) {
  if (target !== 'OBBY') return;

  // 1. Stop race loop and clean up race resources
  if (animFrameId) { cancelAnimationFrame(animFrameId); animFrameId = null; }
  window.removeEventListener('keydown', raceKeyDown);
  window.removeEventListener('keyup',   raceKeyUp);
  if (typeof AbilityManager !== 'undefined') AbilityManager.cleanup();
  raceState = null;

  // 2. Tear down renderer canvas (init() will rebuild it)
  if (renderer && renderer.domElement && renderer.domElement.parentNode) {
    renderer.domElement.parentNode.removeChild(renderer.domElement);
  }
  renderer = null; scene = null; camera = null;

  // 3. Swap HUD visibility
  document.getElementById('race-hud').style.display  = 'none';
  document.getElementById('race-finish').style.display = 'none';
  document.getElementById('race-countdown').classList.remove('active');
  document.getElementById('hud').style.display = 'block';

  // 4. Switch mode flag and start obby
  currentMode = 'obby';
  hasWon      = false;
  init();   // index.html init() → ObbyManager.init() → animate()
}

/* buildRaceTrack, spawnTree, makeTextSprite → see mapGenerator.js */

/* ─── KART SPAWN ────────────────────────────────────────────────── */
function spawnRaceKarts() {
  const kartData = [
    { color: 0xc9a84c, label: 'ROD WAVE',   isPlayer: true,  img: true },
    { color: 0xff4455, label: 'BOT TYRONE', isPlayer: false, aiSkill: 1.10 }, // buffed
    { color: 0x55ccff, label: 'BOT DREW',   isPlayer: false, aiSkill: 1.05 },
    { color: 0x66ee66, label: 'BOT KAI',    isPlayer: false, aiSkill: 1.00 },
    { color: 0xffaa33, label: 'BOT ZANE',   isPlayer: false, aiSkill: 0.96 },
    { color: 0xbb66ff, label: 'BOT MARCO',  isPlayer: false, aiSkill: 0.92 },
  ];

  const wps = raceState.waypoints;
  const startLine = wps[0];
  const nextPt = wps[1];
  const dir = new THREE.Vector3(nextPt.x - startLine.x, 0, nextPt.z - startLine.z).normalize();
  const perp = new THREE.Vector3(-dir.z, 0, dir.x);
  const startAngle = Math.atan2(dir.x, dir.z);

  for (let i = 0; i < kartData.length; i++) {
    const row = Math.floor(i / 2);
    const col = i % 2;
    const gx = startLine.x - dir.x * (5 + row * 8) + perp.x * (col === 0 ? -5 : 5);
    const gz = startLine.z - dir.z * (5 + row * 8) + perp.z * (col === 0 ? -5 : 5);
    const k = createRaceKart(kartData[i]);
    k.pos.set(gx, 0, gz);
    k.angle       = startAngle;
    k.heading     = startAngle;   // wheel direction
    k.visualAngle = startAngle;   // what the mesh shows (lerps toward velocity)
    k.speed       = 0;
    k.mesh.position.copy(k.pos);
    k.mesh.rotation.y = startAngle; // positive = correct orientation (nose at +Z)
    raceState.karts.push(k);
  }
}

function createRaceKart(data) {
  const group = new THREE.Group();
  group.scale.set(2, 2, 2);

  const body = new THREE.Mesh(
    new THREE.BoxGeometry(1.4, 0.55, 2.2),
    new THREE.MeshPhongMaterial({ color: data.color, shininess: 70 })
  );
  body.position.y = 0.55;
  body.castShadow = true;
  group.add(body);

  const nose = new THREE.Mesh(
    new THREE.BoxGeometry(1.15, 0.4, 0.6),
    new THREE.MeshPhongMaterial({ color: data.color, shininess: 70 })
  );
  nose.position.set(0, 0.48, 1.4);
  group.add(nose);

  const wing = new THREE.Mesh(
    new THREE.BoxGeometry(1.5, 0.1, 0.4),
    new THREE.MeshPhongMaterial({ color: 0x222222 })
  );
  wing.position.set(0, 1.05, -1.1);
  group.add(wing);

  const wheelGeo = new THREE.CylinderGeometry(0.4, 0.4, 0.35, 12);
  const wheelMat = new THREE.MeshPhongMaterial({ color: 0x181818 });
  const wheelPos = [[-0.82, 0.4, 0.85], [0.82, 0.4, 0.85], [-0.82, 0.4, -0.85], [0.82, 0.4, -0.85]];
  const wheels = [];
  wheelPos.forEach(p => {
    const w = new THREE.Mesh(wheelGeo, wheelMat);
    w.rotation.z = Math.PI / 2;
    w.position.set(p[0], p[1], p[2]);
    group.add(w);
    wheels.push(w);
  });

  const loader = new THREE.TextureLoader();
  const tex = loader.load('https://i.postimg.cc/6pzzgj5j/39-Rod-Wave-1200x834-2.webp');
  const spriteMat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
  if (!data.isPlayer) {
    spriteMat.color = new THREE.Color(data.color).lerp(new THREE.Color(0xffffff), 0.3);
  }
  const sprite = new THREE.Sprite(spriteMat);
  sprite.scale.set(1.2, 1.8, 1);
  sprite.position.set(0, 1.75, 0);
  group.add(sprite);

  const ntCanvas = document.createElement('canvas');
  ntCanvas.width = 256; ntCanvas.height = 64;
  const ntCtx = ntCanvas.getContext('2d');
  ntCtx.fillStyle = 'rgba(0,0,0,0.65)';
  ntCtx.fillRect(0, 0, 256, 64);
  ntCtx.font = 'bold 26px "Barlow Condensed", sans-serif';
  ntCtx.fillStyle = data.isPlayer ? '#ffdd44' : '#ffffff';
  ntCtx.textAlign = 'center';
  ntCtx.fillText(data.label, 128, 40);
  const ntTex = new THREE.CanvasTexture(ntCanvas);
  const nt = new THREE.Sprite(new THREE.SpriteMaterial({ map: ntTex, transparent: true, depthWrite: false }));
  nt.scale.set(2.4, 0.6, 1);
  nt.position.set(0, 2.9, 0);
  group.add(nt);

  const sh = new THREE.Mesh(
    new THREE.CircleGeometry(1, 16),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false })
  );
  sh.rotation.x = -Math.PI / 2;
  sh.position.y = 0.04;
  group.add(sh);

  scene.add(group);

  return {
    mesh:        group,
    pos:         group.position,
    // ── Physics state ───────────────────────────────────────────────
    speed:       0,            // forward speed along heading (canonical)
    vel:         0,            // alias kept in sync with speed for legacy code
    heading:     Math.PI / 2, // direction wheels point (radians); set by spawn
    visualAngle: Math.PI / 2, // what the mesh actually shows; lerps to vel direction
    angle:       Math.PI / 2, // kept in sync with heading for AI / lap code
    vx:          0,            // actual world velocity x (may differ from heading during slides)
    vz:          0,            // actual world velocity z
    steering:    0,            // -1 = full left, +1 = full right
    drifting:    false,
    driftDir:    0,
    // ── Race state ──────────────────────────────────────────────────
    lap:         0,
    nextWp:      1,
    lastWp:      0,
    progress:    0,
    isPlayer:    data.isPlayer,
    label:       data.label,
    color:       data.color,
    powerup:     null,
    boostTimer:  0,
    stunnedTimer:     0,
    spinVisualTimer:  0,
    finished:    false,
    finishTime:  0,
    position:    1,
    aiSkill:     data.aiSkill || 1,
    aiTargetOffset: (Math.random() - 0.5) * 3,
    // ── Ability state (managed by abilityManager.js) ─────────────────
    ability:         null,   // current held ability key (string | null)
    abilityCooldown: 0,      // seconds remaining on cooldown
    phaseShift:      0,      // Phase Shift active timer
    overclock:       0,      // Overclock active timer
    wheels,
    sprite,
  };
}

/* ─── ITEM BOXES ────────────────────────────────────────────────── */
class PowerupBox {
  constructor(x, z) {
    this.x = x; this.z = z;
    this.active = true;
    this.respawnTimer = 0;
    this.mesh = makeItemBoxMesh();
    this.mesh.position.set(x, 1.2, z);
    scene.add(this.mesh);
  }
  update(delta) {
    if (!this.active) {
      this.respawnTimer -= delta;
      if (this.respawnTimer <= 0) { this.active = true; this.mesh.visible = true; }
    } else {
      this.mesh.rotation.y += delta * 2.5;
      this.mesh.position.y = 1.2 + Math.sin(performance.now() * 0.004) * 0.2;
    }
  }
}

function spawnRaceItemBoxes() {
  const curve = raceState.trackCurve;
  const numLines = 6;
  for (let i = 0; i < numLines; i++) {
    const t = (i + 0.5) / numLines;
    const pos = curve.getPointAt(t);
    const tangent = curve.getTangentAt(t);
    const angle = Math.atan2(tangent.x, tangent.z);
    const perpX = Math.cos(angle), perpZ = -Math.sin(angle);
    for (let j = -1; j <= 1; j++) {
      raceState.itemBoxes.push(new PowerupBox(pos.x + perpX * j * 6, pos.z + perpZ * j * 6));
    }
  }
}

function makeItemBoxMesh() {
  const g = new THREE.Group();
  const cube = new THREE.Mesh(
    new THREE.BoxGeometry(1.5, 1.5, 1.5),
    new THREE.MeshPhongMaterial({ color: 0xffdd44, emissive: 0xffaa00, emissiveIntensity: 0.55, transparent: true, opacity: 0.8, shininess: 120 })
  );
  g.add(cube);
  return g;
}

/* ─── CONTROLS ──────────────────────────────────────────────────── */
var racePlayerKeys = {};

function setupRaceControls() {
  window.addEventListener('keydown', raceKeyDown);
  window.addEventListener('keyup', raceKeyUp);

  window.onresize = () => {
    setVH();
    if (camera) { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); }
    if (renderer) renderer.setSize(innerWidth, innerHeight);
    if (isMobile) checkOrientation();
  };
}

function raceKeyDown(e) {
  racePlayerKeys[e.code] = true;
  if (e.code === 'Space') e.preventDefault();
  if (e.code === 'KeyQ') usePlayerItem();
  if (e.code === 'KeyE' && typeof AbilityManager !== 'undefined') AbilityManager.usePlayerAbility();
}
function raceKeyUp(e) { racePlayerKeys[e.code] = false; }

function setupRaceMobileControls() {
  const jZone = document.getElementById('joystick-zone');
  const jThumb = document.getElementById('joystick-thumb');
  const jRadius = 65;

  function updateJoystick(touch) {
    const rect = jZone.getBoundingClientRect();
    const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
    let dx = touch.clientX - cx, dy = touch.clientY - cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > jRadius) { dx = dx / dist * jRadius; dy = dy / dist * jRadius; }
    touchJoystickX = dx / jRadius;
    touchJoystickY = dy / jRadius;
    jThumb.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
  }
  jZone.ontouchstart = e => {
    e.preventDefault();
    if (touchJoystickId !== null) return;
    const t = e.changedTouches[0];
    touchJoystickId = t.identifier;
    updateJoystick(t);
  };
  jZone.ontouchmove = e => {
    e.preventDefault();
    for (let i = 0; i < e.changedTouches.length; i++) {
      if (e.changedTouches[i].identifier === touchJoystickId) updateJoystick(e.changedTouches[i]);
    }
  };
  const endJ = e => {
    for (let i = 0; i < e.changedTouches.length; i++) {
      if (e.changedTouches[i].identifier === touchJoystickId) {
        touchJoystickId = null;
        touchJoystickX = 0; touchJoystickY = 0;
        jThumb.style.transform = 'translate(-50%,-50%)';
      }
    }
  };
  jZone.ontouchend = endJ; jZone.ontouchcancel = endJ;

  const driftBtn = document.getElementById('touch-jump-btn');
  driftBtn.ontouchstart = e => { e.preventDefault(); racePlayerKeys['Space'] = true; driftBtn.classList.add('pressed'); };
  driftBtn.ontouchend   = e => { e.preventDefault(); racePlayerKeys['Space'] = false; driftBtn.classList.remove('pressed'); };
  driftBtn.ontouchcancel = () => { racePlayerKeys['Space'] = false; driftBtn.classList.remove('pressed'); };

  const itemBtn = document.getElementById('touch-dash-btn');
  itemBtn.ontouchstart = e => { e.preventDefault(); itemBtn.classList.add('pressed'); usePlayerItem(); };
  itemBtn.ontouchend   = e => { e.preventDefault(); itemBtn.classList.remove('pressed'); };
  itemBtn.ontouchcancel = () => { itemBtn.classList.remove('pressed'); };
}

/* ─── ITEM USE ──────────────────────────────────────────────────── */
function usePlayerItem() {
  if (!raceState || raceState.finished) return;
  const p = raceState.karts[0];
  if (!p || p.finished || !p.powerup) return;
  const item = p.powerup;
  if (item === 'golden_mushroom') {
    p.goldenUses = (p.goldenUses || 0) + 1;
    applyBoost(p, 2.0, 1.3);
    if (p.goldenUses >= 3) { p.powerup = null; p.goldenUses = 0; }
  } else {
    p.powerup = null;
    useItem(p, item);
  }
  const icon = document.getElementById('race-item-icon');
  icon.classList.add('using');
  setTimeout(() => icon.classList.remove('using'), 180);
  updateRaceHUD();
}

function useItem(k, item) {
  if (item === 'mushroom')         applyBoost(k, 1.8, 1.4);
  else if (item === 'triple_mushroom') applyBoost(k, 4.5, 1.4);
  else if (item === 'golden_mushroom') applyBoost(k, 2.0, 1.3);
  else if (item === 'shield')      applyShield(k, 8.0);
  else if (item === 'shell')       fireProjectile(k, 'green');
  else if (item === 'blue_shell')  fireProjectile(k, 'blue');
  else if (item === 'star')        applyStar(k, 6.0);
}

function applyBoost(k, dur, mul = 1.4) {
  k.boostTimer = Math.max(k.boostTimer, dur);
  k.boostMultiplier = mul;
  if (k.isPlayer) showRaceMsg('🚀 BOOST!');
}

function applyShield(k, dur) {
  k.shieldTimer = Math.max(k.shieldTimer || 0, dur);
  if (!k.shieldMesh) {
    k.shieldMesh = new THREE.Mesh(
      new THREE.SphereGeometry(2, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0x66ccff, transparent: true, opacity: 0.3, wireframe: true })
    );
    k.mesh.add(k.shieldMesh);
  }
  if (k.isPlayer) showRaceMsg('🛡️ SHIELD!');
}

function applyStar(k, dur) {
  k.boostTimer = Math.max(k.boostTimer, dur);
  k.boostMultiplier = 1.5;
  k.invincibleTimer = Math.max(k.invincibleTimer || 0, dur);
  if (k.isPlayer) showRaceMsg('🌟 STAR POWER!');
}

function fireProjectile(k, type) {
  const shell = {
    type, pos: k.pos.clone(), angle: k.angle, owner: k,
    life: 5.0, mesh: createShellMesh(type)
  };
  shell.mesh.position.copy(shell.pos);
  shell.mesh.rotation.y = -shell.angle;
  scene.add(shell.mesh);
  raceState.shells.push(shell);
  if (k.isPlayer) showRaceMsg(type === 'blue' ? '💎 BLUE SHELL!' : '🐚 SHELL!');
}

function createShellMesh(type) {
  const g = new THREE.Group();
  const color = type === 'blue' ? 0x0088ff : 0x44ff44;
  const shell = new THREE.Mesh(
    new THREE.SphereGeometry(0.8, 12, 8),
    new THREE.MeshPhongMaterial({ color, emissive: color, emissiveIntensity: 0.5 })
  );
  shell.scale.set(1, 0.6, 1.2);
  g.add(shell);
  return g;
}

/* ─── HELPERS ───────────────────────────────────────────────────── */
function pickRandomItem(pos) {
  const roll = Math.random();
  if (pos <= 2) {
    if (roll < 0.5) return 'mushroom';
    if (roll < 0.8) return 'shield';
    return 'shell';
  } else if (pos <= 4) {
    if (roll < 0.3) return 'mushroom';
    if (roll < 0.5) return 'triple_mushroom';
    if (roll < 0.7) return 'shell';
    if (roll < 0.9) return 'shield';
    return 'golden_mushroom';
  } else {
    if (roll < 0.2) return 'blue_shell';
    if (roll < 0.5) return 'star';
    if (roll < 0.8) return 'golden_mushroom';
    return 'triple_mushroom';
  }
}

function itemIcon(item) {
  const icons = {
    mushroom: '🍄', triple_mushroom: '🍄×3', golden_mushroom: '🌟🍄',
    shield: '🛡️', shell: '🐚', blue_shell: '💎', star: '🌟'
  };
  return icons[item] || '❓';
}

function showRaceMsg(txt) {
  const el = document.getElementById('race-msg');
  el.textContent = txt;
  el.classList.add('visible');
  clearTimeout(el._hideTimer);
  el._hideTimer = setTimeout(() => el.classList.remove('visible'), 1400);
}

/* ─── TRACK HELPERS ─────────────────────────────────────────────── */
function nearestTrackDistance(x, z) {
  const wps = raceState.waypoints;
  let best = Infinity;
  for (let i = 0; i < wps.length; i++) {
    const a = wps[i], b = wps[(i + 1) % wps.length];
    const dx = b.x - a.x, dz = b.z - a.z;
    const len2 = dx * dx + dz * dz;
    let t = ((x - a.x) * dx + (z - a.z) * dz) / len2;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t));
    if (d < best) best = d;
  }
  return best;
}

function kartProgress(k) {
  const wps = raceState.waypoints;
  const a = wps[k.lastWp], b = wps[k.nextWp];
  const dx = b.x - a.x, dz = b.z - a.z;
  const len2 = dx * dx + dz * dz;
  let t = ((k.pos.x - a.x) * dx + (k.pos.z - a.z) * dz) / len2;
  t = Math.max(0, Math.min(1, t));
  return k.lap * wps.length + k.lastWp + t;
}

function updatePositions() {
  const ks = raceState.karts.slice();
  ks.forEach(k => { k.progress = kartProgress(k); });
  ks.sort((a, b) => {
    if (a.finished && b.finished) return a.finishTime - b.finishTime;
    if (a.finished) return -1;
    if (b.finished) return 1;
    return b.progress - a.progress;
  });
  ks.forEach((k, i) => { k.position = i + 1; });
}

/* updateBotKart → replaced by advancedBotUpdate in botAI.js */

/* ─── KART PHYSICS — Vector-based model with Ackermann steering ──
   STATE:
     k.heading     = direction the wheels point (radians)
     k.speed       = forward speed along heading (negative = reverse)
     k.vx / k.vz  = ACTUAL world velocity (may differ from heading during slides)
     k.visualAngle = what the mesh shows; lerps toward velocity direction
   Player and bots only set k.engineForce and k.steering.
   k.vel / k.angle kept in sync for legacy AI + lap code.
   ─────────────────────────────────────────────────────────────── */
function updateKartPhysics(k, delta) {
  const cfg = RACE_CONFIG;
  let topSpeed = k.boostTimer > 0
    ? cfg.boostSpeed * (k.boostMultiplier || 1.4)
    : cfg.maxSpeed;

  /* ── Ability hooks: Overclock (speed×2) + Phase Shift timer ────── */
  if (typeof AbilityManager !== 'undefined') {
    topSpeed = AbilityManager.getOverclockTopSpeed(k, topSpeed);
    AbilityManager.tickPhaseShift(k, delta);
    AbilityManager.tickOverclock(k, delta);
  }

  // Ensure state is initialized (safe for old save-state references)
  if (k.speed   === undefined) k.speed       = k.vel   || 0;
  if (k.heading === undefined) k.heading     = k.angle || 0;
  if (k.visualAngle === undefined) k.visualAngle = k.heading;

  /* ── 1. ENGINE FORCE ────────────────────────────────────────────
     engineForce is set upstream by updatePlayerKart / updateBotKart.
     Positive = accelerate forward, negative = brake/reverse.        */
  k.speed += (k.engineForce || 0) * delta;

  /* ── 2. DRAG — exponential decay (frame-rate independent) ────────
     cfg.drag = fraction of speed remaining after 1 full second idle. */
  k.speed *= Math.pow(cfg.drag, delta);

  /* ── 3. SPEED LIMITS ────────────────────────────────────────────*/
  k.speed = Math.max(cfg.reverseSpeed, Math.min(topSpeed, k.speed));
  if (Math.abs(k.speed) < 0.05) k.speed = 0;

  /* ── 4. ACKERMANN STEERING ──────────────────────────────────────
     Real Ackermann: angular velocity = forward_speed / turn_radius.
     We approximate with: turnRate * speedRamp * highSpeedCap.
     • speedRamp   — ramps 0→1 over 0–8 u/s (no instant snap at low speed)
     • highSpeedCap — reduces at extreme speed so highways feel planted
     • reverseSign  — steering inverts when reversing (like a real car)
     • The sign convention: +steering → heading increases → car turns RIGHT
       (sin/cos forward vector, positive mesh.rotation.y = nose at +Z facing fwd) */
  const absSpeed = Math.abs(k.speed);
  if (absSpeed > 0.3 && Math.abs(k.steering || 0) > 0.01) {
    const speedRamp    = Math.min(1.0, absSpeed / 8.0);
    const highSpeedCap = Math.max(0.5, 1.0 - (absSpeed / topSpeed) * 0.45);
    const driftMul     = k.drifting ? cfg.driftTurnBonus : 1.0;
    const reverseSign  = k.speed < 0 ? -1 : 1;  // flip steer when reversing
    // Overclock makes steering 50% more sensitive (slippery high-speed handling)
    const overclockTurn = (typeof AbilityManager !== 'undefined') ? AbilityManager.getOverclockTurnMul(k) : 1.0;
    k.heading += k.steering * cfg.turnRate * speedRamp * highSpeedCap * driftMul * reverseSign * overclockTurn * delta;
  }

  /* ── 5. FORWARD VECTOR ──────────────────────────────────────────
     Derived from heading. This is the direction the engine pushes.
     sin(heading) → X component,  cos(heading) → Z component.
     When heading = 0  → facing +Z (world forward)
     When heading = π/2 → facing +X (world right)                  */
  const fwdX = Math.sin(k.heading);
  const fwdZ = Math.cos(k.heading);

  /* ── 6. TARGET VELOCITY (where the car "wants" to go) ───────────
     The ideal velocity if grip were perfect: straight along heading. */
  const targetVx = fwdX * k.speed;
  const targetVz = fwdZ * k.speed;

  /* ── 7. LATERAL GRIP — pull actual velocity toward heading dir ───
     Lower grip → more sliding (drift, grass).
     Higher grip → snappy alignment to heading (normal driving).
     Uses: alpha = 1 − e^(−grip × Δt)  for frame-rate independence. */
  const isOffTrack = nearestTrackDistance(k.pos.x, k.pos.z) > cfg.trackWidth / 2;
  let gripStrength = 14.0;  // on-track: very responsive
  if (k.drifting)  gripStrength = 3.5;  // drift: slow lateral alignment → visible slide
  if (isOffTrack)  gripStrength = 2.5;  // grass: slippery & heavy

  const gripAlpha = 1.0 - Math.exp(-gripStrength * delta);
  k.vx += (targetVx - k.vx) * gripAlpha;
  k.vz += (targetVz - k.vz) * gripAlpha;

  /* ── 8. OFF-TRACK DRAG & SMOKE ──────────────────────────────────*/
  if (isOffTrack) {
    k.speed *= Math.pow(cfg.offTrackDrag, delta);
    if (Math.random() < 0.35) {
      spawnParticle(
        k.pos.x + (Math.random() - 0.5), 0.1,
        k.pos.z + (Math.random() - 0.5), 0xbbbbbb, 0.5
      );
    }
  }

  /* ── 9. POSITION + WALL COLLISION ───────────────────────────────
     Move by actual velocity (vx/vz), not heading-derived velocity,
     so slides and drift carry the car in its real travel direction. */
  const nextX = k.pos.x + k.vx * delta;
  const nextZ = k.pos.z + k.vz * delta;
  const distToCenter = nearestTrackDistance(nextX, nextZ);
  const halfTrack    = cfg.trackWidth / 2;

  // Phase Shift: kart is intangible — skip wall collision entirely
  const phaseActive = (typeof AbilityManager !== 'undefined') && AbilityManager.isPhaseActive(k);

  if (!phaseActive && distToCenter > halfTrack + 0.8) {
    // Hard wall: push kart back inside, kill speed
    const wps = raceState.waypoints;
    let bestD = Infinity, nearestP = { x: 0, z: 0 };
    for (let i = 0; i < wps.length; i++) {
      const a = wps[i], b = wps[(i + 1) % wps.length];
      const dx = b.x - a.x, dz = b.z - a.z;
      const len2 = dx * dx + dz * dz;
      let t = ((nextX - a.x) * dx + (nextZ - a.z) * dz) / len2;
      t = Math.max(0, Math.min(1, t));
      const px = a.x + dx * t, pz = a.z + dz * t;
      const d = Math.hypot(nextX - px, nextZ - pz);
      if (d < bestD) { bestD = d; nearestP = { x: px, z: pz }; }
    }
    const pushX = (nextX - nearestP.x) / Math.max(bestD, 0.001);
    const pushZ = (nextZ - nearestP.z) / Math.max(bestD, 0.001);
    k.pos.x = nearestP.x + pushX * (halfTrack - 0.5);
    k.pos.z = nearestP.z + pushZ * (halfTrack - 0.5);
    // Kill speed and re-sync velocity to heading direction
    k.speed *= 0.4;
    k.vx = fwdX * k.speed;
    k.vz = fwdZ * k.speed;
    if (k.isPlayer) {
      raceState.screenShake = Math.min(1.2, Math.abs(k.speed) * 0.04 + 0.3);
      for (let s = 0; s < 6; s++) {
        spawnParticle(k.pos.x + (Math.random()-0.5)*2, 0.2, k.pos.z + (Math.random()-0.5)*2, 0xdddddd, 0.7);
      }
    }
  } else {
    k.pos.x = nextX;
    k.pos.z = nextZ;
  }

  /* ── 10. SYNC LEGACY ALIASES ────────────────────────────────────
     k.vel and k.angle are read by AI, lap code, and collision.    */
  k.vel   = k.speed;
  k.angle = k.heading;

  /* ── 11. VISUAL: mesh faces VELOCITY direction, not heading ──────
     This is the key visual fix: the car model rotates toward where
     it is *actually travelling*, so drifts, slides, and early
     acceleration all look physically correct.

     Sign convention (Three.js):
       mesh.rotation.y = +angle → nose (at local +Z) faces world +Z when angle=0
       mesh.rotation.y = +π/2  → nose faces world +X  (heading π/2 = moving +X) ✓
     Using POSITIVE visualAngle (not negated) = correct orientation.           */
  const velMag = Math.hypot(k.vx, k.vz);
  if (velMag > 0.8) {
    // Angle of actual velocity in world space
    const velAngle = Math.atan2(k.vx, k.vz);
    // Smoothly lerp visualAngle toward velocity direction
    // Normal driving: fast alignment (18/s). Drift: slower (6/s) = visible slide.
    const alignRate = k.drifting ? 6.0 : 18.0;
    let diff = velAngle - k.visualAngle;
    while (diff >  Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    k.visualAngle += diff * (1.0 - Math.exp(-alignRate * delta));
  } else {
    // Stopped or very slow: snap visual to heading so it doesn't drift
    k.visualAngle = k.heading;
  }

  /* ── 12. APPLY MESH TRANSFORMS ──────────────────────────────────*/
  k.mesh.position.copy(k.pos);
  // Subtle bounce at speed
  k.mesh.position.y = Math.sin(performance.now() * 0.012 + k.mesh.id)
    * Math.min(0.08, absSpeed * 0.004);

  let visYaw = k.visualAngle;  // POSITIVE — correct Three.js orientation
  if (k.spinVisualTimer > 0) {
    k.spinVisualTimer -= delta;
    visYaw += k.spinVisualTimer * Math.PI * 2;  // spin on hit
  }
  k.mesh.rotation.y = visYaw;

  /* ── 13. WHEEL VISUALS ──────────────────────────────────────────
     Front wheels (indices 0,1 at local z=+0.85) turn with steering.
     All wheels spin proportional to actual speed.                 */
  const wheelSpin = absSpeed * delta * 2.5;
  k.wheels.forEach((w, i) => {
    if (i < 2) w.rotation.y = -(k.steering * 0.55); // front wheels steer (negated for correct visual direction)
    w.rotation.x += wheelSpin;
  });
}

/* ─── LAP COUNTER ───────────────────────────────────────────────── */
function updateLapProgress(k) {
  const wps = raceState.waypoints;
  const a = wps[k.lastWp], b = wps[k.nextWp];
  const dx = b.x - a.x, dz = b.z - a.z;
  const px = k.pos.x - b.x, pz = k.pos.z - b.z;
  if (dx * px + dz * pz > 0) {
    k.lastWp = k.nextWp;
    k.nextWp = (k.nextWp + 1) % wps.length;
    if (k.lastWp === 0) {
      k.lap++;
      if (k.lap >= RACE_CONFIG.lapsTotal) {
        k.finished = true;
        k.finishTime = raceState.elapsed;
        if (k.isPlayer) { raceState.playerFinishMsgTimer = 2.5; showRaceMsg('🏁 FINISH!'); }
      }
    }
  }
}

/* ─── COLLISIONS ────────────────────────────────────────────────── */
function handleRaceCollisions(delta) {
  const karts = raceState.karts;
  for (let i = 0; i < karts.length; i++) {
    const k = karts[i];
    if (k.finished) continue;

    raceState.itemBoxes.forEach(b => {
      if (!b.active) return;
      if (Math.hypot(k.pos.x - b.x, k.pos.z - b.z) < 3.0) {
        b.active = false; b.mesh.visible = false; b.respawnTimer = 8;
        if (!k.powerup) { k.powerup = pickRandomItem(k.position); if (k.isPlayer) updateRaceHUD(); }
      }
    });

    raceState.boostRamps.forEach(r => {
      if (Math.hypot(k.pos.x - r.x, k.pos.z - r.z) < 4.5) applyBoost(k, 1.2);
    });

    for (let j = i + 1; j < karts.length; j++) {
      const other = karts[j];
      if (other.finished) continue;
      const dx = other.pos.x - k.pos.x, dz = other.pos.z - k.pos.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < 2.4) {
        // Push karts apart spatially first
        const overlap = (2.4 - dist) / 2;
        const nx = dx / (dist || 1), nz = dz / (dist || 1);
        k.pos.x     -= nx * overlap;  k.pos.z     -= nz * overlap;
        other.pos.x += nx * overlap;  other.pos.z += nz * overlap;
        // Then swap a fraction of forward speed (speed bump feel)
        const speedTransfer = 0.25;
        const kForward   = Math.sin(k.angle)     * k.vel;
        const otherForward = Math.sin(other.angle) * other.vel;
        k.vel     -= (kForward     - otherForward) * speedTransfer;
        other.vel += (kForward     - otherForward) * speedTransfer;
        // Stun weaker kart if boosted kart rams them
        if (k.boostTimer > 0 && other.boostTimer <= 0) { other.stunnedTimer = 1.0; other.spinVisualTimer = 0.8; }
        else if (other.boostTimer > 0 && k.boostTimer <= 0) { k.stunnedTimer = 1.0; k.spinVisualTimer = 0.8; }
      }
    }
  }
}

/* ─── PLAYER INPUT ──────────────────────────────────────────────── */
function updatePlayerKart(k, delta) {
  // Stun: bleed velocity, skip input
  if (k.stunnedTimer > 0) {
    k.stunnedTimer -= delta;
    k.vel *= Math.pow(0.3, delta);
    return;
  }

  // ── Read input ──────────────────────────────────────────────────
  let throttleInput = 0;
  if (racePlayerKeys['KeyW'] || racePlayerKeys['ArrowUp'])   throttleInput += 1;
  if (racePlayerKeys['KeyS'] || racePlayerKeys['ArrowDown']) throttleInput -= 1;
  let steerInput = 0;
  // Sign convention: positive k.steering → k.heading increases → car turns CCW from above
  // = screen-LEFT from behind-the-car camera. So A (left) = +1, D (right) = -1.
  if (racePlayerKeys['KeyA'] || racePlayerKeys['ArrowLeft'])  steerInput += 1;
  if (racePlayerKeys['KeyD'] || racePlayerKeys['ArrowRight']) steerInput -= 1;
  if (isMobile) {
    if (Math.abs(touchJoystickY) > 0.15) throttleInput -= touchJoystickY;
    if (Math.abs(touchJoystickX) > 0.15) steerInput   -= touchJoystickX; // joystick-right → screen-right → heading-
  }
  steerInput = Math.max(-1, Math.min(1, steerInput));

  // ── Drift detection ──────────────────────────────────────────────
  const driftPressed = racePlayerKeys['Space'];
  if (driftPressed && !k.drifting && Math.abs(steerInput) > 0.3 && k.vel > 12) {
    k.drifting = true; k.driftDir = Math.sign(steerInput); k.driftTime = 0;
  }
  if (k.drifting) {
    k.driftTime = (k.driftTime || 0) + delta;
    if (!driftPressed || k.vel < 6) {
      if (k.driftTime > 2.0) applyBoost(k, 1.5);
      k.drifting = false; k.driftTime = 0;
    }
  }

  // ── Set physics inputs (updateKartPhysics does the rest) ─────────
  // Braking: when pressing back while moving forward, apply brakes instead of reverse
  if (throttleInput < 0 && k.vel > 2) {
    k.engineForce = -RACE_CONFIG.brake; // strong brake
  } else {
    k.engineForce = throttleInput * RACE_CONFIG.accel;
  }
  k.steering = steerInput;
}

/* ─── HUD ───────────────────────────────────────────────────────── */
function updateRaceHUD() {
  if (!raceState) return;
  const p = raceState.karts[0];
  if (!p) return;
  document.getElementById('race-lap-num').textContent   = Math.min(RACE_CONFIG.lapsTotal, p.lap + 1);
  document.getElementById('race-lap-total').textContent = RACE_CONFIG.lapsTotal;
  document.getElementById('race-pos-num').textContent   = p.position || 1;
  const suf = ['ST', 'ND', 'RD', 'TH', 'TH', 'TH'];
  document.getElementById('race-pos-sfx').textContent   = suf[(p.position || 1) - 1] || 'TH';
  const icon = document.getElementById('race-item-icon');
  if (p.powerup) { icon.textContent = itemIcon(p.powerup); icon.classList.add('has-item'); }
  else           { icon.textContent = '—'; icon.classList.remove('has-item'); }
}

/* ─── SPEEDOMETER ───────────────────────────────────────────────── */
function updateSpeedometer(speed) {
  const el = document.getElementById('race-speedo-value');
  if (!el) return;
  const kmh = Math.round(Math.abs(speed) * 4.2); // scale to feel like real mph
  el.textContent = kmh;

  const needle = document.getElementById('race-speedo-needle');
  if (!needle) return;
  // Needle sweeps from -140deg (0 speed) to +140deg (max)
  const pct = Math.min(1, Math.abs(speed) / RACE_CONFIG.maxSpeed);
  const deg = -140 + pct * 280;
  needle.style.transform = `rotate(${deg}deg)`;

  // Color shifts gold → white → cyan on boost
  const hue = speed > RACE_CONFIG.maxSpeed * 0.9 ? '#00ffff' : (speed > RACE_CONFIG.maxSpeed * 0.6 ? '#ffffff' : '#c9a84c');
  needle.style.borderTopColor = hue;
}

/* ─── COUNTDOWN ─────────────────────────────────────────────────── */
function showCountdown(text) {
  const el = document.getElementById('race-countdown');
  el.textContent = text;
  el.classList.remove('active');
  void el.offsetWidth;
  el.classList.add('active');
}

/* ─── FINISH ────────────────────────────────────────────────────── */
function showRaceFinish() {
  const finalOrder = raceState.karts.slice().sort((a, b) => {
    if (a.finished && b.finished) return a.finishTime - b.finishTime;
    if (a.finished) return -1;
    if (b.finished) return 1;
    return b.progress - a.progress;
  });
  const results = document.getElementById('race-results');
  results.innerHTML = '';
  finalOrder.forEach((k, idx) => {
    const row = document.createElement('div');
    row.className = 'race-result-row' + (k.isPlayer ? ' player' : '');
    const suf = ['ST', 'ND', 'RD', 'TH', 'TH', 'TH'];
    const timeStr = k.finished
      ? `${Math.floor(k.finishTime / 60)}:${Math.floor(k.finishTime % 60).toString().padStart(2, '0')}.${Math.floor((k.finishTime % 1) * 100).toString().padStart(2, '0')}`
      : 'DNF';
    row.innerHTML = `<span class="rr-pos">${idx + 1}${suf[idx] || 'TH'}</span><span class="rr-name">${k.label}</span><span class="rr-time">${timeStr}</span>`;
    results.appendChild(row);
  });
  const playerPos = finalOrder.findIndex(k => k.isPlayer) + 1;
  const title = playerPos === 1 ? '🏆 VICTORY!' : (playerPos <= 3 ? '🏁 PODIUM FINISH' : '🏁 RACE FINISHED');
  document.getElementById('race-finish-title').textContent = title;
  document.getElementById('race-finish').style.display = 'flex';
}

/* ─── PARTICLE HELPER ───────────────────────────────────────────── */
function spawnParticle(x, y, z, color, life) {
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.2, 4, 4),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.6 })
  );
  mesh.position.set(x, y, z);
  scene.add(mesh);
  raceState.particles.push({ mesh, life, maxLife: life });
}

/* ─── MAIN RACE LOOP ────────────────────────────────────────────── */
function animateRace() {
  animFrameId = requestAnimationFrame(animateRace);
  const now = performance.now();
  dt = Math.min((now - lastTime) / (1000 / 60), 3.0);
  lastTime = now;
  const delta = dt / 60; // seconds
  if (!raceState) { if (renderer && scene && camera) renderer.render(scene, camera); return; }

  // ── Countdown ──
  if (!raceState.started) {
    const prev = raceState.countdown;
    raceState.countdown -= delta;
    const cd = raceState.countdown;
    const prevLabel = Math.ceil(prev), curLabel = Math.ceil(cd);
    if (prevLabel !== curLabel) {
      if (curLabel === 3) showCountdown('3');
      else if (curLabel === 2) showCountdown('2');
      else if (curLabel === 1) showCountdown('1');
      else if (curLabel === 0) {
        showCountdown('GO!');
        raceState.started = true;
        raceState.startTime = performance.now() / 1000;
        setTimeout(() => document.getElementById('race-countdown').classList.remove('active'), 2000);
      }
    }
    if (cd <= -0.8) document.getElementById('race-countdown').classList.remove('active');
  }

  if (raceState.started && !raceState.finished) raceState.elapsed += delta;

  // ── Per-kart update ──
  raceState.karts.forEach(k => {
    if (!raceState.started) { k.vel *= Math.pow(0.1, delta); return; }
    if (k.finished) {
      k.vel *= Math.pow(0.2, delta);
    } else {
      if (k.boostTimer > 0) k.boostTimer = Math.max(0, k.boostTimer - delta);
      if (k.shieldTimer > 0) {
        k.shieldTimer = Math.max(0, k.shieldTimer - delta);
        if (k.shieldTimer <= 0 && k.shieldMesh) { k.mesh.remove(k.shieldMesh); k.shieldMesh = null; }
      }
      if (k.invincibleTimer > 0) k.invincibleTimer = Math.max(0, k.invincibleTimer - delta);
      if (k.isPlayer) updatePlayerKart(k, delta);
      else            advancedBotUpdate(k, delta);  // botAI.js
    }
    updateKartPhysics(k, delta);
    if (!k.finished) updateLapProgress(k);
  });

  if (raceState.started) handleRaceCollisions(delta);
  if (typeof AbilityManager !== 'undefined') AbilityManager.update(delta);
  updatePositions();

  // ── Race end check ──
  if (raceState.started && !raceState.finished) {
    const p = raceState.karts[0];
    if (p.finished) {
      raceState.endGraceTimer = (raceState.endGraceTimer || 0) + delta;
      if (raceState.endGraceTimer > 6 || raceState.karts.every(k => k.finished)) {
        raceState.finished = true;
        setTimeout(showRaceFinish, 900);
      }
    }
  }

  // Countdown cleanup safety
  if (raceState.started && raceState.countdown > -2.0) {
    const elapsedSinceStart = (performance.now() / 1000) - raceState.startTime;
    if (elapsedSinceStart > 2.0) {
      document.getElementById('race-countdown').classList.remove('active');
      document.getElementById('race-countdown').style.display = 'none';
    }
  }

  raceState.itemBoxes.forEach(b => b.update(delta));

  // ── Shells ──
  for (let i = raceState.shells.length - 1; i >= 0; i--) {
    const s = raceState.shells[i];
    s.life -= delta;
    if (s.life <= 0) { scene.remove(s.mesh); raceState.shells.splice(i, 1); continue; }
    if (s.type === 'blue') {
      const leader = raceState.karts.find(k => k.position === 1);
      if (leader && leader !== s.owner) {
        const toLeader = new THREE.Vector3().subVectors(leader.pos, s.pos).normalize();
        const targetAngle = Math.atan2(toLeader.x, toLeader.z);
        let diff = targetAngle - s.angle;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        s.angle += diff * 5 * delta;
      }
    }
    s.pos.x += Math.sin(s.angle) * 55 * delta;
    s.pos.z += Math.cos(s.angle) * 55 * delta;
    s.mesh.position.copy(s.pos);
    s.mesh.rotation.y = -s.angle;
    raceState.karts.forEach(k => {
      if (k === s.owner && s.life > 4.5) return;
      if (k.finished) return;
      if (k.pos.distanceTo(s.pos) < 3.0) {
        if (k.shieldTimer > 0) {
          k.shieldTimer = 0;
          if (k.shieldMesh) { k.mesh.remove(k.shieldMesh); k.shieldMesh = null; }
          if (k.isPlayer) showRaceMsg('🛡️ SHIELD BLOCKED!');
        } else if (k.invincibleTimer <= 0) {
          k.stunnedTimer = 2.0; k.spinVisualTimer = 2.0;
          if (k.isPlayer) showRaceMsg('🐚 HIT!');
        }
        s.life = 0;
      }
    });
  }

  // ── Camera (lerp-smoothed, frame-rate independent) ──
  const p = raceState.karts[0];
  if (!p) return;

  // FOV shift during boost
  const targetFOV = p.boostTimer > 0 ? 95 : 70;
  camera.fov += (targetFOV - camera.fov) * (1 - Math.pow(0.01, delta));
  camera.updateProjectionMatrix();

  // Screen shake: wall hit or boost
  let shakeX = 0, shakeY = 0;
  if (raceState.screenShake > 0) {
    shakeX = (Math.random() - 0.5) * raceState.screenShake;
    shakeY = (Math.random() - 0.5) * raceState.screenShake * 0.5;
    raceState.screenShake *= Math.pow(0.05, delta); // rapid decay
    if (raceState.screenShake < 0.01) raceState.screenShake = 0;
    renderer.domElement.style.transform = `translate(${shakeX * 8}px,${shakeY * 8}px)`;
  } else if (p.boostTimer > 0) {
    shakeX = (Math.random() - 0.5) * 0.15;
    shakeY = (Math.random() - 0.5) * 0.08;
    renderer.domElement.style.transform = `translate(${shakeX * 8}px,${shakeY * 8}px)`;
  } else {
    renderer.domElement.style.transform = '';
  }

  const camDist   = 11 + Math.min(10, Math.abs(p.vel) * 0.2);
  const camHeight = 4.8 + Math.abs(p.vel) * 0.06;

  // Angle follow — exponential lerp (frame-rate independent)
  if (raceState.camAngle === undefined) raceState.camAngle = p.angle;
  let diff = p.angle - raceState.camAngle;
  while (diff > Math.PI)  diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  raceState.camAngle += diff * (1 - Math.pow(0.008, delta)); // smooth, frame-rate independent

  const targetX = p.pos.x - Math.sin(raceState.camAngle) * camDist;
  const targetZ = p.pos.z - Math.cos(raceState.camAngle) * camDist;

  // Position lerp — exponential (frame-rate independent)
  const posAlpha = 1 - Math.pow(0.015, delta);
  camera.position.x += (targetX        - camera.position.x) * posAlpha + shakeX;
  camera.position.z += (targetZ        - camera.position.z) * posAlpha + shakeY;
  camera.position.y += (camHeight      - camera.position.y) * posAlpha;

  camera.lookAt(p.pos.x + Math.sin(p.angle) * 6, 1.4, p.pos.z + Math.cos(p.angle) * 6);

  // ── Visual particles ──
  raceState.karts.forEach(k => {
    if (k.boostTimer > 0 && Math.random() < 0.7) {
      const f = new THREE.Mesh(
        new THREE.SphereGeometry(0.25 + Math.random() * 0.25, 5, 5),
        new THREE.MeshBasicMaterial({ color: Math.random() < 0.5 ? 0xff6a00 : 0xffcc44, transparent: true, opacity: 0.9 })
      );
      f.position.set(k.pos.x - Math.sin(k.angle) * 1.3 + (Math.random() - 0.5) * 0.4, 0.5 + Math.random() * 0.4, k.pos.z - Math.cos(k.angle) * 1.3 + (Math.random() - 0.5) * 0.4);
      scene.add(f);
      raceState.particles.push({ mesh: f, life: 0.35, maxLife: 0.35 });
    }
  });

  // Drift smoke
  if (p.drifting && Math.abs(p.vel) > 5 && Math.random() < 0.4) {
    spawnParticle(p.pos.x + (Math.random() - 0.5), 0.2, p.pos.z + (Math.random() - 0.5), 0xffffff, 0.6);
  }

  // Boost wind lines
  if (p.boostTimer > 0) {
    if (Math.random() < 0.4) spawnParticle(p.pos.x + (Math.random() - 0.5), 0.5, p.pos.z + (Math.random() - 0.5), 0x00ffff, 0.8);
    for (let i = 0; i < 2; i++) {
      const wf = new THREE.Mesh(
        new THREE.BoxGeometry(0.04, 0.04, 3 + Math.random() * 4),
        new THREE.MeshBasicMaterial({ color: 0xccf0ff, transparent: true, opacity: 0.35 })
      );
      wf.position.set(p.pos.x + (Math.random() - 0.5) * 18, p.pos.y + Math.random() * 10, p.pos.z + (Math.random() - 0.5) * 18);
      wf.rotation.y = -p.angle;
      scene.add(wf);
      raceState.particles.push({ mesh: wf, life: 0.12, maxLife: 0.12, type: 'wind' });
    }
  }

  // Particle GC
  for (let i = raceState.particles.length - 1; i >= 0; i--) {
    const pp = raceState.particles[i];
    pp.life -= delta;
    if (pp.life <= 0) { scene.remove(pp.mesh); raceState.particles.splice(i, 1); }
    else {
      pp.mesh.material.opacity = Math.max(0, (pp.life / pp.maxLife) * 0.6);
      if (pp.type === 'wind') {
        pp.mesh.position.x += Math.sin(p.angle) * 3.5;
        pp.mesh.position.z += Math.cos(p.angle) * 3.5;
      } else {
        pp.mesh.scale.setScalar(0.5 + (1 - pp.life / pp.maxLife) * 1.4);
      }
    }
  }

  if (raceState.skyDome) raceState.skyDome.position.set(p.pos.x, 0, p.pos.z);

  updateRaceHUD();
  updateSpeedometer(Math.hypot(p.vx, p.vz));
  renderer.render(scene, camera);
}
