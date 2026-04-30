const ObbyManager = (function () {
  'use strict';

  const COURSE_END_Z = 2600;  // was 4000 — ~35% shorter, keeps challenge without overstaying welcome
  const HUB_INTERVAL = 650;   // was 800 — 3 checkpoints at z=650, 1300, 1950
  const HUB_LAUNCH_HEIGHT = 50;
  const SPAWN = new THREE.Vector3(0, 2, 0);
  const SPAWN_SAFE_RADIUS = 20;
  const FOOT = 1.0;
  const PLAYER_RADIUS = 0.5;
  const BASE_JUMP       = 20;    // tuned for longer course
  const DOUBLE_JUMP_VEL = 17;    // weaker than normal
  const MOVE_SPEED      = 14;
  const SPRINT_SPEED    = 22;    // Shift to sprint
  const GRAVITY         = 34;    // tuned for better physics feel
  const BASE_FOV        = 70;
  const SPRINT_FOV      = 82;    // slight FOV push when sprinting
  const DASH_FOV        = 100;   // hard spike on dash
  const COYOTE_TIME     = 0.12;  // seconds of jump grace after walking off edge
  const DASH_SPEED      = 38;    // units/s during active dash
  const DASH_DURATION   = 0.20;  // how long the burst lasts (s)
  const DASH_CD         = 1.6;   // cooldown (s)

  let _obbyGroup = null;
  let _decoGroup = null;
  let _ps = null;
  let _shadow = null;
  let _glow = null;
  let _respawnPoint = SPAWN.clone();

  let _platforms = [];
  let _windZones = [];
  let _jumpPads = [];
  let _checkpoints = [];
  let _laserFences = [];
  let _crusherGates = [];
  let _glassWalkways = [];

  let _gridTexture = null;
  let _lastHubZ = 0;
  let _currentLayer = 0;
  let _runTimer = 0;
  let _deathCount = 0;
  let _gt = 0;
  let _dashCd = 0;
  let _lastSectorVisual = 0;   // tracks last sector for sky/fog transitions
  let _obbyACtx = null;        // Web Audio context for obby sounds

  const _vel = new THREE.Vector3();
  const _constantVelocity = new THREE.Vector3();
  let _isGrounded = false;
  let _jumpCount = 0;
  let _wasSpace = false;

  /* movement feel */
  let _coyoteT = 0;
  let _isSprinting = false, _isMoving = false;
  let _fovCurrent = BASE_FOV;

  /* dash state */
  let _dashActive = false, _dashT = 0;
  let _dashDX = 0, _dashDZ = 0;   // normalised direction
  let _dashTrailT = 0;             // trail emit timer
  let _inputLockT = 0;

  /* particle pool for walk/run VFX + dash VFX */
  let _particles = [];
  let _particleEmitT = 0;

  /* gravity inversion */
  let _gravityDir = 1;           // 1 = normal, -1 = inverted
  let _gravGateCooldown = 0;     // seconds before another gate can trigger

  /* new mechanic arrays */
  let _fadingPlatforms = [];
  let _gravityGates = [];
  let _movingPlatforms = [];  // { mesh, rec, baseX, baseY, axis, amp, speed, phase }
  let _crumblingPlatforms = []; // { mesh, rec, mat, state, timer } — state: 0=idle,1=shaking,2=fallen
  let _obbyBoostPads = []; // { mesh, x, y, z, dir } — forward launch pads

  /* Pre-cached colors — avoids GC pressure from new THREE.Color() inside the loop */
  const _COL_CRUMBLE_SHAKE   = new THREE.Color(0xff2200);
  const _COL_CRUMBLE_RESPAWN = new THREE.Color(0x441100);

  /* LOD culling */
  let _lodTimer = 0;
  const LOD_CULL_DIST = 700;  // units ahead/behind player
  const LOD_CULL_INTERVAL = 0.12; // seconds between culling passes

  function init() {
    _resetWorld();
    _prepareGridTexture();
    _lastSectorVisual = 0;
    _applySectorVisuals(1);   // sector 1 sky on init
    _createStarfield();
    _buildNeoCircuit();
    _createPlayer();
    _updateHUD();
  }

  function cleanup() {
    _disposeGroup(_obbyGroup);
    _disposeGroup(_decoGroup);
    if (_ps) scene.remove(_ps);
    if (_shadow) scene.remove(_shadow);
    if (_glow) { scene.remove(_glow); _glow = null; }
    if (_gridTexture) _gridTexture.dispose();
    _particles.forEach(p => { scene.remove(p.mesh); p.mesh.geometry.dispose(); p.mesh.material.dispose(); });
    _particles = [];
    _obbyGroup = null;
    _decoGroup = null;
    _ps = null;
    if (camera) { camera.fov = BASE_FOV; camera.updateProjectionMatrix(); }
  }

  function restart() {
    cleanup();
    init();
  }

  function triggerDash() {
    if (!_ps || _dashCd > 0 || _dashActive) return;

    /* direction: respect WASD input; fall back to camera-forward */
    const yaw = (cameraTheta * Math.PI) / 180;
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const rx = -Math.cos(yaw), rz = Math.sin(yaw);
    let dx = 0, dz = 0;
    if (keys['KeyW']||keys['ArrowUp'])    { dx+=fx; dz+=fz; }
    if (keys['KeyS']||keys['ArrowDown'])  { dx-=fx; dz-=fz; }
    if (keys['KeyA']||keys['ArrowLeft'])  { dx-=rx; dz-=rz; }
    if (keys['KeyD']||keys['ArrowRight']) { dx+=rx; dz+=rz; }
    const dl = Math.hypot(dx, dz);
    if (dl < 0.01) { dx = fx; dz = fz; }  // no key held → dash forward
    else           { dx /= dl; dz /= dl; }

    _dashDX = dx; _dashDZ = dz;
    _dashActive = true;
    _dashT = DASH_DURATION;
    _dashTrailT = 0;
    _dashCd = DASH_CD;

    /* small upward kick so the dash feels like a blink-leap, not a floor-scrape */
    if (_vel.y < 5) _vel.y = 5;

    /* instant FOV spike — lerp in _updateVisuals will carry it back down */
    _fovCurrent = DASH_FOV;

    /* burst of afterimage particles at launch position */
    _spawnDashBurst();
    if (typeof tryEvilScreamer === 'function') tryEvilScreamer(0.02);
  }

  function _spawnDashBurst() {
    /* 12 particles in a ring + 3 forward-streaking spikes */
    for (let i = 0; i < 15; i++) {
      const p = _particles.find(q => q.life <= 0);
      if (!p) break;
      const isSpike = i >= 12;
      const ang = (i / 12) * Math.PI * 2 + Math.random() * 0.4;
      p.mesh.visible = true;
      p.mesh.position.set(
        _ps.position.x + (isSpike ? _dashDX * 0.5 : Math.cos(ang) * 0.6),
        _ps.position.y + (Math.random() - 0.3) * 1.2,
        _ps.position.z + (isSpike ? _dashDZ * 0.5 : Math.sin(ang) * 0.6)
      );
      /* ring particles: explode outward perpendicular to dash */
      const perp = isSpike ? 0 : 1;
      p.vx = isSpike ? _dashDX * 8 : Math.cos(ang) * (5 + Math.random() * 4) * perp;
      p.vy = 2 + Math.random() * 3;
      p.vz = isSpike ? _dashDZ * 8 : Math.sin(ang) * (5 + Math.random() * 4) * perp;
      p.maxLife = isSpike ? 0.18 : 0.28 + Math.random() * 0.12;
      p.life = p.maxLife;
      p.mesh.material.color.setHex(0xffffff);  // burst = white flash
      p.mesh.scale.setScalar(isSpike ? 2.2 : 1.4);
      p.mesh.material.opacity = 1.0;
    }
  }

  function update(delta) {
    if (!_ps) return;
    _gt += delta;
    _runTimer += delta;
    _updateDynamicObstacles(delta);
    _updatePlayer(delta);
    _updateCamera(delta);
    _updateVisuals(delta);
    _updateHUD();
    /* LOD: cull distant meshes every N seconds */
    _lodTimer += delta;
    if (_lodTimer >= LOD_CULL_INTERVAL) {
      _lodTimer = 0;
      _cullDistantMeshes();
    }
  }

  function _cullDistantMeshes() {
    if (!_ps) return;
    const pz = _ps.position.z;
    for (let i = 0; i < _platforms.length; i++) {
      const rec = _platforms[i];
      rec.mesh.visible = Math.abs(rec.z - pz) <= LOD_CULL_DIST;
    }
  }

  function _resetWorld() {
    _disposeGroup(_obbyGroup);
    _disposeGroup(_decoGroup);
    _obbyGroup = new THREE.Group();
    _decoGroup = new THREE.Group();
    scene.add(_obbyGroup);
    scene.add(_decoGroup);

    _platforms = [];
    _windZones = [];
    _jumpPads = [];
    _checkpoints = [];
    _laserFences = [];
    _crusherGates = [];
    _glassWalkways = [];

    _vel.set(0, 0, 0);
    _constantVelocity.set(0, 0, 0);
    _isGrounded = false;
    _jumpCount = 0;
    _wasSpace = false;
    _dashCd = 0;
    _runTimer = 0;
    _deathCount = 0;
    _gt = 0;
    _lastHubZ = 0;
    _currentLayer = 0;
    _respawnPoint.copy(SPAWN);
    scene.gravity = { y: -9.8 };
    _coyoteT = 0; _isSprinting = false; _isMoving = false;
    _fovCurrent = BASE_FOV; _particleEmitT = 0;
    _dashActive = false; _dashT = 0; _dashDX = 0; _dashDZ = 0; _dashTrailT = 0;
    _inputLockT = 0;
    _gravityDir = 1; _gravGateCooldown = 0;
    _fadingPlatforms = []; _gravityGates = [];
    _movingPlatforms = []; _crumblingPlatforms = []; _obbyBoostPads = [];
    _lodTimer = 0;

    /* build / recycle particle pool — 32 slots for walk + dash VFX */
    _particles.forEach(p => scene.remove(p.mesh));
    _particles = [];
    const pGeo = new THREE.SphereGeometry(0.07, 4, 4);
    for (let i = 0; i < 32; i++) {
      const pm = new THREE.Mesh(pGeo, new THREE.MeshBasicMaterial({
        color: 0x44aaff, transparent: true, opacity: 0, depthWrite: false
      }));
      pm.visible = false;
      scene.add(pm);
      _particles.push({ mesh: pm, life: 0, maxLife: 0, vx: 0, vy: 0, vz: 0 });
    }
  }

  function _buildNeoCircuit() {
    let sectionOffsetX = 0;
    let z = 0;
    let y = 0.5;
    let prev = _mkPlatform(0, y, z, 14, 1, 14, 1, false);

    // Fixed Z milestones for launch set-pieces (one per sector 1-3)
    const _launchMilestones = [230, 880, 1550];
    let _nextLaunchIdx = 0;

    while (z < COURSE_END_Z - 20) {
      /* ── hub (checkpoint) every HUB_INTERVAL units ── */
      const nextHubZ = Math.ceil((z + 1) / HUB_INTERVAL) * HUB_INTERVAL;
      if (nextHubZ - z <= 20 && nextHubZ <= COURSE_END_Z - 20 && nextHubZ !== _lastHubZ) {
        const hub = _mkHub(nextHubZ, y, sectionOffsetX);
        prev = hub.exitPlatform;
        z = hub.z; y = hub.y; sectionOffsetX = hub.sectionOffsetX;
        _lastHubZ = nextHubZ;
        continue;
      }

      /* ── launch set-piece at fixed milestones ── */
      if (_nextLaunchIdx < _launchMilestones.length && z >= _launchMilestones[_nextLaunchIdx] - 10) {
        const lz = _launchMilestones[_nextLaunchIdx];
        _nextLaunchIdx++;
        const sec = _sectorFromZ(lz);
        // Bridge platform so the player doesn't have to gap-jump onto the ramp
        _mkPlatform(sectionOffsetX, y, lz - 14, 12, 1, 10, sec, false);
        const landing = _mkLaunchSection(sectionOffsetX, y, lz, sec);
        // Continue from the catch platform
        prev = landing;
        z = landing.z + 14; // skip past catch platform
        y = landing.y;
        sectionOffsetX = landing.x;
        continue;
      }

      /* ── sector-scaling difficulty ── */
      const sector = _sectorFromZ(z);                  // 1-4 across 2600 units
      const minGap  = 14 + sector * 2;                 // grows 16 → 22
      const maxGap  = 22 + sector * 3;                 // grows 25 → 34
      const gap     = minGap + Math.random() * (maxGap - minGap);
      const pSize   = Math.max(4, 10 - sector);        // shrinks 9 → 6 (floor raised slightly)

      const nextZ = Math.min(COURSE_END_Z - 20, z + gap);
      if (nextZ <= z) break;

      const nextY = y + (Math.random() - 0.4) * 7;
      let nextX = sectionOffsetX + (Math.random() - 0.5) * 18;

      /* overlap guard */
      if (_intersectsAny(_makeAabb(nextX, nextY, nextZ, pSize + 2, 2, pSize + 2))) {
        nextX += (Math.random() > 0.5 ? 20 : -20);
      }

      /* ── platform type by sector ── */
      let p;
      const rng = Math.random();
      if (sector >= 3 && rng > 0.65) {
        p = _mkFadingPlatform(nextX, nextY, nextZ, pSize);     // sector 3+: fading
      } else if (sector >= 2 && rng > 0.80) {
        // Moving platform — slides left/right in sector 2+, up/down in sector 3+
        const axis = (sector >= 3 && Math.random() > 0.5) ? 'y' : 'x';
        const amp  = 3 + Math.random() * 4;   // ±3 to ±7 units
        const spd  = 0.8 + Math.random() * 1.2;
        p = _mkMovingPlatform(nextX, nextY, nextZ, pSize, axis, amp, spd);
      } else if (sector >= 2 && rng > 0.70) {
        p = _mkCrumblingPlatform(nextX, nextY, nextZ, pSize);  // sector 2+: crumbling
      } else {
        p = _mkPlatform(nextX, nextY, nextZ, pSize, 1, pSize, sector, false);
      }

      /* small speed pads — sector 1 only, mild hop assist */
      if (sector === 1 && Math.random() < 0.10) {
        _mkObbyBoostPad(p.x, p.y + 0.5, p.z);
      }

      /* gravity gate in sector 4 at regular intervals */
      if (sector === 4 && z % 200 < 30) {
        _mkGravityGate(nextX, nextY + 9, nextZ);
      }

      /* carry over existing hazard logic */
      if (Math.abs(nextY - y) > 6)         _mkJumpPad((prev.x + p.x) * 0.5, (prev.y + p.y) * 0.5, (prev.z + p.z) * 0.5);
      if (sector >= 3 && Math.random() < 0.22) _mkSlalomSection(p.x, p.y + 1.6, p.z + 8);
      if (sector >= 4 && Math.random() < 0.18) _mkCrusherGate(p.x, p.y + 7, p.z + 6);
      if (sector >= 2 && Math.random() < 0.2)  _mkGlassWalkway(p.x + (Math.random() < 0.5 ? -6 : 6), p.y, p.z + 7, sector);

      prev = p;
      z = nextZ; y = nextY; sectionOffsetX = nextX;
    }

    _mkPlatform(sectionOffsetX, y + 1, COURSE_END_Z, 22, 2, 22, 5, true);
    _scatterLightBeams();
  }

  function _mkHub(hubZ, baseY, sectionOffsetX) {
    const hub = _mkPlatform(sectionOffsetX, baseY, hubZ, 24, 1.2, 24, _sectorFromZ(hubZ), false);
    _mkCheckpointRing(hub.x, hub.y + 2.8, hub.z);
    /* height synced to HUB_LAUNCH_HEIGHT so the elevator actually reaches the exit pad */
    _mkWindElevator(hub.x, hub.y, hub.z, 4.5, HUB_LAUNCH_HEIGHT + 5, 55);

    const exitY = baseY + HUB_LAUNCH_HEIGHT;
    const exitX = sectionOffsetX + (Math.random() < 0.5 ? 12 : -12);
    const exitZ = Math.min(COURSE_END_Z - 12, hubZ + 10);
    const exit = _mkPlatform(exitX, exitY, exitZ, 12, 1, 12, _sectorFromZ(exitZ), false);
    return { exitPlatform: exit, z: exitZ, y: exitY, sectionOffsetX: exit.x };
  }

  /* Per-sector platform palettes — defined once, reused each call */
  const _SECTOR_PAL = [
    null,
    { main: 0x0088ff, emit: 0x003399 },  // S1: blue space station
    { main: 0xff4400, emit: 0x771100 },  // S2: volcanic orange-red
    { main: 0xcc00ff, emit: 0x550077 },  // S3: neon void purple
    { main: 0xddeeff, emit: 0x2244cc },  // S4: electric white datacenter
  ];

  function _mkPlatform(x, y, z, w, h, d, sector, isFinish) {
    const pal = _SECTOR_PAL[Math.min(4, Math.max(1, sector || 1))];
    const tint = new THREE.Color(isFinish ? 0xd4af37 : pal.main);
    const emitC = new THREE.Color(isFinish ? 0x775811 : pal.emit);
    const mat = new THREE.MeshPhongMaterial({
      color: tint,
      emissive: emitC,
      emissiveIntensity: isFinish ? 0.85 : 1.0,
      map: _gridTexture
    });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    mesh.position.set(x, y, z);
    _resolveOverlap(mesh);
    _obbyGroup.add(mesh);
    const rec = { mesh, x: mesh.position.x, y: mesh.position.y, z: mesh.position.z, w, h, d, collidable: true, isFinish: !!isFinish };
    _platforms.push(rec);
    return rec;
  }

  function _mkWindElevator(x, y, z, radius, height, fy) {
    if (_inSpawnSafeZone(x, y, z)) return;
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, height, 14, 1, true), new THREE.MeshBasicMaterial({ color: 0x66e0ff, transparent: true, opacity: 0.18, side: THREE.DoubleSide }));
    mesh.position.set(x, y + height * 0.5, z);
    _decoGroup.add(mesh);
    _windZones.push({ x, y: y + height * 0.5, z, w: radius * 2, h: height, d: radius * 2, fx: 0, fy, fz: 0 });
  }

  function _mkJumpPad(x, y, z) {
    if (_inSpawnSafeZone(x, y, z)) return;
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(2, 2, 0.42, 28), new THREE.MeshPhongMaterial({ color: 0xffd800, emissive: 0xffb200, emissiveIntensity: 1.0 }));
    mesh.position.set(x, y, z);
    _decoGroup.add(mesh);
    _jumpPads.push({ mesh, x, y, z, radius: 2, impulse: 30, pulseOffset: Math.random() * Math.PI * 2, animT: 0 });
  }

  function _mkSlalomSection(x, y, z) {
    /* ── Conveyor belt — redesigned ──────────────────────────────────
       Old: 14-wide × 22-deep wind zone, force=18 (violent), 3 fences crammed together.
       New: wide belt with gentle forward push, 5 fences spread across the full length.

       Layout: belt starts at z, extends BELT_D units forward.
       Wind zone center sits at the belt midpoint so the push effect
       covers the whole crossing, not just a tiny patch.             */
    const BELT_W     = 24;   // was 14 — wide enough to read as a lane, edges aren't instant death
    const BELT_D     = 52;   // was 22 — long enough to feel like a genuine belt section
    const BELT_FORCE = 9;    // was 18 — 0.64× player walk speed, a push not a shove
    const beltCenterZ = z + BELT_D * 0.5;

    // Actual platform surface for the conveyor belt (player can land on it)
    const beltMat = new THREE.MeshPhongMaterial({
      color: 0x0099cc, emissive: 0x002233, emissiveIntensity: 0.85,
      map: _gridTexture
    });
    const beltMesh = new THREE.Mesh(new THREE.BoxGeometry(BELT_W, 0.5, BELT_D), beltMat);
    beltMesh.position.set(x, y - 0.25, beltCenterZ);
    _obbyGroup.add(beltMesh);
    _platforms.push({
      mesh: beltMesh, x, y: y - 0.25, z: beltCenterZ,
      w: BELT_W, h: 0.5, d: BELT_D, collidable: true
    });

    // Wind zone — same footprint as the belt surface, centered, 6 units tall
    _windZones.push({ x, y: y + 3, z: beltCenterZ, w: BELT_W, h: 6, d: BELT_D, fx: 0, fy: 0, fz: BELT_FORCE });

    // 5 laser-fence obstacles, evenly spaced across the belt length, alternating sides
    const FENCE_COUNT  = 5;
    const firstFenceZ  = z + 8;
    const fenceSpacing = (BELT_D - 16) / (FENCE_COUNT - 1);   // ~9 units apart
    for (let i = 0; i < FENCE_COUNT; i++) {
      const fenceZ  = firstFenceZ + i * fenceSpacing;
      const side    = i % 2 === 0 ? -1 : 1;                   // alternate left/right
      const fence   = new THREE.Mesh(
        new THREE.BoxGeometry(1, 4, 10),
        new THREE.MeshBasicMaterial({ color: 0xff3366, transparent: true, opacity: 0.92 })
      );
      fence.position.set(x + side * 7, y + 2.5, fenceZ);
      _decoGroup.add(fence);
      _laserFences.push({
        mesh:  fence,
        baseX: fence.position.x,
        y:     fence.position.y,
        z:     fence.position.z,
        amp:   3,                     // was 4 — less swing on wider belt, still needs dodging
        speed: 0.7 + i * 0.18,        // was 1.2 + i * 0.3 — slower, more readable
        w: 1, h: 4, d: 10,
      });
    }
  }

  function _mkCrusherGate(x, y, z) {
    const slab = new THREE.Mesh(new THREE.BoxGeometry(10, 2, 3), new THREE.MeshPhongMaterial({ color: 0x9b8cff, emissive: 0x3a2a66, emissiveIntensity: 0.75 }));
    slab.position.set(x, y, z);
    _decoGroup.add(slab);
    _crusherGates.push({ mesh: slab, x, baseY: y, z, w: 10, h: 2, d: 3, range: 7, speed: 1.8 + Math.random() });
  }

  function _mkGlassWalkway(x, y, z, sector) {
    const start = new THREE.Color(0x00c8ff);
    const end = new THREE.Color(0x5a00a8);
    const tint = start.clone().lerp(end, Math.max(0, Math.min(1, (sector - 1) / 3)));
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(8, 0.8, 8), new THREE.MeshPhongMaterial({ color: tint, emissive: tint.clone().multiplyScalar(0.4), emissiveIntensity: 0.8, map: _gridTexture, transparent: true, opacity: 0.3 }));
    mesh.position.set(x, y, z);
    _obbyGroup.add(mesh);
    const p = { mesh, x, y, z, w: 8, h: 0.8, d: 8, collidable: true };
    _platforms.push(p);
    _glassWalkways.push(p);
  }

  function _mkCheckpointRing(x, y, z) {
    /* floating torus ring */
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(4.5, 0.4, 12, 52),
      new THREE.MeshBasicMaterial({ color: 0x00e5ff, transparent: true, opacity: 0.98 })
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.set(x, y, z);
    _decoGroup.add(ring);

    /* vertical light pillar beneath the ring */
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.6, 0.6, 14, 8, 1, true),
      new THREE.MeshBasicMaterial({ color: 0x00e5ff, transparent: true, opacity: 0.15, side: THREE.DoubleSide })
    );
    beam.position.set(x, y - 5, z);
    _decoGroup.add(beam);

    /* outer rotating orbit ring on the platform surface */
    const padRing = new THREE.Mesh(
      new THREE.TorusGeometry(3.2, 0.12, 6, 36),
      new THREE.MeshBasicMaterial({ color: 0x00ffcc, transparent: true, opacity: 0.75 })
    );
    padRing.rotation.x = Math.PI / 2;
    padRing.position.set(x, y - 2.6, z);
    _decoGroup.add(padRing);

    /* inner spinning diamond on the surface */
    const diamond = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.55),
      new THREE.MeshBasicMaterial({ color: 0x00ffff, transparent: true, opacity: 0.9 })
    );
    diamond.position.set(x, y - 1.0, z);
    _decoGroup.add(diamond);

    _checkpoints.push({ x, y, z, radius: 5.5, activated: false, ring, beam, padRing, diamond });
  }

  /* ── Space Void starfield ─────────────────────────────────────── */
  function _createStarfield() {
    /*
     * Performance budget: 2 draw calls total (merged white + colored).
     * Transparent BackSide spheres and separate point systems removed —
     * each extra draw call + transparency sort is expensive.
     */
    const TOTAL = 1800;
    const pos   = new Float32Array(TOTAL * 3);
    const col   = new Float32Array(TOTAL * 3); // vertex colors

    for (let i = 0; i < TOTAL; i++) {
      // Spread across the full course volume
      pos[i*3]   = (Math.random()-0.5) * 4000;
      pos[i*3+1] = (Math.random()-0.5) * 2400;
      pos[i*3+2] = (Math.random()-0.5) * 5000 + 2000;

      // Tint: mostly white, some blue, some gold
      const t = Math.random();
      if (t < 0.70) {
        col[i*3]=0.9; col[i*3+1]=0.9; col[i*3+2]=1.0;       // white-blue
      } else if (t < 0.88) {
        col[i*3]=0.55; col[i*3+1]=0.80; col[i*3+2]=1.0;     // blue
      } else {
        col[i*3]=1.0; col[i*3+1]=0.82; col[i*3+2]=0.50;     // gold
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color',    new THREE.BufferAttribute(col, 3));

    _decoGroup.add(new THREE.Points(geo, new THREE.PointsMaterial({
      vertexColors: true,
      size: 1.0,
      transparent: true,
      opacity: 0.55,
      sizeAttenuation: true,
      depthWrite: false, // skip depth write for transparent points — cheaper
    })));

    /* Second small cluster — galaxy smear near sector 4 (200 pts only) */
    const galQty = 200;
    const galPos = new Float32Array(galQty * 3);
    for (let i = 0; i < galQty; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 30 + Math.random() * 220;
      galPos[i*3]   = Math.cos(a) * r - 600;
      galPos[i*3+1] = (Math.random()-0.5)*30 + 260;
      galPos[i*3+2] = Math.sin(a) * r * 0.35 + 3300;
    }
    const galGeo = new THREE.BufferGeometry();
    galGeo.setAttribute('position', new THREE.BufferAttribute(galPos, 3));
    _decoGroup.add(new THREE.Points(galGeo, new THREE.PointsMaterial({
      color: 0xcce8ff, size: 1.5, transparent: true, opacity: 0.30,
      sizeAttenuation: true, depthWrite: false,
    })));
  }

  /* ── Fading platform (sector 3+) ─────────────────────────────── */
  function _mkFadingPlatform(x, y, z, size) {
    const sector = _sectorFromZ(z);
    const mat = new THREE.MeshPhongMaterial({
      color: 0xff2266, emissive: 0x550011, emissiveIntensity: 0.7,
      transparent: true, opacity: 1.0, map: _gridTexture
    });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(size, 1, size), mat);
    mesh.position.set(x, y, z);
    _resolveOverlap(mesh);
    _obbyGroup.add(mesh);
    /* edge glow trim */
    const trim = new THREE.Mesh(new THREE.BoxGeometry(size, 0.06, size),
      new THREE.MeshBasicMaterial({ color: 0xff88aa, transparent: true, opacity: 0.8 }));
    trim.position.set(x, y + 0.54, z);
    _decoGroup.add(trim);

    const rec = {
      mesh, x: mesh.position.x, y: mesh.position.y, z: mesh.position.z,
      w: size, h: 1, d: size, collidable: true, isFinish: false,
      isFading: true, fadeState: 0, fadeTimer: 0, mat
    };
    _platforms.push(rec);
    _fadingPlatforms.push(rec);
    return rec;
  }

  /* ── Moving platform ─────────────────────────────────────────── */
  function _mkMovingPlatform(x, y, z, size, axis, amp, speed) {
    const sector = _sectorFromZ(z);
    const start = new THREE.Color(0x00c8ff);
    const end   = new THREE.Color(0x5a00a8);
    const tint  = start.clone().lerp(end, Math.max(0, Math.min(1, (sector - 1) / 3)));
    const mat = new THREE.MeshPhongMaterial({
      color: tint, emissive: tint.clone().multiplyScalar(0.55), emissiveIntensity: 1.0,
      map: _gridTexture
    });
    // Arrow indicator strips showing movement direction
    const arrowCol = axis === 'x' ? 0x00ffff : 0xff8800;
    const arrowMat = new THREE.MeshBasicMaterial({ color: arrowCol, transparent: true, opacity: 0.75 });
    const arrowGeo = new THREE.BoxGeometry(axis === 'x' ? size * 0.6 : 0.4, 0.08, axis === 'x' ? 0.4 : size * 0.6);
    const arrow = new THREE.Mesh(arrowGeo, arrowMat);
    arrow.position.set(x, y + 0.56, z);

    const mesh = new THREE.Mesh(new THREE.BoxGeometry(size, 1, size), mat);
    mesh.position.set(x, y, z);
    _obbyGroup.add(mesh);
    _decoGroup.add(arrow);
    const rec = {
      mesh, x, y, z,
      w: size, h: 1, d: size, collidable: true, isFinish: false,
      isMoving: true
    };
    _platforms.push(rec);
    _movingPlatforms.push({
      mesh, rec, arrow, baseX: x, baseY: y, baseZ: z,
      axis, amp, speed, phase: Math.random() * Math.PI * 2
    });
    return rec;
  }

  /* ── Crumbling platform ───────────────────────────────────────── */
  function _mkCrumblingPlatform(x, y, z, size) {
    const mat = new THREE.MeshPhongMaterial({
      color: 0xcc6600, emissive: 0x441100, emissiveIntensity: 0.6,
      map: _gridTexture
    });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(size, 1, size), mat);
    mesh.position.set(x, y, z);
    _resolveOverlap(mesh);
    _obbyGroup.add(mesh);
    // Crack lines on top
    const crackMat = new THREE.MeshBasicMaterial({ color: 0x331100, transparent: true, opacity: 0.6 });
    for (let c = 0; c < 3; c++) {
      const crk = new THREE.Mesh(new THREE.BoxGeometry(size * 0.7, 0.06, 0.15), crackMat);
      crk.rotation.y = (c / 3) * Math.PI;
      crk.position.set(x + (Math.random()-0.5) * size * 0.3, y + 0.52, z + (Math.random()-0.5) * size * 0.3);
      _decoGroup.add(crk);
    }
    const rec = {
      mesh, x: mesh.position.x, y: mesh.position.y, z: mesh.position.z,
      w: size, h: 1, d: size, collidable: true, isFinish: false,
      isCrumbling: true
    };
    _platforms.push(rec);
    _crumblingPlatforms.push({ mesh, rec, mat, state: 0, timer: 0, origY: y });
    return rec;
  }

  /* ── Obby speed boost pad (small freeform pads scattered in sector 1) ── */
  function _mkObbyBoostPad(x, y, z) {
    _mkDirectedLaunchPad(x, y, z, 0, 1, 45, 15); // strong forward, tiny upward kick
  }

  /* ── Directed launch pad — core implementation ─────────────────────────
     dx/dz define the horizontal launch direction (will be normalised).
     launchSpd = horizontal speed units/s,  upSpd = upward impulse.
     Pads have a 1.5 s cooldown so they fire once per jump, not every frame. */
  function _mkDirectedLaunchPad(x, y, z, dx, dz, launchSpd, upSpd) {
    if (_inSpawnSafeZone(x, y, z)) return;

    // Normalise direction
    const dl = Math.hypot(dx, dz) || 1;
    const ndx = dx / dl, ndz = dz / dl;

    // Pad disc — bright teal
    const padMat = new THREE.MeshPhongMaterial({ color: 0x00ffcc, emissive: 0x00cc99, emissiveIntensity: 1.4, shininess: 120 });
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(2.5, 2.8, 0.25, 16), padMat);
    mesh.position.set(x, y + 0.12, z);
    _decoGroup.add(mesh);

    // Chevron arrow in launch direction (3 stacked triangles)
    const arrowMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 });
    const arrowAngle = Math.atan2(ndx, ndz);  // rotate so it points in launch dir
    for (let ci = 0; ci < 3; ci++) {
      const chevron = new THREE.Mesh(new THREE.ConeGeometry(0.55, 0.8, 3), arrowMat);
      chevron.rotation.x = -Math.PI / 2;
      chevron.rotation.z =  arrowAngle;
      chevron.position.set(
        x + ndx * (ci * 0.85 + 0.3),
        y + 0.26,
        z + ndz * (ci * 0.85 + 0.3)
      );
      _decoGroup.add(chevron);
    }

    // Glow ring around edge
    const ringMat = new THREE.MeshBasicMaterial({ color: 0x00ffee, transparent: true, opacity: 0.5 });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(2.6, 0.14, 6, 24), ringMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.set(x, y + 0.25, z);
    _decoGroup.add(ring);

    _obbyBoostPads.push({
      mesh, ring,
      x, y: y + 0.12, z,
      ndx, ndz,          // normalised horizontal direction
      launchSpd, upSpd,  // power
      cooldown: 0,       // seconds until can fire again
      achievementDone: false
    });
  }

  /* ── Launch section set-piece ────────────────────────────────────────
     A purposeful ramp → launchpad → catch-platform structure.
     baseZ is where the approach starts; launches along +Z toward COURSE_END_Z.
     Returns the Z of the catch platform so the caller can continue from there. */
  function _mkLaunchSection(baseX, baseY, baseZ, sector) {
    const sec = sector || 1;

    // 1. Wide approach platform (player runs up to it)
    _mkPlatform(baseX, baseY, baseZ, 12, 1, 10, sec, false);

    // 2. Visual ramp — tilted box (decoration, no collision record)
    const rampMat = new THREE.MeshPhongMaterial({ color: 0x1166aa, emissive: 0x003366, emissiveIntensity: 0.6, shininess: 80 });
    const rampMesh = new THREE.Mesh(new THREE.BoxGeometry(10, 0.5, 12), rampMat);
    rampMesh.rotation.x = -0.32; // ~18° slope
    rampMesh.position.set(baseX, baseY + 2.2, baseZ + 15);
    _decoGroup.add(rampMesh);

    // Glowing edge strips on the ramp sides
    const stripMat = new THREE.MeshBasicMaterial({ color: 0x00ccff, transparent: true, opacity: 0.7 });
    [-4.8, 4.8].forEach(sx => {
      const strip = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.18, 12), stripMat);
      strip.rotation.x = -0.32;
      strip.position.set(baseX + sx, baseY + 2.45, baseZ + 15);
      _decoGroup.add(strip);
    });

    // 3. Elevated launch platform at ramp top
    const launchPlatY = baseY + 4.5;
    _mkPlatform(baseX, launchPlatY, baseZ + 22, 10, 1, 8, sec, false);

    // 4. Directed launch pad on the elevated platform, aimed along +Z
    _mkDirectedLaunchPad(baseX, launchPlatY + 0.5, baseZ + 22, 0, 1, 80, 12);

    // 5. Left + right guide walls framing the gap (visual only — feel safe)
    const wallMat = new THREE.MeshPhongMaterial({ color: 0x0044aa, emissive: 0x001133, emissiveIntensity: 0.5, transparent: true, opacity: 0.6 });
    [-7, 7].forEach(wx => {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(1.2, 10, 22), wallMat);
      wall.position.set(baseX + wx, launchPlatY + 4, baseZ + 46);
      _decoGroup.add(wall);
      // Glowing top edge on wall
      const ledge = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.2, 22), stripMat);
      ledge.position.set(baseX + wx, launchPlatY + 9.1, baseZ + 46);
      _decoGroup.add(ledge);
    });

    // 6. Large catch platform across the gap — wide so it's satisfying to land on
    const catchZ = baseZ + 58;
    const catchY = launchPlatY - 2;  // slightly lower so arc feels natural
    _mkPlatform(baseX, catchY, catchZ, 20, 1, 14, sec, false);

    // Glowing landing zone strip on the catch platform
    const landMat = new THREE.MeshBasicMaterial({ color: 0x00ff99, transparent: true, opacity: 0.45 });
    const landMarker = new THREE.Mesh(new THREE.BoxGeometry(18, 0.08, 12), landMat);
    landMarker.position.set(baseX, catchY + 0.55, catchZ);
    _decoGroup.add(landMarker);

    return { x: baseX, y: catchY, z: catchZ }; // hand-off point for next platform
  }

  /* ── Gravity gate (sector 4) ──────────────────────────────────── */
  function _mkGravityGate(x, y, z) {
    /* outer torus ring */
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(5, 0.35, 10, 48),
      new THREE.MeshBasicMaterial({ color: 0xcc00ff, transparent: true, opacity: 0.95 })
    );
    ring.position.set(x, y, z);
    _decoGroup.add(ring);

    /* inner rotating cross */
    for (let i = 0; i < 2; i++) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(0.2, 8, 0.2),
        new THREE.MeshBasicMaterial({ color: 0xff44ff, transparent: true, opacity: 0.7 }));
      bar.position.set(x, y, z);
      bar.rotation.z = i * Math.PI * 0.5;
      _decoGroup.add(bar);
    }

    /* label arrow (↕) */
    const label = new THREE.Mesh(
      new THREE.ConeGeometry(0.5, 1.5, 6),
      new THREE.MeshBasicMaterial({ color: 0xee00ff, transparent: true, opacity: 0.9 })
    );
    label.position.set(x, y + 6.5, z);
    _decoGroup.add(label);

    _gravityGates.push({ x, y, z, radius: 5.5, ring });
  }

  function _scatterLightBeams() {
    for (let i = 0; i < 55; i++) {
      const x = (Math.random() - 0.5) * 320;
      const z = Math.random() * COURSE_END_Z;
      const h = 150 + Math.random() * 200;
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, h, 8), new THREE.MeshBasicMaterial({ color: 0x6aaeff, transparent: true, opacity: 0.13 }));
      beam.position.set(x, h * 0.5 - 30, z);
      _decoGroup.add(beam);
    }
  }

  function _updatePlayer(delta) {
    /* ── sprint ── */
    _isSprinting = !!(keys['ShiftLeft'] || keys['ShiftRight']);
    const speed = _isSprinting ? SPRINT_SPEED : MOVE_SPEED;
    if (_inputLockT > 0) _inputLockT = Math.max(0, _inputLockT - delta);

    /* ── direction ── */
    const yaw = (cameraTheta * Math.PI) / 180;
    const fx = Math.sin(yaw), fz = Math.cos(yaw), rx = -Math.cos(yaw), rz = Math.sin(yaw);
    let mx = 0, mz = 0;
    if (keys['KeyW'] || keys['ArrowUp'])    { mx += fx; mz += fz; }
    if (keys['KeyS'] || keys['ArrowDown'])  { mx -= fx; mz -= fz; }
    if (keys['KeyA'] || keys['ArrowLeft'])  { mx -= rx; mz -= rz; }
    if (keys['KeyD'] || keys['ArrowRight']) { mx += rx; mz += rz; }
    if (isMobile && (Math.abs(touchJoystickX) > 0.1 || Math.abs(touchJoystickY) > 0.1)) {
      mx += (-touchJoystickY * fx + touchJoystickX * rx);
      mz += (-touchJoystickY * fz + touchJoystickX * rz);
    }
    if (_inputLockT > 0) { mx = 0; mz = 0; }
    const ml = Math.hypot(mx, mz);
    _isMoving = ml > 0.05;
    if (_isMoving) { mx = (mx / ml) * speed; mz = (mz / ml) * speed; }

    /* ── coyote countdown ── */
    if (_coyoteT > 0) _coyoteT -= delta;

    /* ── jump (coyote-aware) ──
       First jump: allowed when grounded OR within coyote window (just walked off edge).
       Double jump: allowed when airborne and only one jump used.
       Normal jump (24) > double jump (20) as requested.                               */
    /* ── gravity gate cooldown ── */
    if (_gravGateCooldown > 0) _gravGateCooldown -= delta;

    const spaceNow = !!keys['Space'];
    if (spaceNow && !_wasSpace) {
      /* jump direction opposes gravity direction */
      const jDir = _gravityDir > 0 ? 1 : -1;
      if (_isGrounded || _coyoteT > 0) {
        _vel.y = BASE_JUMP * jDir;
        _jumpCount = 1; _isGrounded = false; _coyoteT = 0;
        _obbySound('jump');
      } else if (_jumpCount === 1) {
        _vel.y = DOUBLE_JUMP_VEL * jDir;
        _jumpCount = 2;
        _obbySound('doublejump');
      }
    }
    _wasSpace = spaceNow;

    /* ── active dash: override movement, suppress downward gravity ── */
    if (_dashActive) {
      _dashT -= delta;
      mx = _dashDX * DASH_SPEED;
      mz = _dashDZ * DASH_SPEED;
      if (_vel.y < 0) _vel.y *= Math.exp(-18 * delta);  // kill downward pull mid-dash
      if (_dashT <= 0) {
        _dashActive = false;
        /* bleed off most dash velocity so landing feels controlled */
        mx *= 0.45;
        mz *= 0.45;
      }
    }

    /* ── integrate ── */
    _constantVelocity.multiplyScalar(Math.exp(-(_inputLockT > 0 ? 1.5 : 4) * delta));
    if (_dashCd > 0) _dashCd -= delta;
    _vel.x = mx + _constantVelocity.x;
    _vel.z = mz + _constantVelocity.z;
    _vel.y -= GRAVITY * _gravityDir * delta;  // flips with gravity gate

    _ps.position.x += _vel.x * delta;
    _ps.position.z += _vel.z * delta;
    _ps.position.y += _vel.y * delta;

    /* ── collision — reset _isGrounded each frame, set coyote if just left ground ── */
    const prevGrounded = _isGrounded;
    _isGrounded = false;
    _applyPlatformCollision();   // may set _isGrounded = true, _jumpCount = 0
    if (prevGrounded && !_isGrounded && _jumpCount === 0) {
      _coyoteT = COYOTE_TIME;   // walked off edge — grant grace window
    }

    _applyWindZones(delta);
    _applyJumpPads();
    _applyCheckpoints();
    _applyHazards();
    _applyGravityGates();

    /* death bounds work in both gravity directions */
    if (_ps.position.y < -60) _respawn();
    if (_ps.position.y >  300 && _gravityDir === -1) _respawn(); // inverted fall-out
    if (_ps.position.z >= COURSE_END_Z - 2) _triggerWin();
  }

  function _applyPlatformCollision() {
    const px = _ps.position.x, py = _ps.position.y, pz = _ps.position.z;
    for (const p of _platforms) {
      if (!p.collidable) continue;
      if (Math.abs(px - p.x) > p.w * 0.5 + PLAYER_RADIUS) continue;
      if (Math.abs(pz - p.z) > p.d * 0.5 + PLAYER_RADIUS) continue;

      const top    = p.y + p.h * 0.5;
      const bottom = p.y - p.h * 0.5;

      let landed = false;
      if (_gravityDir === 1) {
        /* normal: player foot hits platform top */
        const footY = py - FOOT;
        if (footY <= top + 0.2 && footY >= top - 1.2 && _vel.y <= 0) {
          _ps.position.y = top + FOOT; _vel.y = 0; landed = true;
        }
      } else {
        /* inverted: player head hits platform bottom */
        const headY = py + FOOT;
        if (headY >= bottom - 0.2 && headY <= bottom + 1.2 && _vel.y >= 0) {
          _ps.position.y = bottom - FOOT; _vel.y = 0; landed = true;
        }
      }

      if (landed) {
        // Hard landing shake: only if falling fast (> 18 u/s before zeroed)
        if (!_isGrounded && Math.abs(_vel.y) > 18) {
          _triggerObbyShake(Math.min(0.6, Math.abs(_vel.y) * 0.018));
          _obbySound('land');
        }
        _isGrounded = true;
        _jumpCount = 0;
        if (p.isFinish) _triggerWin();
        /* trigger fading platform countdown on first contact */
        if (p.isFading && p.fadeState === 0) {
          p.fadeState = 1;
          p.fadeTimer = 1.2;
        }
      }
    }
  }

  function _applyWindZones(delta) {
    for (const w of _windZones) {
      if (Math.abs(_ps.position.x - w.x) < w.w / 2 &&
          Math.abs(_ps.position.y - w.y) < w.h / 2 &&
          Math.abs(_ps.position.z - w.z) < w.d / 2) {
        /* horizontal wind: direct positional push, delta-correct */
        _ps.position.x += w.fx * delta;
        _ps.position.z += w.fz * delta;
        /* vertical lift: lerp velocity TOWARD the target lift speed.
           This fully counteracts gravity — no matter how fast the player
           was falling, they accelerate toward +fy within ~0.2 s.          */
        if (w.fy !== 0) {
          _vel.y += (w.fy - _vel.y) * Math.min(1, 7 * delta);
        }
      }
    }
  }

  function _applyJumpPads() {
    for (const pad of _jumpPads) {
      const d = Math.hypot(_ps.position.x - pad.x, _ps.position.z - pad.z);
      if (d < pad.radius + 0.6 && Math.abs((_ps.position.y - FOOT) - pad.y) < 1.0 && _vel.y <= 0) {
        _vel.y = pad.impulse;
        pad.animT = 0.18;
      }
    }
  }

  function _applyCheckpoints() {
    for (const cp of _checkpoints) {
      if (cp.activated) continue;
      if (_ps.position.distanceTo(new THREE.Vector3(cp.x, cp.y, cp.z)) < cp.radius) {
        cp.activated = true;
        _obbySound('checkpoint');
        _respawnPoint.set(cp.x, cp.y + 2.5, cp.z);
        /* flash to green on activation */
        const green = 0x00ff88;
        cp.ring.material.color.setHex(green);
        cp.beam.material.color.setHex(green);
        cp.padRing.material.color.setHex(green);
        cp.diamond.material.color.setHex(green);
        cp.ring.material.opacity = 1.0;
        cp.beam.material.opacity = 0.35;
      }
    }
  }

  function _applyHazards() {
    for (const l of _laserFences) {
      if (Math.abs(_ps.position.x - l.mesh.position.x) < l.w / 2 + 0.5 && Math.abs(_ps.position.y - l.mesh.position.y) < l.h / 2 + 1 && Math.abs(_ps.position.z - l.mesh.position.z) < l.d / 2 + 0.5) return _respawn();
    }
    for (const g of _crusherGates) {
      if (Math.abs(_ps.position.x - g.x) < g.w / 2 && Math.abs(_ps.position.y - g.mesh.position.y) < g.h / 2 + 1 && Math.abs(_ps.position.z - g.z) < g.d / 2) return _respawn();
    }
  }

  function _applyGravityGates() {
    if (_gravGateCooldown > 0) return;
    for (const g of _gravityGates) {
      const d = Math.hypot(_ps.position.x - g.x, _ps.position.z - g.z);
      if (d < g.radius && Math.abs(_ps.position.y - g.y) < 4) {
        _gravityDir *= -1;
        _gravGateCooldown = 3.0;   // 3s before another gate can fire
        /* visual flash on the ring */
        g.ring.material.color.setHex(_gravityDir === -1 ? 0xff00ff : 0xcc00ff);
        break;
      }
    }
  }

  function _updateDynamicObstacles(delta) {
    for (const pad of _jumpPads) {
      const pulse = 0.88 + 0.12 * Math.sin(_gt * 5 + pad.pulseOffset);
      let trigger = 1;
      if (pad.animT > 0) { pad.animT -= delta; trigger = 1.2; }
      pad.mesh.scale.set(pulse * trigger, 1, pulse * trigger);
    }
    for (const l of _laserFences) l.mesh.position.x = l.baseX + Math.sin(_gt * l.speed) * l.amp;
    for (const g of _crusherGates) g.mesh.position.y = g.baseY + Math.sin(_gt * g.speed) * g.range;
    for (const p of _glassWalkways) {
      if (!_ps) continue;
      const d = _ps.position.distanceTo(new THREE.Vector3(p.x, p.y, p.z));
      p.mesh.material.opacity = d < 10 ? 1.0 : 0.3;
    }

    /* ── fading platforms ── */
    for (const fp of _fadingPlatforms) {
      if (fp.fadeState === 1) {
        fp.fadeTimer -= delta;
        fp.mat.opacity = Math.max(0, fp.fadeTimer / 1.2);
        fp.mat.emissiveIntensity = 0.7 + (1 - fp.fadeTimer / 1.2) * 1.5; // flares red as it fades
        if (fp.fadeTimer <= 0) {
          fp.fadeState = 2;
          fp.fadeTimer = 3.5;   // respawn delay
          fp.collidable = false;
          fp.mesh.visible = false;
        }
      } else if (fp.fadeState === 2) {
        fp.fadeTimer -= delta;
        if (fp.fadeTimer <= 0) {
          fp.fadeState = 0;
          fp.collidable = true;
          fp.mesh.visible = true;
          fp.mat.opacity = 1.0;
          fp.mat.emissiveIntensity = 0.7;
        }
      }
    }

    /* ── moving platforms ── */
    for (const mp of _movingPlatforms) {
      const t = _gt * mp.speed + mp.phase;
      if (mp.axis === 'x') {
        const newX = mp.baseX + Math.sin(t) * mp.amp;
        const dx = newX - mp.mesh.position.x;
        mp.mesh.position.x = newX;
        mp.rec.x = newX;
        mp.arrow.position.x = newX;
        // Carry player along if standing on it
        if (_ps && _isGrounded) {
          const onIt = Math.abs(_ps.position.x - newX) < mp.rec.w / 2 + 0.5 &&
                       Math.abs(_ps.position.z - mp.rec.z) < mp.rec.d / 2 + 0.5 &&
                       Math.abs(_ps.position.y - FOOT - mp.rec.y) < 1.2;
          if (onIt) _ps.position.x += dx;
        }
      } else if (mp.axis === 'y') {
        const newY = mp.baseY + Math.sin(t) * mp.amp;
        const dy = newY - mp.mesh.position.y;
        mp.mesh.position.y = newY;
        mp.rec.y = newY;
        mp.arrow.position.y = newY + 0.56;
        // Carry player along if standing on it
        if (_ps && _isGrounded) {
          const onIt = Math.abs(_ps.position.x - mp.rec.x) < mp.rec.w / 2 + 0.5 &&
                       Math.abs(_ps.position.z - mp.rec.z) < mp.rec.d / 2 + 0.5 &&
                       Math.abs(_ps.position.y - FOOT - newY) < 1.5;
          if (onIt) _ps.position.y += dy;
        }
      }
    }

    /* ── crumbling platforms ── */
    for (const cp of _crumblingPlatforms) {
      if (cp.state === 1) {
        // Shaking — wobble before collapse
        cp.timer -= delta;
        const shake = Math.sin(_gt * 35) * Math.max(0, cp.timer) * 0.25;
        cp.mesh.position.x = cp.rec.x + shake;
        cp.mesh.position.z = cp.rec.z + shake * 0.7;
        cp.mat.emissive = _COL_CRUMBLE_SHAKE;
        cp.mat.emissiveIntensity = 0.5 + (1 - cp.timer / 1.5) * 1.5;
        if (cp.timer <= 0) {
          cp.state = 2;
          cp.timer = 3.5; // respawn time
          cp.rec.collidable = false;
          cp.mesh.visible = false;
          cp.mesh.position.set(cp.rec.x, cp.origY, cp.rec.z); // reset pos
        }
      } else if (cp.state === 2) {
        // Fallen — waiting to respawn
        cp.timer -= delta;
        if (cp.timer <= 0) {
          cp.state = 0;
          cp.rec.collidable = true;
          cp.mesh.visible = true;
          cp.mat.emissive = _COL_CRUMBLE_RESPAWN;
          cp.mat.emissiveIntensity = 0.6;
        }
      } else if (cp.state === 0) {
        // Idle — check if player just landed on it
        if (_ps && _isGrounded) {
          const onIt = Math.abs(_ps.position.x - cp.rec.x) < cp.rec.w / 2 + 0.4 &&
                       Math.abs(_ps.position.z - cp.rec.z) < cp.rec.d / 2 + 0.4 &&
                       Math.abs(_ps.position.y - FOOT - cp.rec.y) < 1.2;
          if (onIt) { cp.state = 1; cp.timer = 1.5; _obbySound('crumble'); }
        }
      }
    }

    /* ── obby boost pads ── */
    for (const bp of _obbyBoostPads) {
      // Pulse animation
      const pulse = 0.92 + 0.08 * Math.sin(_gt * 4 + bp.x);
      bp.mesh.scale.set(pulse, 1, pulse);
      if (bp.ring) bp.ring.material.opacity = 0.3 + 0.25 * Math.sin(_gt * 6 + bp.x);

      // Cooldown tick
      if (bp.cooldown > 0) { bp.cooldown -= delta; continue; }

      // Check if player is standing on the pad
      if (_ps && _isGrounded) {
        const d = Math.hypot(_ps.position.x - bp.x, _ps.position.z - bp.z);
        if (d < 2.8 && Math.abs(_ps.position.y - FOOT - bp.y) < 1.0) {
          // Launch with a local Vector3(0, 15, 45) impulse rotated into the pad direction.
          const launch = new THREE.Vector3(0, bp.upSpd, bp.launchSpd)
            .applyAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(bp.ndx, bp.ndz));
          _constantVelocity.x = launch.x;
          _constantVelocity.z = launch.z;
          _vel.x = _constantVelocity.x;
          _vel.z = _constantVelocity.z;
          _vel.y = launch.y;
          _inputLockT = 0.5;
          _isGrounded = false;
          if (typeof tryEvilScreamer === 'function') tryEvilScreamer(0.02);

          // Cooldown: 1.5 s so it can't re-fire while player is in the air
          bp.cooldown = 1.5;
          _obbySound('launch');

          // Screen flash — bright teal for launch (not the red dash flash)
          const fl = document.getElementById('dash-flash');
          if (fl) {
            fl.style.background = 'rgba(0,255,200,0.35)';
            fl.style.opacity = '1';
            setTimeout(() => { if (fl) { fl.style.opacity = '0'; fl.style.background = ''; } }, 220);
          }

          // Achievement — only once per session, not per frame
          if (!bp.achievementDone) {
            bp.achievementDone = true;
            if (typeof unlockAchievement === 'function') unlockAchievement('boost_pad_launch');
          }
        }
      }
    }

    /* ── gravity gates — spin the ring ── */
    for (const g of _gravityGates) {
      g.ring.rotation.x = _gt * 1.2;
      g.ring.rotation.z = _gt * 0.8;
    }

    /* animate checkpoints */
    for (const cp of _checkpoints) {
      if (cp.activated) continue;
      /* ring floats gently up and down */
      cp.ring.position.y = cp.y + Math.sin(_gt * 1.8) * 0.28;
      /* ring pulses opacity */
      cp.ring.material.opacity = 0.70 + 0.30 * Math.sin(_gt * 3.5);
      /* beam breathes */
      cp.beam.material.opacity = 0.08 + 0.07 * Math.abs(Math.sin(_gt * 2.2));
      /* pad ring slowly rotates */
      cp.padRing.rotation.z = _gt * 0.8;
      /* spinning diamond */
      cp.diamond.rotation.y = _gt * 2.5;
      cp.diamond.rotation.x = _gt * 1.2;
      cp.diamond.position.y = cp.y - 1.0 + Math.sin(_gt * 2.5) * 0.15;
    }
  }

  let _obbyScreenShake = 0;  // magnitude, decays each frame

  function _triggerObbyShake(mag) {
    _obbyScreenShake = Math.max(_obbyScreenShake, mag);
  }

  function _updateCamera(delta) {
    const th = (cameraTheta * Math.PI) / 180;
    const ph = ((typeof cameraPhi === 'number' ? cameraPhi : 55) * Math.PI) / 180;
    const dist = 16;
    const tx = _ps.position.x - Math.sin(th) * dist * Math.cos(ph);
    const ty = _ps.position.y + dist * Math.sin(ph) + 2;
    const tz = _ps.position.z - Math.cos(th) * dist * Math.cos(ph);
    const sm = 1 - Math.exp(-10 * delta);
    camera.position.x += (tx - camera.position.x) * sm;
    camera.position.y += (ty - camera.position.y) * sm;
    camera.position.z += (tz - camera.position.z) * sm;

    // Screen shake
    if (_obbyScreenShake > 0.01) {
      camera.position.x += (Math.random() - 0.5) * _obbyScreenShake;
      camera.position.y += (Math.random() - 0.5) * _obbyScreenShake * 0.5;
      _obbyScreenShake *= Math.pow(0.04, delta); // fast decay
      if (_obbyScreenShake < 0.01) {
        _obbyScreenShake = 0;
        if (renderer) renderer.domElement.style.transform = '';
      }
    }

    camera.lookAt(_ps.position.x, _ps.position.y + 1, _ps.position.z);
  }

  function _updateVisuals(delta) {
    if (!_ps) return;
    if (_shadow) _shadow.position.set(_ps.position.x, _ps.position.y - FOOT + 0.05, _ps.position.z);
    _currentLayer = Math.max(0, Math.floor(_ps.position.y / HUB_LAUNCH_HEIGHT));

    /* ── FOV: dash spike → sprint push → base ── */
    const fovTarget = _dashActive
      ? DASH_FOV
      : (_isSprinting && _isMoving) ? SPRINT_FOV : BASE_FOV;
    /* faster lerp during dash so the spike feels instant; slower return */
    const fovLerp = _fovCurrent > fovTarget ? 5 : (_dashActive ? 20 : 6);
    _fovCurrent += (fovTarget - _fovCurrent) * Math.min(1, fovLerp * delta);

    /* ── dash trail particles ── */
    if (_dashActive) {
      _dashTrailT -= delta;
      if (_dashTrailT <= 0) {
        _dashTrailT = 0.025;
        const p = _particles.find(q => q.life <= 0);
        if (p) {
          p.mesh.visible = true;
          p.mesh.position.set(
            _ps.position.x + (Math.random()-0.5)*0.3,
            _ps.position.y - 0.3 + Math.random()*0.6,
            _ps.position.z + (Math.random()-0.5)*0.3
          );
          p.vx = -_dashDX * 1.5 + (Math.random()-0.5)*0.5;
          p.vy = 0.3 + Math.random()*0.5;
          p.vz = -_dashDZ * 1.5 + (Math.random()-0.5)*0.5;
          p.maxLife = 0.18 + Math.random()*0.08;
          p.life = p.maxLife;
          /* trail colour: electric cyan → fade to purple */
          p.mesh.material.color.setHex(Math.random() < 0.6 ? 0x00ffff : 0xaa44ff);
          p.mesh.scale.setScalar(1.8);
          p.mesh.material.opacity = 0.9;
        }
      }
    }
    if (camera && Math.abs(camera.fov - _fovCurrent) > 0.1) {
      camera.fov = _fovCurrent;
      camera.updateProjectionMatrix();
    }

    /* ── walk / run footstep particles ── */
    if (_isGrounded && _isMoving) {
      const rate = _isSprinting ? 0.06 : 0.12;  // faster emit when sprinting
      _particleEmitT -= delta;
      if (_particleEmitT <= 0) {
        _particleEmitT = rate;
        const p = _particles.find(q => q.life <= 0);
        if (p) {
          p.mesh.visible = true;
          p.mesh.position.set(
            _ps.position.x + (Math.random() - 0.5) * 0.5,
            _ps.position.y - FOOT + 0.08,
            _ps.position.z + (Math.random() - 0.5) * 0.5
          );
          p.vx = (Math.random() - 0.5) * 1.2;
          p.vy = 0.6 + Math.random() * 1.0;
          p.vz = (Math.random() - 0.5) * 1.2;
          p.maxLife = _isSprinting ? 0.22 : 0.32;
          p.life    = p.maxLife;
          /* sprint = hot cyan, walk = cool blue */
          p.mesh.material.color.setHex(_isSprinting ? 0x00ffee : 0x2266ff);
          p.mesh.scale.setScalar(_isSprinting ? 1.6 : 1.0);
          p.mesh.material.opacity = 0.85;
        }
      }
    }

    /* ── tick existing particles ── */
    for (const p of _particles) {
      if (p.life <= 0) continue;
      p.life -= delta;
      if (p.life <= 0) { p.mesh.visible = false; continue; }
      const t = p.life / p.maxLife;
      p.mesh.position.x += p.vx * delta;
      p.mesh.position.y += p.vy * delta;
      p.mesh.position.z += p.vz * delta;
      p.vy -= 4 * delta;                      // slight gravity on particles
      p.mesh.material.opacity = t * 0.85;
      p.mesh.scale.setScalar((0.4 + t * 0.6) * (_isSprinting ? 1.6 : 1.0));
    }
  }

  function _updateHUD() {
    const timer = document.getElementById('timer-display');
    if (timer) {
      const mins = Math.floor(_runTimer / 60);
      const secs = Math.floor(_runTimer % 60).toString().padStart(2, '0');
      timer.textContent = `${mins}:${secs}`;
    }
    const deaths = document.getElementById('obby-death-display');
    if (deaths) deaths.textContent = `${_deathCount}`;
    const curSec = _sectorFromZ(_ps.position.z);
    const sector = document.getElementById('sector-display');
    if (sector) sector.textContent = `${curSec}`;
    if (curSec !== _lastSectorVisual) {
      _lastSectorVisual = curSec;
      _applySectorVisuals(curSec);
    }
    const dist = document.getElementById('distance-display');
    if (dist) dist.textContent = `${Math.max(0, Math.round(COURSE_END_Z - _ps.position.z))}`;
    const layer = document.getElementById('layer-display');
    if (layer) layer.textContent = `${_currentLayer}`;
    const hubDist = document.getElementById('hub-distance-display');
    if (hubDist) {
      const nextHub = Math.ceil((_ps.position.z + 1) / HUB_INTERVAL) * HUB_INTERVAL;
      hubDist.textContent = `${Math.max(0, Math.round(nextHub - _ps.position.z))}`;
    }
    const stage = document.getElementById('stage-pill');
    if (stage) stage.textContent = 'NEO-CIRCUIT';
  }

  function _respawn() {
    _obbySound('death');
    if (typeof tryEvilScreamer === 'function') tryEvilScreamer(0.02);
    _deathCount += 1;
    _ps.position.copy(_respawnPoint);
    _vel.set(0, 0, 0);
    _constantVelocity.set(0, 0, 0);
    _jumpCount = 0;
    _isGrounded = false;
    _gravityDir = 1;            // always restore normal gravity on death
    _gravGateCooldown = 0;
    _dashActive = false;
    _triggerObbyShake(0.8);     // death shake
  }

  function _triggerWin() {
    // Format final time + death count
    const mins = Math.floor(_runTimer / 60);
    const secs = Math.floor(_runTimer % 60).toString().padStart(2, '0');
    const timeStr = `${mins}:${secs}`;

    // Populate win screen stats
    const ws = document.getElementById('win-stats');
    if (ws) {
      const rating = _deathCount === 0 ? '✦ FLAWLESS RUN ✦' :
                     _deathCount < 5  ? 'SOLID EFFORT'     :
                     _deathCount < 15 ? 'KEEP GRINDING'    : 'YOU SURVIVED';
      ws.innerHTML = `
        <div style="font-family:'Bebas Neue';font-size:26px;letter-spacing:4px;color:#c9a84c;margin-bottom:6px;">⏱ ${timeStr}</div>
        <div style="font-size:16px;letter-spacing:3px;color:rgba(200,185,155,0.65);margin-bottom:4px;">💀 ${_deathCount} DEATH${_deathCount !== 1 ? 'S' : ''}</div>
        <div style="font-size:13px;letter-spacing:4px;color:rgba(140,200,255,0.55);margin-top:10px;text-transform:uppercase;">${rating}</div>
      `;
    }

    // Show win screen, hide HUD
    const winScreen = document.getElementById('win-screen');
    if (winScreen) winScreen.style.display = 'flex';
    const hud = document.getElementById('hud');
    if (hud) hud.style.display = 'none';

    // Record run for leaderboard + achievements
    if (typeof recordObbyRun === 'function') recordObbyRun(_runTimer, _deathCount);
    if (_deathCount === 0 && typeof unlockAchievement === 'function') unlockAchievement('flawless_obby');
    if (_deathCount >= 15 && typeof unlockAchievement === 'function') unlockAchievement('survivalist');
  }

  function _prepareGridTexture() {
    const c = document.createElement('canvas');
    c.width = 128;
    c.height = 128;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(0, 0, 128, 128);
    ctx.strokeStyle = 'rgba(130,170,255,0.22)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 128; i += 16) {
      ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, 128); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(128, i); ctx.stroke();
    }
    _gridTexture = new THREE.CanvasTexture(c);
    _gridTexture.wrapS = THREE.RepeatWrapping;
    _gridTexture.wrapT = THREE.RepeatWrapping;
    _gridTexture.repeat.set(2, 2);
  }

  function _resolveOverlap(newMesh) {
    newMesh.updateMatrixWorld(true);
    const newBox = new THREE.Box3().setFromObject(newMesh);
    for (const old of _platforms) {
      old.mesh.updateMatrixWorld(true);
      const oldBox = new THREE.Box3().setFromObject(old.mesh);
      if (newBox.intersectsBox(oldBox)) {
        newMesh.position.x += 20;
        newMesh.updateMatrixWorld(true);
        newBox.setFromObject(newMesh);
      }
    }
  }

  function _intersectsAny(box) {
    for (const old of _platforms) {
      old.mesh.updateMatrixWorld(true);
      if (box.intersectsBox(new THREE.Box3().setFromObject(old.mesh))) return true;
    }
    return false;
  }

  function _makeAabb(x, y, z, w, h, d) {
    return new THREE.Box3(
      new THREE.Vector3(x - w / 2, y - h / 2, z - d / 2),
      new THREE.Vector3(x + w / 2, y + h / 2, z + d / 2)
    );
  }

  /* ── Sector sky/fog transitions ──────────────────────────────────── */
  const _SECTOR_ENV = [
    null,
    { bg: 0x000008, fog: 0x000420, fogD: 0.0028 },  // S1: deep space blue
    { bg: 0x120100, fog: 0x1f0500, fogD: 0.0045 },  // S2: volcanic dark red
    { bg: 0x040012, fog: 0x070020, fogD: 0.0045 },  // S3: neon void purple
    { bg: 0x00061a, fog: 0x0005aa, fogD: 0.0035 },  // S4: electric blue-white
  ];
  function _applySectorVisuals(sector) {
    const env = _SECTOR_ENV[Math.min(4, Math.max(1, sector))];
    if (!env) return;
    scene.background = new THREE.Color(env.bg);
    scene.fog = new THREE.FogExp2(env.fog, env.fogD);
  }

  /* ── Obby sound effects via Web Audio API ─────────────────────────
     Lazy-creates the AudioContext on first call (requires user gesture). */
  function _obbySound(type) {
    try {
      if (!_obbyACtx) _obbyACtx = new (window.AudioContext || window.webkitAudioContext)();
      const ctx = _obbyACtx;
      if (ctx.state === 'suspended') ctx.resume();
      const now = ctx.currentTime;
      const g = ctx.createGain();
      g.connect(ctx.destination);

      if (type === 'jump') {
        // Short rising click-tone
        const o = ctx.createOscillator();
        o.type = 'square';
        o.frequency.setValueAtTime(220, now);
        o.frequency.exponentialRampToValueAtTime(440, now + 0.08);
        g.gain.setValueAtTime(0.18, now);
        g.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
        o.connect(g); o.start(now); o.stop(now + 0.13);

      } else if (type === 'doublejump') {
        const o = ctx.createOscillator();
        o.type = 'triangle';
        o.frequency.setValueAtTime(440, now);
        o.frequency.exponentialRampToValueAtTime(880, now + 0.1);
        g.gain.setValueAtTime(0.22, now);
        g.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
        o.connect(g); o.start(now); o.stop(now + 0.16);

      } else if (type === 'land') {
        // Low thud
        const o = ctx.createOscillator();
        o.type = 'sine';
        o.frequency.setValueAtTime(80, now);
        o.frequency.exponentialRampToValueAtTime(30, now + 0.12);
        g.gain.setValueAtTime(0.35, now);
        g.gain.exponentialRampToValueAtTime(0.001, now + 0.14);
        o.connect(g); o.start(now); o.stop(now + 0.15);

      } else if (type === 'death') {
        // Descending womp
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.setValueAtTime(400, now);
        o.frequency.exponentialRampToValueAtTime(60, now + 0.5);
        g.gain.setValueAtTime(0.28, now);
        g.gain.exponentialRampToValueAtTime(0.001, now + 0.55);
        o.connect(g); o.start(now); o.stop(now + 0.56);

      } else if (type === 'checkpoint') {
        // Bright two-tone chime
        [523, 784].forEach((freq, i) => {
          const o = ctx.createOscillator();
          o.type = 'sine';
          o.frequency.value = freq;
          const g2 = ctx.createGain();
          const t0 = now + i * 0.12;
          g2.gain.setValueAtTime(0, t0);
          g2.gain.linearRampToValueAtTime(0.3, t0 + 0.02);
          g2.gain.exponentialRampToValueAtTime(0.001, t0 + 0.35);
          g2.connect(ctx.destination);
          o.connect(g2); o.start(t0); o.stop(t0 + 0.36);
        });
        g.disconnect(); // unused main gain

      } else if (type === 'launch') {
        // Rising whoosh
        const o = ctx.createOscillator();
        const bq = ctx.createBiquadFilter();
        bq.type = 'highpass'; bq.frequency.value = 300;
        o.type = 'sawtooth';
        o.frequency.setValueAtTime(80, now);
        o.frequency.exponentialRampToValueAtTime(1200, now + 0.3);
        g.gain.setValueAtTime(0.3, now);
        g.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
        o.connect(bq); bq.connect(g); o.start(now); o.stop(now + 0.36);

      } else if (type === 'crumble') {
        // Low rumble burst
        const buf = ctx.createBuffer(1, ctx.sampleRate * 0.4, ctx.sampleRate);
        const d = buf.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * 0.6;
        const src = ctx.createBufferSource();
        const bq = ctx.createBiquadFilter();
        bq.type = 'lowpass'; bq.frequency.value = 180;
        src.buffer = buf;
        g.gain.setValueAtTime(0.5, now);
        g.gain.exponentialRampToValueAtTime(0.001, now + 0.4);
        src.connect(bq); bq.connect(g); src.start(now); src.stop(now + 0.41);
      }
    } catch(e) { /* audio not available — silent fail */ }
  }

  function _sectorFromZ(z) {
    // 4 sectors across 2600 units, each ~650 units long
    if (z < 650)  return 1;
    if (z < 1300) return 2;
    if (z < 1950) return 3;
    return 4;
  }

  function _inSpawnSafeZone(x, y, z) {
    return Math.sqrt(x * x + y * y + z * z) < SPAWN_SAFE_RADIUS;
  }

  function _createPlayer() {
    const tex = new THREE.TextureLoader().load('./assets/Evil_RodWave.png');
    _ps = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
    _ps.scale.set(2.2, 3.3, 1);
    _ps.position.copy(SPAWN);
    scene.add(_ps);

    _shadow = new THREE.Mesh(new THREE.CircleGeometry(0.7, 16), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.3, depthWrite: false }));
    _shadow.rotation.x = -Math.PI / 2;
    scene.add(_shadow);
    /* _glow removed — was the blue rectangle artifact */
  }

  function _disposeGroup(group) {
    if (!group) return;
    scene.remove(group);
    group.traverse(obj => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose());
        else obj.material.dispose();
      }
    });
  }

  return { init, cleanup, restart, update, triggerDash };
})();
