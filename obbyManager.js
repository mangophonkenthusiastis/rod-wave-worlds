/* ═══════════════════════════════════════════════════════════════════
   obbyManager.js — Rod Wave Worlds · TITAN TOWER v2.0
   A hollow vertical cylinder. The player climbs the inner path.

   Physics reference (JUMP_V=28, GRAVITY=32, FALL_MULT=1.6):
     Rise time   = 28/32 = 0.875 s
     Apex height = ½ × 28² / 32 = 12.25 u above launch
     Fall time  ≈ 0.875 / √1.6  = 0.69 s
     Total air  ≈ 1.57 s
     Walk dist  = 13 × 1.57 = 20.4 u  →  safe gap  ≤ 15 u
     Sprint dist= 24 × 1.57 = 37.7 u  →  sprint gap ≤ 28 u
     Dash adds ≈ 45 u burst            →  dash gap   ≤ 44 u
   Double-jump reaches 2× apex = 24.5 u vertical.
   ═══════════════════════════════════════════════════════════════════ */

const ObbyManager = (function () {

  /* ── PHYSICS ─────────────────────────────────────────────────────── */
  const GRAVITY        = 32;
  const FALL_MULT      = 1.6;
  const TERMINAL_VEL   = -30;
  const JUMP_V         = 28;    // buffed — snappy launch
  const JUMP2_V        = 26;    // double-jump
  const MOVE_SPEED     = 13;
  const SPRINT_SPEED   = 24;    // unlimited Shift-sprint
  const SPRINT_ACCEL   = 12;
  const AIR_CTRL       = 0.88;  // 88% air control
  const DASH_SPEED     = 55;    // burst magnitude
  const DASH_DECAY     = 0.07;  // fraction of dash vel kept per sec
  const DASH_CD        = 1.5;
  const COYOTE_TIME    = 0.15;
  const JUMP_BUF_TIME  = 0.10;  // 100 ms jump-buffer window
  const BASE_FOV       = 70;
  const DASH_FOV       = 90;
  const FOOT           = 1.6;   // sprite centre → feet offset
  const HEAD           = 0.5;   // sprite centre → head offset
  const SPAWN          = new THREE.Vector3(0, 3, 0);

  /* ── TOWER GEOMETRY ─────────────────────────────────────────────── */
  const TOWER_R  = 52;   // inner cylinder radius (visual only — no wall collision)
  const TOWER_H  = 318;  // total height

  /* ── GRAVITY FLIP ───────────────────────────────────────────────── */
  const GRAV_FLIP_DUR = 3.0;

  /* ══════════════════════════════════════════════════════════════════
     PRIVATE STATE
  ══════════════════════════════════════════════════════════════════ */
  let _ps, _shadow, _nametag, _glow;
  let _velY = 0, _jumpCount = 0;
  let _coyoteT = 0, _jumpBufT = 0;
  let _groundPlat = null;
  let _dashCd = 0, _dvx = 0, _dvz = 0;
  let _sprintFactor = 0, _wasSpace = false;
  let _fovTarget = BASE_FOV, _fovCurrent = BASE_FOV;
  let _deathCount = 0, _runTimer = 0, _timerActive = false;
  let _deathCooldown = false;
  let _checkpoints = [], _currentCp = null, _lastCpId = -1, _totalCps = 0;
  let _stageNum = 1;

  // Scene groups — keeps collision & decoration cleanly separated
  let _obbyGroup = null;  // collidable platforms → Raycaster target
  let _decoGroup = null;  // purely visual (neon, wires, rings, signs)
  let _skyDome   = null;
  let _ambParts  = [];
  let _dparts    = [];    // dash / jump VFX

  // Collision arrays — all Box3-AABB records { x,y,z,w,h,d, type }
  let _platforms  = [];
  let _kills      = [];
  let _movePlats  = [];
  let _dynPlats   = [];   // phasing, piston, etc.

  // Obstacle state
  let _laserGrids   = [];
  let _gravFlippers = [];
  let _shrinkPlats  = [];
  let _windTunnels  = [];
  let _pendulums    = [];
  let _phasingPlats = [];
  let _memoryPaths  = [];
  let _boostPads    = [];
  let _crushers     = [];

  // Gravity flip state
  let _gravInverted   = false;
  let _gravFlipTimer  = 0;

  /* ══════════════════════════════════════════════════════════════════
     INIT
  ══════════════════════════════════════════════════════════════════ */
  function init() {
    // Reset all state
    _platforms=[]; _kills=[]; _movePlats=[]; _dynPlats=[];
    _checkpoints=[]; _dparts=[]; _ambParts=[];
    _laserGrids=[]; _gravFlippers=[]; _shrinkPlats=[];
    _windTunnels=[]; _pendulums=[]; _phasingPlats=[];
    _memoryPaths=[]; _boostPads=[]; _crushers=[];
    _totalCps=0; _deathCount=0; _runTimer=0; _timerActive=true;
    _lastCpId=-1; _currentCp=null; _velY=0; _jumpCount=0;
    _dvx=0; _dvz=0; _dashCd=0; _deathCooldown=false;
    _groundPlat=null; _sprintFactor=0; _wasSpace=false;
    _fovTarget=BASE_FOV; _fovCurrent=BASE_FOV;
    _gravInverted=false; _gravFlipTimer=0;
    _stageNum=1;

    if (camera) { camera.fov = BASE_FOV; camera.updateProjectionMatrix(); }

    _obbyGroup = new THREE.Group();
    _decoGroup = new THREE.Group();
    scene.add(_obbyGroup);
    scene.add(_decoGroup);

    _createPlayer();
    _createSkyAtmo();
    _buildTitanTower();
    _updateHUD();
  }

  /* ── CLEANUP — disposes ALL geometry/materials to kill memory leaks ─ */
  function cleanup() {
    function disposeGroup(grp) {
      if (!grp) return;
      grp.traverse(obj => {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) {
          if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose());
          else obj.material.dispose();
        }
      });
      scene.remove(grp);
    }
    disposeGroup(_obbyGroup);
    disposeGroup(_decoGroup);
    _dparts.forEach(dp => {
      scene.remove(dp.mesh);
      if (dp.mesh.geometry) dp.mesh.geometry.dispose();
      if (dp.mesh.material) dp.mesh.material.dispose();
    });
    _ambParts.forEach(ap => scene.remove(ap));
    if (_skyDome) scene.remove(_skyDome);
    if (_ps)      scene.remove(_ps);
    if (_shadow)  scene.remove(_shadow);
    if (_nametag) scene.remove(_nametag);
    if (_glow)    scene.remove(_glow);
    _obbyGroup=null; _decoGroup=null; _skyDome=null;
    _ps=null; _shadow=null; _nametag=null; _glow=null;
  }

  /* ── PLAYER SPRITE ──────────────────────────────────────────────── */
  function _createPlayer() {
    const tex = new THREE.TextureLoader().load(
      'https://i.postimg.cc/6pzzgj5j/39-Rod-Wave-1200x834-2.webp'
    );
    _ps = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false })
    );
    _ps.scale.set(2.2, 3.3, 1);
    _ps.position.copy(SPAWN);
    scene.add(_ps);

    _shadow = new THREE.Mesh(
      new THREE.CircleGeometry(0.7, 16),
      new THREE.MeshBasicMaterial({ color:0x000000, transparent:true, opacity:0.35, depthWrite:false })
    );
    _shadow.rotation.x = -Math.PI / 2;
    scene.add(_shadow);

    const nc = document.createElement('canvas'); nc.width=256; nc.height=64;
    const nx = nc.getContext('2d');
    nx.fillStyle='rgba(0,0,0,0.55)';
    nx.beginPath(); nx.roundRect(4,4,248,56,10); nx.fill();
    nx.font='bold 28px "Barlow Condensed",sans-serif';
    nx.fillStyle='#c9a84c'; nx.textAlign='center'; nx.fillText('ROD WAVE',128,38);
    _nametag = new THREE.Sprite(
      new THREE.SpriteMaterial({ map:new THREE.CanvasTexture(nc), transparent:true, depthWrite:false })
    );
    _nametag.scale.set(2.8, 0.7, 1);
    scene.add(_nametag);

    _glow = new THREE.Sprite(
      new THREE.SpriteMaterial({ color:0xc9a84c, transparent:true, opacity:0.18, depthWrite:false })
    );
    _glow.scale.set(4.5, 5.5, 1);
    scene.add(_glow);
  }

  /* ── SKY + AMBIENT DUST ─────────────────────────────────────────── */
  function _createSkyAtmo() {
    const c = document.createElement('canvas'); c.width=2; c.height=512;
    const ctx = c.getContext('2d');
    const g = ctx.createLinearGradient(0,0,0,512);
    g.addColorStop(0.00, '#000008');
    g.addColorStop(0.25, '#04001a');
    g.addColorStop(0.50, '#0a0030');
    g.addColorStop(0.75, '#160050');
    g.addColorStop(1.00, '#200840');
    ctx.fillStyle = g; ctx.fillRect(0,0,2,512);
    _skyDome = new THREE.Mesh(
      new THREE.SphereGeometry(900, 32, 16),
      new THREE.MeshBasicMaterial({ map:new THREE.CanvasTexture(c), side:THREE.BackSide, fog:false })
    );
    scene.add(_skyDome);

    if (scene.fog) { scene.fog.color.set(0x050010); scene.fog.density = 0.0015; }
    scene.background = new THREE.Color(0x050010);

    // Neon dust particles (purple + cyan palette)
    const cnt = isMobile ? 60 : 120;
    for (let i = 0; i < cnt; i++) {
      const hue = Math.random() < 0.5 ? (0.75 + Math.random() * 0.15) : (0.48 + Math.random() * 0.12);
      const m = new THREE.Mesh(
        new THREE.SphereGeometry(Math.random() * 0.12 + 0.03, 4, 4),
        new THREE.MeshBasicMaterial({
          color: new THREE.Color().setHSL(hue, 1.0, 0.6 + Math.random() * 0.3),
          transparent: true, opacity: 0.15 + Math.random() * 0.5, depthWrite: false
        })
      );
      m.position.set(
        (Math.random() - 0.5) * 80,
        Math.random() * TOWER_H * 0.9 + 5,
        (Math.random() - 0.5) * 80
      );
      m.userData.floatSpd = 0.2 + Math.random() * 0.6;
      m.userData.floatOff = Math.random() * Math.PI * 2;
      m.userData.driftX   = (Math.random() - 0.5) * 0.008;
      m.userData.driftZ   = (Math.random() - 0.5) * 0.008;
      scene.add(m);
      _ambParts.push(m);
    }
  }

  /* ══════════════════════════════════════════════════════════════════
     TITAN TOWER BUILDER
  ══════════════════════════════════════════════════════════════════ */
  function _buildTitanTower() {
    _buildTowerShell();
    _buildStage1();     // y: 2 → 55   Tutorial spiral
    _buildStage2();     // y: 55 → 110 Wind tunnels + moving
    _buildStage3();     // y: 110 → 165 Phasing + laser grids
    _buildBranchSign(165, '⚔ TRIALS', '⚡ SPEED');
    _buildStage4();     // y: 165 → 220 Gravity + pendulums (two paths)
    _buildStage5();     // y: 220 → 270 Memory + shrink
    _buildBranchSign(270, '🔥 CHAOS', '⚡ GATES');
    _buildStage6();     // y: 270 → 312 All mechanics
    _buildFinishPad();  // y: 314
  }

  /* ── TOWER SHELL (visual only — no collision on walls) ───────────── */
  function _buildTowerShell() {
    // Outer cylinder — BackSide so we see it from inside
    const wallGeo = new THREE.CylinderGeometry(TOWER_R + 3, TOWER_R + 3, TOWER_H + 20, 48, 1, true);
    const wallMat = new THREE.MeshPhongMaterial({
      color: 0x080018, emissive: 0x110022, emissiveIntensity: 0.3,
      transparent: true, opacity: 0.9, side: THREE.BackSide
    });
    const wall = new THREE.Mesh(wallGeo, wallMat);
    wall.position.y = TOWER_H / 2;
    _decoGroup.add(wall);

    // Neon ring bands every 50 units (hue cycles purple → cyan → teal)
    for (let ry = 0; ry <= TOWER_H; ry += 50) {
      const hue = 0.62 + (ry / TOWER_H) * 0.35;
      const band = new THREE.Mesh(
        new THREE.TorusGeometry(TOWER_R + 1.5, 0.3, 8, 48),
        new THREE.MeshBasicMaterial({ color: new THREE.Color().setHSL(hue, 1, 0.55), transparent: true, opacity: 0.75 })
      );
      band.rotation.x = Math.PI / 2;
      band.position.y = ry;
      _decoGroup.add(band);
    }

    // Vertical neon wire beams on inner wall surface
    const BEAM_COUNT = isMobile ? 8 : 16;
    for (let b = 0; b < BEAM_COUNT; b++) {
      const ang  = (b / BEAM_COUNT) * Math.PI * 2;
      const hue2 = b % 2 === 0 ? 0.77 : 0.52;
      const beam = new THREE.Mesh(
        new THREE.CylinderGeometry(0.09, 0.09, TOWER_H, 4, 1),
        new THREE.MeshBasicMaterial({ color: new THREE.Color().setHSL(hue2, 1, 0.6), transparent: true, opacity: 0.4 })
      );
      beam.position.set(Math.cos(ang) * TOWER_R, TOWER_H / 2, Math.sin(ang) * TOWER_R);
      _decoGroup.add(beam);
    }

    // Diagonal neon cross-wires (decoration only)
    const WIRE_SEGS = Math.floor(TOWER_H / 22);
    for (let w = 0; w < WIRE_SEGS; w++) {
      const wy  = w * 22 + 11;
      const ang = (w / WIRE_SEGS) * Math.PI;
      const hue = 0.55 + Math.random() * 0.3;
      const wire = new THREE.Mesh(
        new THREE.BoxGeometry(0.06, 0.06, TOWER_R * 1.85),
        new THREE.MeshBasicMaterial({ color: new THREE.Color().setHSL(hue, 1, 0.6), transparent: true, opacity: 0.22 })
      );
      wire.position.set(0, wy, 0);
      wire.rotation.y = ang;
      _decoGroup.add(wire);
    }

    // Small glowing orbs scattered on inner walls
    const ORB_COUNT = isMobile ? 20 : 45;
    for (let o = 0; o < ORB_COUNT; o++) {
      const ang = Math.random() * Math.PI * 2;
      const oy  = Math.random() * TOWER_H * 0.95 + 3;
      const hue = Math.random() < 0.5 ? 0.78 : 0.5;
      const orb = new THREE.Mesh(
        new THREE.SphereGeometry(0.15 + Math.random() * 0.22, 6, 6),
        new THREE.MeshBasicMaterial({ color: new THREE.Color().setHSL(hue, 1, 0.7), transparent: true, opacity: 0.6 })
      );
      orb.position.set(Math.cos(ang) * (TOWER_R - 0.6), oy, Math.sin(ang) * (TOWER_R - 0.6));
      _decoGroup.add(orb);
    }

    // Kill floor at bottom of tower
    _kills.push({ x:0, y:-1, z:0, w:300, h:1, d:300 });

    // Start pad (cylinder shape, collision stored as square AABB that fits)
    const startMesh = new THREE.Mesh(
      new THREE.CylinderGeometry(12, 12, 1.8, 24),
      new THREE.MeshPhongMaterial({ color:0x0a1a10, emissive:0x003322, emissiveIntensity:0.5 })
    );
    startMesh.position.set(0, 0.9, 0);
    _obbyGroup.add(startMesh);
    _platforms.push({ x:0, y:0.9, z:0, w:22, h:1.8, d:22, type:'normal' });

    // Glowing spawn ring (visual only)
    const spawnRing = new THREE.Mesh(
      new THREE.TorusGeometry(5, 0.22, 8, 32),
      new THREE.MeshBasicMaterial({ color:0x00ff88, transparent:true, opacity:0.9 })
    );
    spawnRing.rotation.x = Math.PI / 2;
    spawnRing.position.set(0, 1.9, 0);
    spawnRing.userData.floatStar = true;
    spawnRing.userData.baseY = 1.9;
    _decoGroup.add(spawnRing);
  }

  /* ── BRANCH SIGNS ───────────────────────────────────────────────── */
  function _buildBranchSign(y, leftLabel, rightLabel) {
    _mkDecoSign(-18, y + 3, 0, leftLabel, 0xff4422);
    _mkDecoSign( 18, y + 3, 0, rightLabel, 0x22aaff);
    // Connector pads on both sides
    _mkPlat(-20, y, 0, 9, 0.9, 9, 0x551111, 'normal');
    _mkPlat( 20, y, 0, 9, 0.9, 9, 0x112255, 'normal');
    // Centre connector to merge both paths later
    _mkPlat(0, y, 0, 12, 0.9, 12, 0x222233, 'normal');
  }

  /* ── STAGE 1: Tutorial Spiral (y: 2 → 55) ──────────────────────── */
  // 20 platforms — teach walk, sprint, jump, double-jump
  // Horizontal gaps ≤ 14 u, vertical steps ≤ 5 u — all walkable
  function _buildStage1() {
    const NUM = 20;
    for (let i = 0; i < NUM; i++) {
      const t   = i / NUM;
      const ang = t * Math.PI * 4.2 + 0.15;
      const r   = 28 + Math.sin(t * Math.PI * 2) * 12;
      const px  = Math.cos(ang) * r;
      const pz  = Math.sin(ang) * r;
      const py  = 4 + i * 2.6 + Math.random() * 0.5;
      const sz  = Math.max(3.5, 6.0 - t * 2.5);

      if (i < 5)        _mkPlat(px, py, pz, sz, 0.5, sz, 0x1a6030, 'normal');
      else if (i < 12)  _mkPlat(px, py, pz, sz, 0.5, sz, 0x1a3070, 'normal');
      else if (i < 17) {
        if (i % 3 === 0) _mkMovingPlat(px, py, pz, sz, 0.5, sz, 0x552288, i % 2 === 0 ? 'x' : 'z', 5 + t * 4, 2 + t);
        else             _mkPlat(px, py, pz, sz, 0.5, sz, 0x332299, 'normal');
      } else {
        _mkPlat(px, py, pz, sz, 0.5, sz, 0x661166, 'normal');
      }
    }
    _mkCheckpointRing(1, 0, 55, 0);
    _mkPlat(0, 56, 0, 10, 1, 10, 0x1a3050, 'normal');
  }

  /* ── STAGE 2: Wind Tunnels + Moving Platforms (y: 55 → 110) ─────── */
  function _buildStage2() {
    const SY = 57, EY = 109;
    const NUM = 18;
    for (let i = 0; i < NUM; i++) {
      const t   = i / NUM;
      const ang = t * Math.PI * 3.5 + Math.PI * 0.3;
      const r   = 20 + Math.sin(t * Math.PI * 1.5) * 18;
      const px  = Math.cos(ang) * r;
      const pz  = Math.sin(ang) * r;
      const py  = SY + t * (EY - SY);
      const sz  = Math.max(3.0, 5.5 - t * 2.0);

      if (i % 4 === 0) _mkMovingPlat(px, py, pz, sz, 0.5, sz, 0x224488, i % 2 === 0 ? 'x' : 'z', 7 + t * 5, 2.5 + t * 1.5);
      else             _mkPlat(px, py, pz, sz, 0.5, sz, 0x1a4488, 'normal');

      // Wind tunnel zones — push toward tower centre
      if (i % 6 === 3) {
        const wCX = px * 0.45, wCZ = pz * 0.45;
        const fX  = -px / Math.max(1, Math.abs(px)) * 8;
        const fZ  = -pz / Math.max(1, Math.abs(pz)) * 8;
        _mkWindTunnel(wCX, py - 1, wCZ, 16, 8, 16, fX, fZ);
      }
    }
    _mkCheckpointRing(2, 0, 110, 0);
    _mkPlat(0, 111, 0, 10, 1, 10, 0x1a3050, 'normal');
  }

  /* ── STAGE 3: Phasing Tightropes + Laser Grid Elevators (110→165) ─ */
  function _buildStage3() {
    const SY = 112, EY = 163;
    const NUM = 20;
    for (let i = 0; i < NUM; i++) {
      const t   = i / NUM;
      const ang = t * Math.PI * 3.8 + Math.PI * 0.55;
      const r   = 22 + Math.cos(t * Math.PI * 2) * 15;
      const px  = Math.cos(ang) * r;
      const pz  = Math.sin(ang) * r;
      const py  = SY + t * (EY - SY);
      const sz  = Math.max(2.5, 4.5 - t * 1.8);

      if (i % 5 === 2) {
        // Phasing tightrope — gaps require timing (cycle 2 s)
        _mkPhasingTightrope(px, py, pz, 6 + t * 3, 0.5 + t * 0.4, 2.0, i * 0.38);
      } else if (i % 5 === 4) {
        // Normal pad with laser grid elevator alongside it
        _mkPlat(px, py, pz, sz, 0.5, sz, 0x334499, 'normal');
        _mkLaserGrid(px, py - 7, pz, 11, 0.3, 1.5, py - 9, py + 4, 4 + t * 3);
      } else {
        _mkPlat(px, py, pz, sz, 0.5, sz, 0x224477, 'normal');
      }
    }
    _mkCheckpointRing(3, 0, 164, 0);
    _mkPlat(0, 165, 0, 12, 1, 12, 0x1a2040, 'normal');
  }

  /* ── STAGE 4: Gravity Flippers + Pendulum Hammers (165 → 220) ───── */
  // Left / Trials path: gravity flippers + pendulums
  // Right / Speed path: boost pads + dash gaps
  function _buildStage4() {
    // ── PATH OF TRIALS (left, x negative) ──
    const TRIAL = [
      { x:-25, y:172, z:  8 }, { x:-36, y:178, z: -6 },
      { x:-22, y:185, z:-16 }, { x:-30, y:193, z:  8 },
      { x:-18, y:201, z: 16 }, { x:-28, y:209, z:  0 },
      { x:-20, y:216, z:-10 }, { x:-10, y:220, z:  0 },
    ];
    TRIAL.forEach((p, i) => {
      const sz = Math.max(2.8, 4.5 - i * 0.18);
      _mkPlat(p.x, p.y, p.z, sz, 0.5, sz, 0x882233, 'normal');
      if (i % 2 === 1)      _mkGravityFlipper(p.x, p.y + 3, p.z, 6.5);
      if (i === 3 || i === 5 || i === 7) {
        _mkPendulum(p.x + 9, p.y + 12, p.z, 9, 1.5 + i * 0.12, Math.PI * 0.62 + i * 0.08);
      }
    });

    // ── PATH OF SPEED (right, x positive) ──
    // Gaps at index 3→4 are ~30 u — requires dash
    const SPEED = [
      { x: 26, y:172, z: -8 }, { x: 38, y:176, z:  6 },
      { x: 30, y:180, z: 20 }, { x: 18, y:186, z: 30 },
      { x:  8, y:191, z: 20 }, { x: 20, y:197, z:  6 },
      { x: 32, y:203, z: -8 }, { x: 20, y:211, z:  0 },
      { x:  8, y:219, z:  5 },
    ];
    SPEED.forEach((p, i) => {
      _mkPlat(p.x, p.y, p.z, 3.5, 0.5, 3.5, 0x224488, 'normal');
      if (i % 3 === 2) _mkBoostPad(p.x, p.y + 0.28, p.z, 20);
    });

    // Converge
    _mkPlat(0, 220, 0, 14, 1, 14, 0x223355, 'normal');
    _mkCheckpointRing(4, 0, 221, 0);
  }

  /* ── STAGE 5: Memory Paths + Shrinking Platforms (220 → 270) ─────── */
  function _buildStage5() {
    const SY = 222, EY = 268;
    const NUM = 16;
    for (let i = 0; i < NUM; i++) {
      const t   = i / NUM;
      const ang = t * Math.PI * 3 + Math.PI * 1.1;
      const r   = 18 + Math.sin(t * Math.PI * 2.5) * 16;
      const px  = Math.cos(ang) * r;
      const pz  = Math.sin(ang) * r;
      const py  = SY + t * (EY - SY);
      const sz  = Math.max(2.5, 4.0 - t * 1.5);

      if (i > 0 && i % 6 === 0) {
        _mkMemoryPath(px, py, pz, sz, Math.floor(Math.random() * 3), i * 0.33);
      } else if (i % 4 === 2) {
        _mkShrinkPlat(px, py, pz, sz, 0.5, sz, 0x994422);
      } else {
        _mkPlat(px, py, pz, sz, 0.5, sz, 0x553399, 'normal');
      }
    }
    _mkCheckpointRing(5, 0, 269, 0);
    _mkPlat(0, 270, 0, 12, 1, 12, 0x1a1a40, 'normal');
  }

  /* ── STAGE 6: CHAOS (270 → 312) ─────────────────────────────────── */
  // Left / Chaos path: all obstacle types in sequence
  // Right / Speed Gate Slalom: massive gaps needing Q-Dash + boost pads
  function _buildStage6() {
    // ── CHAOS PATH (left) ──
    const CP = [
      { x:-22, y:277, z:  5 }, { x:-32, y:283, z:-10 },
      { x:-18, y:289, z:-22 }, { x:-28, y:295, z: -8 },
      { x:-15, y:301, z:  8 }, { x: -5, y:308, z:  0 },
    ];
    CP.forEach((p, i) => {
      const sz = 3.0;
      if (i === 0) _mkShrinkPlat(p.x, p.y, p.z, sz, 0.5, sz, 0xaa2244);
      else if (i === 1) _mkPhasingTightrope(p.x, p.y, p.z, 7, 0.5, 2.5, i * 0.42);
      else if (i === 2) {
        _mkPlat(p.x, p.y, p.z, sz, 0.5, sz, 0x882255, 'normal');
        _mkPendulum(p.x, p.y + 12, p.z + 7, 10, 1.8, Math.PI * 0.7);
      } else if (i === 3) {
        _mkGravityFlipper(p.x, p.y + 3, p.z, 7);
        _mkPlat(p.x, p.y, p.z, sz, 0.5, sz, 0x992266, 'normal');
      } else {
        _mkPlat(p.x, p.y, p.z, sz, 0.5, sz, 0xaa3377, 'normal');
      }
    });

    // Crusher ceiling — slowly descends between y=289–296 on chaos path
    _mkCrusher(-22, 296, -10, 20, 1.2, 20, 290, 4, 0.75);

    // Wind tunnel on chaos path to push player off course
    _mkWindTunnel(-20, 300, 5, 18, 8, 16, 6, 0);

    // ── SPEED GATE SLALOM (right) ──
    // Gaps are 28-38 u — strictly require dash + boost pad combo
    const SP = [
      { x: 22, y:277, z: -5 }, { x: 38, y:281, z: 13 },
      { x: 20, y:287, z: 30 }, { x:  8, y:293, z: 16 },
      { x: 22, y:301, z:  0 }, { x:  8, y:308, z:  0 },
    ];
    SP.forEach((p, i) => {
      _mkPlat(p.x, p.y, p.z, 3.5, 0.5, 3.5, 0x2255aa, 'normal');
      _mkBoostPad(p.x, p.y + 0.28, p.z, 22);
      // Laser grid between each gate
      if (i < SP.length - 1) {
        const nx2 = (p.x + SP[i+1].x) * 0.5;
        const ny2 = (p.y + SP[i+1].y) * 0.5;
        const nz2 = (p.z + SP[i+1].z) * 0.5;
        _mkLaserGrid(nx2, ny2 - 4, nz2, 10, 0.3, 1, ny2 - 6, ny2 + 3, 5 + i);
      }
    });

    // Final checkpoint before finish
    _mkCheckpointRing(6, 0, 308, 0);
    _mkPlat(0, 310, 0, 14, 1, 14, 0x333355, 'normal');
  }

  /* ── FINISH PAD ─────────────────────────────────────────────────── */
  function _buildFinishPad() {
    const FY = 314;
    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(18, 18, 2.5, 24),
      new THREE.MeshPhongMaterial({ color:0xcc9900, emissive:0xaa7700, emissiveIntensity:0.5 })
    );
    body.position.set(0, FY - 0.75, 0);
    _obbyGroup.add(body);
    // Wide AABB — covers the cylinder footprint
    _platforms.push({ x:0, y:FY-0.75, z:0, w:36, h:2.5, d:36, type:'win' });

    // Victory pillars + floating orbs
    for (let i = 0; i < 8; i++) {
      const ang = (i / 8) * Math.PI * 2;
      const pillar = new THREE.Mesh(
        new THREE.CylinderGeometry(0.5, 0.65, 20, 8),
        new THREE.MeshPhongMaterial({ color:0xFFD700, emissive:0xaa8800, emissiveIntensity:0.5 })
      );
      pillar.position.set(Math.cos(ang) * 15, FY + 9, Math.sin(ang) * 15);
      _decoGroup.add(pillar);

      const orb = new THREE.Mesh(
        new THREE.SphereGeometry(0.8, 8, 8),
        new THREE.MeshBasicMaterial({ color:0xffd700, transparent:true, opacity:0.9 })
      );
      orb.position.set(Math.cos(ang) * 15, FY + 20, Math.sin(ang) * 15);
      orb.userData.floatStar = true;
      orb.userData.baseY = FY + 20;
      _decoGroup.add(orb);
    }

    const arch = new THREE.Mesh(
      new THREE.BoxGeometry(36, 2, 1),
      new THREE.MeshPhongMaterial({ color:0xFFD700, emissive:0xddaa00, emissiveIntensity:0.6 })
    );
    arch.position.set(0, FY + 20, 0);
    _decoGroup.add(arch);

    // Gold ground glow disc
    const glow = new THREE.Mesh(
      new THREE.CylinderGeometry(18, 18, 0.1, 24),
      new THREE.MeshBasicMaterial({ color:0xFFD700, transparent:true, opacity:0.22 })
    );
    glow.position.set(0, FY - 0.44, 0);
    _decoGroup.add(glow);
  }

  /* ══════════════════════════════════════════════════════════════════
     OBSTACLE BUILDERS
     All collidable geometry is added to _obbyGroup.
     All purely visual geometry is added to _decoGroup.
     Every collidable mesh gets a matching AABB record in _platforms.
  ══════════════════════════════════════════════════════════════════ */

  /* ── NORMAL PLATFORM ─────────────────────────────────────────────── */
  function _mkPlat(x, y, z, w, h, d, color, type) {
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(w, h, d),
      new THREE.MeshPhongMaterial({ color, shininess:55 })
    );
    m.position.set(x, y, z);
    m.castShadow = true; m.receiveShadow = true;
    _obbyGroup.add(m);

    // Glowing top trim (visual only)
    const trim = new THREE.Mesh(
      new THREE.BoxGeometry(w, 0.06, d),
      new THREE.MeshPhongMaterial({ color:_lighten(color,65), emissive:color, emissiveIntensity:0.5 })
    );
    trim.position.set(x, y + h / 2 + 0.03, z);
    _decoGroup.add(trim);

    _platforms.push({ x, y, z, w, h, d, type: type || 'normal' });
  }

  /* ── MOVING PLATFORM ─────────────────────────────────────────────── */
  function _mkMovingPlat(x, y, z, w, h, d, color, axis, range, speed) {
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(w, h, d),
      new THREE.MeshPhongMaterial({ color, emissive:color, emissiveIntensity:0.25, shininess:65 })
    );
    m.position.set(x, y, z);
    m.castShadow = true; m.receiveShadow = true;
    _obbyGroup.add(m);

    const stripe = new THREE.Mesh(
      new THREE.BoxGeometry(axis === 'x' ? w * 0.6 : w * 0.2, 0.06, axis === 'z' ? d * 0.6 : d * 0.2),
      new THREE.MeshBasicMaterial({ color:_lighten(color,90), transparent:true, opacity:0.8 })
    );
    stripe.position.y = h / 2 + 0.03;
    m.add(stripe);

    const mp = { mesh:m, x, y, z, w, h, d, axis, range, speed, offset:0, dir:1, prevMX:x, prevMY:y, prevMZ:z };
    _movePlats.push(mp);
    _platforms.push({ x, y, z, w, h, d, type:'moving', mpRef:mp });
  }

  /* ── PHASING TIGHTROPE (solid ↔ non-solid every cycleTime/2 s) ───── */
  function _mkPhasingTightrope(x, y, z, len, w, cycleTime, phase) {
    const ang = Math.random() * Math.PI;
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(w, 0.15, len),
      new THREE.MeshPhongMaterial({ color:0x00ccff, emissive:0x004488, emissiveIntensity:0.6,
                                    transparent:true, opacity:1 })
    );
    m.position.set(x, y, z);
    m.rotation.y = ang;
    m.castShadow = true;
    _obbyGroup.add(m);

    // Support posts (visual)
    const sinA = Math.sin(ang), cosA = Math.cos(ang);
    [-len / 2, len / 2].forEach(off => {
      const post = new THREE.Mesh(
        new THREE.CylinderGeometry(0.1, 0.14, 2.2, 6),
        new THREE.MeshPhongMaterial({ color:0x0088cc })
      );
      post.position.set(x + sinA * off, y + 1.1, z + cosA * off);
      _decoGroup.add(post);
    });

    const sa = Math.abs(sinA), ca = Math.abs(cosA);
    const pp = {
      x, y, z,
      w: len * sa + w * ca + 0.4,
      h: 0.15,
      d: len * ca + w * sa + 0.4,
      type:'phasing', phase, cycleTime, visible:true, mesh:m
    };
    _platforms.push(pp);
    _dynPlats.push(pp);
    _phasingPlats.push(pp);
  }

  /* ── LASER GRID ELEVATOR ─────────────────────────────────────────── */
  // Visual grid + moving kill zone. The grid has a CLEAR visual = no invisible kills.
  function _mkLaserGrid(x, y, z, w, h, d, minY, maxY, speed) {
    const group = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ color:0xff0022, transparent:true, opacity:0.8, side:THREE.DoubleSide });

    // Horizontal bars
    const HBARS = 5;
    for (let b = 0; b < HBARS; b++) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(w, 0.12, 0.12), mat.clone());
      bar.position.set(0, (b / (HBARS - 1)) * h - h / 2, 0);
      group.add(bar);
    }
    // Vertical bars
    const VBARS = 4;
    for (let b = 0; b < VBARS; b++) {
      const vbar = new THREE.Mesh(new THREE.BoxGeometry(0.12, h, 0.12), mat.clone());
      vbar.position.set((b / (VBARS - 1)) * w - w / 2, 0, 0);
      group.add(vbar);
    }
    group.position.set(x, y, z);
    _decoGroup.add(group);

    // Kill zone tracks the group
    const killRecord = { x, y, z, w: w * 0.82, h, d: d * 0.82 };
    _kills.push(killRecord);
    _laserGrids.push({ group, killRecord, minY, maxY, speed, dir:1, y });
  }

  /* ── GRAVITY FLIPPER ZONE ────────────────────────────────────────── */
  function _mkGravityFlipper(x, y, z, r) {
    const gem = new THREE.Mesh(
      new THREE.OctahedronGeometry(r * 0.42, 0),
      new THREE.MeshBasicMaterial({ color:0xff44ff, transparent:true, opacity:0.72, wireframe:true })
    );
    gem.position.set(x, y, z);
    gem.userData.floatStar = true;
    gem.userData.baseY = y;
    _decoGroup.add(gem);

    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(r * 0.6, 0.16, 8, 32),
      new THREE.MeshBasicMaterial({ color:0xff44ff, transparent:true, opacity:0.55 })
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.set(x, y, z);
    _decoGroup.add(ring);

    _gravFlippers.push({ x, y, z, r, active:false });
  }

  /* ── SHRINKING PLATFORM ──────────────────────────────────────────── */
  function _mkShrinkPlat(x, y, z, w, h, d, color) {
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(w, h, d),
      new THREE.MeshPhongMaterial({ color, emissive:color, emissiveIntensity:0.42 })
    );
    m.position.set(x, y, z);
    m.castShadow = true;
    _obbyGroup.add(m);

    // Warning stripe (orange chevron on top)
    const stripe = new THREE.Mesh(
      new THREE.BoxGeometry(w * 0.7, 0.06, d * 0.7),
      new THREE.MeshBasicMaterial({ color:0xff8800, transparent:true, opacity:0.85 })
    );
    stripe.position.y = h / 2 + 0.03;
    m.add(stripe);

    const platRecord = { x, y, z, w, h, d, type:'shrink', mesh:m, origW:w };
    _platforms.push(platRecord);
    _shrinkPlats.push({ platRef:platRecord, touched:false, scaleTimer:0 });
  }

  /* ── WIND TUNNEL ─────────────────────────────────────────────────── */
  function _mkWindTunnel(x, y, z, w, h, d, forceX, forceZ) {
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(w, h, d),
      new THREE.MeshBasicMaterial({ color:0x0088ff, transparent:true, opacity:0.11, side:THREE.DoubleSide })
    );
    m.position.set(x, y, z);
    _decoGroup.add(m);

    // Direction arrows (cones)
    const ang = Math.atan2(forceX, forceZ);
    for (let c = 0; c < 4; c++) {
      const cone = new THREE.Mesh(
        new THREE.ConeGeometry(0.38, 1.1, 6),
        new THREE.MeshBasicMaterial({ color:0x44aaff, transparent:true, opacity:0.8 })
      );
      cone.rotation.x = -Math.PI / 2 + 0.3;
      cone.rotation.y = ang;
      cone.position.set(
        x + (Math.random() - 0.5) * w * 0.7,
        y + (Math.random() - 0.5) * h * 0.5,
        z + (Math.random() - 0.5) * d * 0.7
      );
      _decoGroup.add(cone);
    }
    _windTunnels.push({ x, y, z, w, h, d, forceX, forceZ });
  }

  /* ── PENDULUM HAMMER ─────────────────────────────────────────────── */
  function _mkPendulum(px, py, pz, length, speed, maxAngle) {
    // Pivot point
    const pivotMesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.38, 8, 8),
      new THREE.MeshPhongMaterial({ color:0x888888 })
    );
    pivotMesh.position.set(px, py, pz);
    _decoGroup.add(pivotMesh);

    // Arm group (rotates around pivot)
    const armGroup = new THREE.Group();
    armGroup.position.set(px, py, pz);
    _decoGroup.add(armGroup);

    const rod = new THREE.Mesh(
      new THREE.CylinderGeometry(0.1, 0.1, length, 6),
      new THREE.MeshPhongMaterial({ color:0x666666 })
    );
    rod.position.y = -length / 2;
    armGroup.add(rod);

    const hammer = new THREE.Mesh(
      new THREE.BoxGeometry(2.8, 2.6, 1.8),
      new THREE.MeshPhongMaterial({ color:0xdd2222, emissive:0x880000, emissiveIntensity:0.5 })
    );
    hammer.position.y = -length - 1.1;
    armGroup.add(hammer);

    const killBox = { x:px, y:py - length, z:pz, w:3.2, h:3.2, d:2.2 };
    _pendulums.push({ armGroup, angle:0, speed, maxAngle, length, px, py, pz, killBox });
  }

  /* ── MEMORY PATH ─────────────────────────────────────────────────── */
  // 3 platforms side-by-side. Briefly reveals which is real (green),
  // then hides all to gray. Only the solid one accepts collision.
  function _mkMemoryPath(cx, cy, cz, sz, solidIdx, phase) {
    const plats = [];
    for (let i = 0; i < 3; i++) {
      const isSolid = (i === solidIdx);
      const px      = cx + (i - 1) * (sz + 1.6);
      const color   = isSolid ? 0x00ff88 : 0xff2244;
      const m = new THREE.Mesh(
        new THREE.BoxGeometry(sz, 0.4, sz),
        new THREE.MeshPhongMaterial({ color, emissive:color, emissiveIntensity:0.55, transparent:true, opacity:1 })
      );
      m.position.set(px, cy, cz);
      m.castShadow = true;
      _obbyGroup.add(m);
      const pr = { x:px, y:cy, z:cz, w:sz, h:0.4, d:sz, type:'memory', isSolid, mesh:m, color };
      _platforms.push(pr);
      plats.push(pr);
    }
    _memoryPaths.push({ platforms:plats, solidIdx, phase, revealTimer:0 });
  }

  /* ── BOOST PAD ───────────────────────────────────────────────────── */
  function _mkBoostPad(x, y, z, force) {
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(3.2, 0.15, 3.2),
      new THREE.MeshBasicMaterial({ color:0x00ffff, transparent:true, opacity:0.82 })
    );
    m.position.set(x, y, z);
    _decoGroup.add(m);

    const arrow = new THREE.Mesh(
      new THREE.ConeGeometry(0.45, 0.85, 6),
      new THREE.MeshBasicMaterial({ color:0xffffff })
    );
    arrow.position.set(x, y + 0.55, z);
    _decoGroup.add(arrow);
    _boostPads.push({ x, y, z, force });
  }

  /* ── CRUSHER CEILING ─────────────────────────────────────────────── */
  // Crusher descends from startY → stopY, then resets. Instant kill on contact.
  function _mkCrusher(x, startY, z, w, h, d, stopY, gap, speed) {
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(w, h, d),
      new THREE.MeshPhongMaterial({ color:0xcc2222, emissive:0x880000, emissiveIntensity:0.55 })
    );
    m.position.set(x, startY, z);
    m.castShadow = true;
    _obbyGroup.add(m);

    // Hazard stripe on underside
    const stripe = new THREE.Mesh(
      new THREE.BoxGeometry(w * 0.9, 0.05, d * 0.9),
      new THREE.MeshBasicMaterial({ color:0xffcc00, transparent:true, opacity:0.95 })
    );
    stripe.position.y = -h / 2 - 0.03;
    m.add(stripe);

    const rec = { mesh:m, y:startY, startY, stopY, speed, dir:-1, x, z, w, h, d };
    _crushers.push(rec);
  }

  /* ── CHECKPOINT RING ─────────────────────────────────────────────── */
  function _mkCheckpointRing(id, x, y, z) {
    _totalCps++;

    // Crystal pillars at four corners
    [[-5,-5],[5,-5],[-5,5],[5,5]].forEach(([dx,dz]) => {
      const pillar = new THREE.Mesh(
        new THREE.CylinderGeometry(0.22, 0.28, 10, 8),
        new THREE.MeshPhongMaterial({ color:0xcc9922, emissive:0x886600, emissiveIntensity:0.4 })
      );
      pillar.position.set(x + dx, y + 5, z + dz);
      _decoGroup.add(pillar);

      const cap = new THREE.Mesh(
        new THREE.CylinderGeometry(0, 0.42, 1.5, 6),
        new THREE.MeshPhongMaterial({ color:0xffe055, emissive:0xffcc00, emissiveIntensity:0.85 })
      );
      cap.position.set(x + dx, y + 10.8, z + dz);
      _decoGroup.add(cap);
    });

    // Outer gate torus
    const outer = new THREE.Mesh(
      new THREE.TorusGeometry(2.8, 0.3, 12, 40),
      new THREE.MeshBasicMaterial({ color:0xffd700, transparent:true, opacity:0.92 })
    );
    outer.rotation.x = Math.PI / 2;
    outer.position.set(x, y + 3.5, z);
    outer.userData.cpRing  = true;
    outer.userData.baseY   = y + 3.5;
    _decoGroup.add(outer);

    // Inner counter-rotating ring
    const inner = new THREE.Mesh(
      new THREE.TorusGeometry(1.9, 0.14, 8, 32),
      new THREE.MeshBasicMaterial({ color:0xffee88, transparent:true, opacity:0.62 })
    );
    inner.rotation.x = Math.PI / 2;
    inner.position.set(x, y + 3.5, z);
    inner.userData.cpRingInner = true;
    _decoGroup.add(inner);

    _checkpoints.push({ id, x, y: y + 1.7, z, meshOuter:outer, meshInner:inner, activated:false });
  }

  /* ── DECORATIVE SIGN ─────────────────────────────────────────────── */
  function _mkDecoSign(x, y, z, text, color) {
    const c = document.createElement('canvas'); c.width=256; c.height=80;
    const ctx = c.getContext('2d');
    ctx.fillStyle = 'rgba(0,0,0,0.72)';
    ctx.fillRect(0, 0, 256, 80);
    ctx.font = 'bold 34px "Bebas Neue",sans-serif';
    ctx.fillStyle = '#' + color.toString(16).padStart(6,'0');
    ctx.textAlign = 'center';
    ctx.fillText(text, 128, 52);
    const s = new THREE.Sprite(
      new THREE.SpriteMaterial({ map:new THREE.CanvasTexture(c), transparent:true })
    );
    s.scale.set(5.5, 1.7, 1);
    s.position.set(x, y, z);
    _decoGroup.add(s);
  }

  /* ══════════════════════════════════════════════════════════════════
     UPDATE — called every frame by animate() in index.html
  ══════════════════════════════════════════════════════════════════ */
  function update(delta) {
    if (_timerActive) {
      _runTimer += delta;
      const mins = Math.floor(_runTimer / 60);
      const secs = Math.floor(_runTimer % 60).toString().padStart(2, '0');
      document.getElementById('timer-display').textContent = `${mins}:${secs}`;
    }
    _updateDynPlatforms(delta);
    _updateObstacles(delta);
    _updatePlayer(delta);
    _checkCollisions(delta);
    _checkCheckpoints();
    _checkBoostPads();
    _updateDashParticles(delta);
    _updateCamera(delta);
    _updateAmbient();
    _updateHUDHeight();
  }

  /* ── DYNAMIC PLATFORMS ──────────────────────────────────────────── */
  function _updateDynPlatforms(delta) {
    // Moving platforms — frame-rate independent
    _movePlats.forEach(mp => {
      mp.prevMX = mp.mesh.position.x;
      mp.prevMY = mp.mesh.position.y;
      mp.prevMZ = mp.mesh.position.z;
      mp.offset += mp.speed * mp.dir * delta;
      if (Math.abs(mp.offset) >= mp.range) mp.dir *= -1;
      if (mp.axis === 'x') mp.mesh.position.x = mp.x + mp.offset;
      if (mp.axis === 'z') mp.mesh.position.z = mp.z + mp.offset;
    });

    // Phasing tightropes — toggle solid/non-solid every half cycle
    _dynPlats.forEach(p => {
      if (p.type === 'phasing') {
        const total = p.cycleTime;
        const t     = ((gt + p.phase) % total + total) % total;
        p.visible   = t < total * 0.5;
        const edge  = 0.25;
        const alpha = p.visible
          ? Math.min(1, t < edge ? t / edge : 1)
          : Math.max(0.04, (total - t) / (total * 0.5) * 0.25);
        p.mesh.material.opacity = alpha;
      }
    });

    // Sync moving platform AABB positions
    _platforms.forEach(p => {
      if (p.type === 'moving' && p.mpRef) {
        p.x = p.mpRef.mesh.position.x;
        p.z = p.mpRef.mesh.position.z;
      }
    });
  }

  /* ── OBSTACLE SYSTEMS ────────────────────────────────────────────── */
  function _updateObstacles(delta) {

    // ① Laser Grid Elevators — move their group + kill AABB together
    _laserGrids.forEach(lg => {
      lg.y += lg.speed * lg.dir * delta;
      if (lg.y >= lg.maxY) lg.dir = -1;
      if (lg.y <= lg.minY) lg.dir =  1;
      lg.group.position.y = lg.y;
      lg.killRecord.y     = lg.y;
    });

    // ② Gravity Flip countdown
    if (_gravInverted) {
      _gravFlipTimer -= delta;
      if (_gravFlipTimer <= 0) {
        _gravInverted = false;
        _showToast('🌍 GRAVITY RESTORED', 0x88ccff, 1100);
      }
    }

    // ③ Gravity Flipper proximity — trigger when player walks into zone
    if (!_gravInverted && _ps) {
      const px = _ps.position.x, py = _ps.position.y, pz = _ps.position.z;
      _gravFlippers.forEach(gf => {
        const dist = Math.sqrt((px-gf.x)**2 + (py-gf.y)**2 + (pz-gf.z)**2);
        if (dist < gf.r && !gf.active) {
          gf.active = true;
          setTimeout(() => { gf.active = false; }, (GRAV_FLIP_DUR + 0.5) * 1000);
          _gravInverted  = true;
          _gravFlipTimer = GRAV_FLIP_DUR;
          _velY          = _gravInverted ? Math.min(_velY, -2) : Math.max(_velY, 2);
          _showToast('↑ GRAVITY FLIPPED!', 0xff44ff, 1000);
        }
      });
    }

    // ④ Shrinking Platforms — shrink 1.5 s after first touch
    _shrinkPlats.forEach(sp => {
      if (!sp.touched) return;
      sp.scaleTimer += delta;
      const t = Math.min(1, sp.scaleTimer / 1.5);
      const s = 1 - t * 0.98;
      sp.platRef.mesh.scale.set(s, 1, s);
      // Shrink collision AABB too so player actually falls through
      sp.platRef.w = sp.platRef.origW * s;
      sp.platRef.d = sp.platRef.origW * s;
      if (t >= 1) {
        sp.platRef.mesh.visible = false;
        sp.platRef.type = 'dead'; // excluded from collision
      }
    });

    // ⑤ Pendulums — sinusoidal swing, kill box follows hammer
    _pendulums.forEach(pen => {
      pen.angle = Math.sin(gt * pen.speed) * pen.maxAngle;
      pen.armGroup.rotation.z = pen.angle;
      // Update kill box world position to match hammer
      pen.killBox.x = pen.px - Math.sin(pen.angle) * pen.length;
      pen.killBox.y = pen.py - Math.cos(pen.angle) * pen.length;
    });

    // ⑥ Memory Paths — 12-second cycle: 3 s reveal (colored), 9 s hidden (gray)
    _memoryPaths.forEach(mp => {
      const cycleTime = 12;
      const t = ((gt + mp.phase * cycleTime) % cycleTime + cycleTime) % cycleTime;
      if (t < 3) {
        // Reveal phase: show true colors
        mp.platforms.forEach(p => {
          p.mesh.material.opacity = Math.min(1, t / 0.4);
          p.mesh.material.color.setHex(p.color);
          p.mesh.material.emissive.setHex(p.color);
        });
      } else {
        // Hidden phase: all look the same gray — remember which was real!
        mp.platforms.forEach((p, i) => {
          p.mesh.material.opacity = 0.88;
          p.mesh.material.color.setHex(0x556677);
          p.mesh.material.emissive.setHex(0x112233);
        });
      }
    });

    // ⑦ Crusher Ceilings — descend then snap back
    _crushers.forEach(cr => {
      cr.y += cr.speed * cr.dir * delta;
      if (cr.y <= cr.stopY) { cr.dir = 1; cr.y = cr.stopY; }
      if (cr.y >= cr.startY) { cr.dir = -1; cr.y = cr.startY; }
      cr.mesh.position.y = cr.y;

      // Check if player is directly under crusher (kill by crush)
      if (_ps) {
        const py       = _ps.position.y;
        const crBottom = cr.y - cr.h / 2;
        if (Math.abs(_ps.position.x - cr.x) < cr.w / 2 &&
            Math.abs(_ps.position.z - cr.z) < cr.d / 2 &&
            py - FOOT < crBottom + 0.6 && py - FOOT > crBottom - 3) {
          _killPlayer();
        }
      }
    });
  }

  /* ── PLAYER PHYSICS + INPUT ─────────────────────────────────────── */
  function _updatePlayer(delta) {
    if (!_ps) return;
    const th = (cameraTheta * Math.PI) / 180;
    const fx = -Math.sin(th), fz = -Math.cos(th);
    const rx = -Math.cos(th), rz =  Math.sin(th);

    // Sprint ramp — Shift held, unlimited, no stamina bar
    if (keys['ShiftLeft'] || keys['ShiftRight']) {
      _sprintFactor = Math.min(1, _sprintFactor + SPRINT_ACCEL * delta);
    } else {
      _sprintFactor = Math.max(0, _sprintFactor - SPRINT_ACCEL * delta);
    }

    const airFactor = (_jumpCount > 0) ? AIR_CTRL : 1.0;
    const baseSpd   = MOVE_SPEED + (SPRINT_SPEED - MOVE_SPEED) * _sprintFactor;
    const spd       = baseSpd * airFactor;

    let mx = 0, mz = 0;
    if (keys['KeyW'] || keys['ArrowUp'])    { mx += fx * spd; mz += fz * spd; }
    if (keys['KeyS'] || keys['ArrowDown'])  { mx -= fx * spd; mz -= fz * spd; }
    if (keys['KeyA'] || keys['ArrowLeft'])  { mx += rx * spd; mz += rz * spd; }
    if (keys['KeyD'] || keys['ArrowRight']) { mx -= rx * spd; mz -= rz * spd; }
    if (isMobile && (Math.abs(touchJoystickX) > 0.15 || Math.abs(touchJoystickY) > 0.15)) {
      mx += (-touchJoystickY * fx - touchJoystickX * rx) * spd;
      mz += (-touchJoystickY * fz - touchJoystickX * rz) * spd;
    }
    const ml = Math.sqrt(mx * mx + mz * mz);
    if (ml > spd) { mx = mx / ml * spd; mz = mz / ml * spd; }

    // Wind tunnel forces (additive, applied before clamping)
    _windTunnels.forEach(wt => {
      const px = _ps.position.x, py = _ps.position.y, pz = _ps.position.z;
      if (px > wt.x - wt.w / 2 && px < wt.x + wt.w / 2 &&
          py - FOOT > wt.y - wt.h / 2 && py < wt.y + wt.h / 2 &&
          pz > wt.z - wt.d / 2 && pz < wt.z + wt.d / 2) {
        mx += wt.forceX;
        mz += wt.forceZ;
      }
    });

    _ps.position.x += mx * delta;
    _ps.position.z += mz * delta;

    // Moving platform carry — drag player with the platform
    if (_groundPlat && _groundPlat.type === 'moving' && _groundPlat.mpRef) {
      const mp = _groundPlat.mpRef;
      _ps.position.x += mp.mesh.position.x - mp.prevMX;
      _ps.position.z += mp.mesh.position.z - mp.prevMZ;
    }

    // ── JUMP SYSTEM (FIXED) ──────────────────────────────────────────
    // jumpCount resets ONLY when isGrounded (in _checkCollisions).
    // Edge-detect Space so held key can't consume both jumps instantly.
    const spaceDown = !!keys['Space'];
    if (spaceDown && !_wasSpace) _jumpBufT = JUMP_BUF_TIME;
    _wasSpace = spaceDown;
    if (_jumpBufT > 0) _jumpBufT -= delta;
    if (_coyoteT  > 0) _coyoteT  -= delta;

    if (_jumpBufT > 0) {
      if (_coyoteT > 0 && _jumpCount < 1) {
        // First jump (ground or coyote-time)
        _velY      = _gravInverted ? -JUMP_V : JUMP_V;
        _jumpCount = 1;
        _coyoteT   = 0; _jumpBufT = 0;
      } else if (_jumpCount === 1) {
        // Double-jump — allowed once in the air
        _velY      = _gravInverted ? -JUMP2_V : JUMP2_V;
        _jumpCount = 2;
        _coyoteT   = 0; _jumpBufT = 0;
        _spawnJumpPuff();
      }
      // jumpCount >= 2 → no more jumps until grounded again
    }

    // ── GRAVITY ─────────────────────────────────────────────────────
    const gravDir  = _gravInverted ? -1 : 1;
    const falling  = _gravInverted ? (_velY > 0) : (_velY < 0);
    const gravMult = falling ? FALL_MULT : 1.0;
    _velY -= GRAVITY * gravMult * gravDir * delta;
    _velY  = _gravInverted
      ? Math.min(_velY, 30)            // inverted terminal (rising cap)
      : Math.max(_velY, TERMINAL_VEL); // normal terminal velocity

    _ps.position.y += _velY * delta;

    // ── DASH VELOCITY DECAY ──────────────────────────────────────────
    const dspd = Math.sqrt(_dvx * _dvx + _dvz * _dvz);
    if (dspd > 0.12) {
      _ps.position.x += _dvx * delta;
      _ps.position.z += _dvz * delta;
      const decay = Math.pow(DASH_DECAY, delta);
      _dvx *= decay; _dvz *= decay;
      if (dspd > 5 && renderer) {
        const sk = Math.min(dspd * 0.18, 2.0);
        renderer.domElement.style.transform =
          `translate(${(Math.random()-0.5)*sk}px,${(Math.random()-0.5)*sk*0.5}px)`;
      }
    } else {
      _dvx = 0; _dvz = 0;
      if (renderer && renderer.domElement.style.transform)
        renderer.domElement.style.transform = '';
    }

    // ── DASH COOLDOWN HUD ────────────────────────────────────────────
    if (_dashCd > 0) {
      _dashCd = Math.max(0, _dashCd - delta);
      document.getElementById('dash-cooldown-fill').style.height = (_dashCd / DASH_CD * 100) + '%';
      if (_dashCd <= 0) {
        document.getElementById('dash-icon').className = 'ready';
        document.getElementById('dash-cooldown-fill').style.height = '0%';
      }
    }
    if (isMobile) {
      const db = document.getElementById('touch-dash-btn');
      if (_dashCd > 0) db.classList.add('on-cooldown');
      else             db.classList.remove('on-cooldown');
    }

    // Soft cylinder wall clamp (prevents leaving tower through visual wall)
    const pr = Math.sqrt(_ps.position.x ** 2 + _ps.position.z ** 2);
    if (pr > TOWER_R - 1) {
      _ps.position.x *= (TOWER_R - 1) / pr;
      _ps.position.z *= (TOWER_R - 1) / pr;
    }
  }

  function _spawnJumpPuff() {
    for (let i = 0; i < 9; i++) {
      const m = new THREE.Mesh(
        new THREE.SphereGeometry(Math.random() * 0.16 + 0.06, 4, 4),
        new THREE.MeshBasicMaterial({ color:0x99aaff, transparent:true, opacity:0.85 })
      );
      const a = Math.random() * Math.PI * 2, r = Math.random() * 1.2;
      m.position.set(
        _ps.position.x + Math.cos(a) * r,
        _ps.position.y - 1.3,
        _ps.position.z + Math.sin(a) * r
      );
      m.userData.vy = Math.random() * 2.5;
      m.userData.vx = (Math.random() - 0.5) * 3;
      m.userData.vz = (Math.random() - 0.5) * 3;
      scene.add(m);
      _dparts.push({ mesh:m, life:0.5, maxLife:0.5, isPuff:true });
    }
  }

  /* ── COLLISION ───────────────────────────────────────────────────── */
  function _checkCollisions(delta) {
    if (!_ps) return;
    const px   = _ps.position.x;
    const py   = _ps.position.y;
    const pz   = _ps.position.z;
    const feet = py - FOOT;
    const head = py + HEAD;
    let onGround = false, groundPlat = null;

    _platforms.forEach(p => {
      // Skip excluded types
      if (p.type === 'dead') return;
      if (p.type === 'phasing' && !p.visible) return;
      if (p.type === 'memory'  && !p.isSolid) return;

      const hw = p.w / 2, hd = p.d / 2, hh = p.h / 2;
      // AABB horizontal overlap check
      if (px < p.x - hw || px > p.x + hw) return;
      if (pz < p.z - hd || pz > p.z + hd) return;

      const platTop = p.y + hh;
      const platBot = p.y - hh;

      if (!_gravInverted) {
        // Land on top
        if (_velY <= 0 && feet <= platTop + Math.abs(_velY) * delta + 0.32 && feet >= platTop - 0.75) {
          _ps.position.y = platTop + FOOT;
          _velY = 0; onGround = true; groundPlat = p;
          if (p.type === 'win') _triggerWin();
          // Trigger shrink on touch
          const sp = _shrinkPlats.find(s => s.platRef === p);
          if (sp && !sp.touched) sp.touched = true;
        }
        // Head bump
        else if (_velY > 0 && head >= platBot - 0.2 && head <= platBot + 0.32) {
          _velY = -0.08;
        }
      } else {
        // Inverted gravity — land on underside of platforms
        if (_velY >= 0 && head >= platBot - Math.abs(_velY) * delta - 0.32 && head <= platBot + 0.75) {
          _ps.position.y = platBot - HEAD;
          _velY = 0; onGround = true; groundPlat = p;
        }
      }
    });

    // Wall push-out (horizontal AABB separating axis)
    _platforms.forEach(p => {
      if (p.type === 'dead' || (p.type === 'phasing' && !p.visible) || (p.type === 'memory' && !p.isSolid)) return;
      const hw = p.w / 2, hd = p.d / 2, hh = p.h / 2;
      if (feet > p.y + hh || head < p.y - hh) return;
      if (_ps.position.x <= p.x - hw || _ps.position.x >= p.x + hw) return;
      if (_ps.position.z <= p.z - hd || _ps.position.z >= p.z + hd) return;
      if (Math.abs(feet - (p.y + hh)) < 0.55) return; // standing on top — skip
      const oL = _ps.position.x - (p.x - hw), oR = (p.x + hw) - _ps.position.x;
      const oF = _ps.position.z - (p.z - hd), oB = (p.z + hd) - _ps.position.z;
      if (Math.min(oL, oR) < Math.min(oF, oB)) {
        _ps.position.x = oL < oR ? p.x - hw - 0.02 : p.x + hw + 0.02;
      } else {
        _ps.position.z = oF < oB ? p.z - hd - 0.02 : p.z + hd + 0.02;
      }
    });

    // Kill zones — normal _kills array + pendulum kill boxes
    const allKills = [..._kills, ..._pendulums.map(pen => pen.killBox)];
    allKills.forEach(kb => {
      const hw = (kb.w || 1) / 2, hd = (kb.d || 1) / 2, kh = kb.h || 0.5;
      if (px < kb.x - hw || px > kb.x + hw) return;
      if (pz < kb.z - hd || pz > kb.z + hd) return;
      if (py - FOOT < kb.y + kh / 2 + 0.2 && py + 0.5 > kb.y - kh / 2) _killPlayer();
    });

    // Fall off bottom of tower
    if (py < -10) _killPlayer();

    // FIXED: jumpCount resets ONLY when the player is confirmed grounded
    if (onGround) {
      _jumpCount = 0;
      _coyoteT   = COYOTE_TIME;
    }
    _groundPlat = groundPlat;
  }

  /* ── BOOST PADS ──────────────────────────────────────────────────── */
  function _checkBoostPads() {
    if (!_ps) return;
    _boostPads.forEach(bp => {
      const dx = _ps.position.x - bp.x, dz = _ps.position.z - bp.z;
      if (Math.sqrt(dx*dx + dz*dz) < 2.6 && Math.abs(_ps.position.y - FOOT - bp.y) < 1.0) {
        _velY = Math.max(_velY, bp.force * 0.44);
        _dvx *= 1.4; _dvz *= 1.4;
        _showToast('⚡ BOOST!', 0x00ffff, 550);
      }
    });
  }

  /* ── CHECKPOINTS ─────────────────────────────────────────────────── */
  function _checkCheckpoints() {
    if (!_ps) return;
    const px = _ps.position.x, py = _ps.position.y, pz = _ps.position.z;
    _checkpoints.forEach(cp => {
      if (cp.id <= _lastCpId) return;
      const dx = px - cp.x, dz = pz - cp.z, dy = py - cp.y;
      if (Math.sqrt(dx*dx + dz*dz) < 5.5 && Math.abs(dy) < 7) {
        _lastCpId   = cp.id;
        _currentCp  = { x:cp.x, y:cp.y + 1, z:cp.z };
        cp.activated = true;
        cp.meshOuter.material.color.setHex(0x00ff88);
        cp.meshInner.material.color.setHex(0x00ffff);
        document.getElementById('checkpoint-stat').style.display = 'block';
        document.getElementById('cp-num').textContent = cp.id + '/' + _totalCps;
        document.getElementById('obby-cp-display').textContent = cp.id + ' / ' + _totalCps;
        _showToast('✦ CHECKPOINT SAVED', 0xc9a84c, 1800);
        _stageNum = cp.id + 1;
        _updateHUDStage();
      }
    });

    // Animate checkpoint rings (float + spin)
    _decoGroup.traverse(c => {
      if (!c.userData) return;
      if (c.userData.cpRing) {
        c.position.y = c.userData.baseY + Math.sin(gt * 2.5) * 0.22;
        c.rotation.z = gt * 1.5;
        c.material.opacity = 0.65 + Math.sin(gt * 3.2) * 0.2;
      }
      if (c.userData.cpRingInner) {
        c.rotation.z = -gt * 2.2;
        c.material.opacity = 0.32 + Math.sin(gt * 4) * 0.18;
      }
    });
  }

  /* ── DEATH ───────────────────────────────────────────────────────── */
  function _killPlayer() {
    if (_deathCooldown || !_ps) return;
    _deathCooldown = true;
    _deathCount++;
    document.getElementById('death-count').textContent = _deathCount;
    document.getElementById('obby-death-display').textContent = _deathCount;
    document.getElementById('death-flash').style.opacity = '1';
    setTimeout(() => { document.getElementById('death-flash').style.opacity = '0'; }, 250);
    // Always reset gravity on death
    _gravInverted  = false;
    _gravFlipTimer = 0;
    const sp = _currentCp || SPAWN;
    setTimeout(() => {
      _ps.position.set(sp.x, sp.y + 1.5, sp.z);
      _velY = 0; _jumpCount = 0; _dvx = 0; _dvz = 0;
      _coyoteT = 0; _jumpBufT = 0;
      _deathCooldown = false;
    }, 300);
  }

  /* ── WIN ─────────────────────────────────────────────────────────── */
  function _triggerWin() {
    if (hasWon) return;
    hasWon = true; gameRunning = false; _timerActive = false;
    if (document.pointerLockElement) document.exitPointerLock();
    const mins = Math.floor(_runTimer / 60);
    const secs = Math.floor(_runTimer % 60).toString().padStart(2, '0');
    document.getElementById('win-stats').innerHTML =
      `Time: ${mins}:${secs}<br>Deaths: ${_deathCount}<br>Checkpoints: ${_lastCpId} / ${_totalCps}`;
    setTimeout(() => { document.getElementById('win-screen').style.display = 'flex'; }, 800);
  }

  /* ── DASH ────────────────────────────────────────────────────────── */
  function triggerDash() {
    if (_dashCd > 0 || !gameRunning || hasWon) return;
    const th  = (cameraTheta * Math.PI) / 180;
    const fx  = -Math.sin(th), fz = -Math.cos(th), rx = -Math.cos(th), rz = Math.sin(th);
    let ddx = 0, ddz = 0, hasDir = false;
    if (keys['KeyW'] || keys['ArrowUp'])    { ddx += fx; ddz += fz; hasDir = true; }
    if (keys['KeyS'] || keys['ArrowDown'])  { ddx -= fx; ddz -= fz; hasDir = true; }
    if (keys['KeyA'] || keys['ArrowLeft'])  { ddx += rx; ddz += rz; hasDir = true; }
    if (keys['KeyD'] || keys['ArrowRight']) { ddx -= rx; ddz -= rz; hasDir = true; }
    if (isMobile && (Math.abs(touchJoystickX) > 0.15 || Math.abs(touchJoystickY) > 0.15)) {
      ddx += -touchJoystickY * fx - touchJoystickX * rx;
      ddz += -touchJoystickY * fz - touchJoystickX * rz;
      hasDir = true;
    }
    if (!hasDir) { ddx = Math.sin(th); ddz = Math.cos(th); }
    const dl = Math.sqrt(ddx * ddx + ddz * ddz) || 1;
    _dvx = (ddx / dl) * DASH_SPEED;
    _dvz = (ddz / dl) * DASH_SPEED;
    _velY = Math.max(_velY + 0.2, 0.25);
    _jumpCount = Math.max(_jumpCount, 1); // dash counts as leaving ground
    _dashCd  = DASH_CD;
    _fovTarget = DASH_FOV;
    _spawnDashVfx(ddx / dl, ddz / dl);
    document.getElementById('dash-icon').className = 'cooldown';
    const df = document.getElementById('dash-flash');
    df.style.transition = 'opacity 0.05s'; df.style.opacity = '1';
    setTimeout(() => { df.style.transition = 'opacity 0.45s'; df.style.opacity = '0'; }, 65);
  }

  function _spawnDashVfx(dx, dz) {
    if (!_ps) return;
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.55, 0.1, 6, 28),
      new THREE.MeshBasicMaterial({ color:0x99ddff, transparent:true, opacity:0.9, depthWrite:false })
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.copy(_ps.position); ring.position.y -= 1.3;
    scene.add(ring);
    _dparts.push({ mesh:ring, life:0.55, maxLife:0.55, isRing:true });
    for (let g = 0; g < 3; g++) {
      const ghost = new THREE.Sprite(_ps.material.clone());
      ghost.material.transparent = true;
      ghost.material.opacity     = 0.6 - g * 0.15;
      ghost.material.color       = new THREE.Color(0.55 + g * 0.12, 0.78, 1.0);
      ghost.scale.copy(_ps.scale);
      ghost.position.copy(_ps.position);
      ghost.position.x -= dx * (g + 1) * 1.1;
      ghost.position.z -= dz * (g + 1) * 1.1;
      scene.add(ghost);
      _dparts.push({ mesh:ghost, life:0.5 - g * 0.06, maxLife:0.5, isGhost:true, bScale:_ps.scale.clone() });
    }
  }

  function _updateDashParticles(delta) {
    for (let i = _dparts.length - 1; i >= 0; i--) {
      const dp = _dparts[i];
      if (dp.isRing) {
        dp.life -= delta * 2.0;
        dp.mesh.scale.setScalar(1 + (1 - dp.life / dp.maxLife) * 7);
        dp.mesh.material.opacity = Math.max(0, (dp.life / dp.maxLife) * 0.85);
      } else if (dp.isGhost) {
        dp.life -= delta * 2.6;
        const t = Math.max(0, dp.life / dp.maxLife);
        dp.mesh.scale.set(dp.bScale.x * (t * 0.55 + 0.45), dp.bScale.y * (t * 0.55 + 0.45), 1);
        dp.mesh.material.opacity = Math.max(0, t * 0.62);
      } else if (dp.isPuff) {
        dp.life -= delta * 2.5;
        dp.mesh.position.x += dp.mesh.userData.vx * delta;
        dp.mesh.position.z += dp.mesh.userData.vz * delta;
        dp.mesh.position.y += dp.mesh.userData.vy * delta;
        dp.mesh.userData.vy -= 8 * delta;
        dp.mesh.material.opacity = Math.max(0, (dp.life / dp.maxLife) * 0.85);
        dp.mesh.scale.setScalar(Math.max(0.01, dp.life / dp.maxLife));
      } else {
        dp.life -= delta * 3.5;
        dp.mesh.material.opacity = Math.max(0, dp.life);
      }
      if (dp.life <= 0) {
        scene.remove(dp.mesh);
        if (dp.mesh.geometry) dp.mesh.geometry.dispose();
        if (dp.mesh.material) dp.mesh.material.dispose();
        _dparts.splice(i, 1);
      }
    }
  }

  /* ── CAMERA ──────────────────────────────────────────────────────── */
  function _updateCamera(delta) {
    if (!_ps || !camera) return;
    const phi = (cameraPhi  * Math.PI) / 180;
    const thR = (cameraTheta * Math.PI) / 180;
    const tgt = _ps.position;
    const camX = tgt.x + cameraDistance * Math.sin(phi) * Math.sin(thR);
    const camY = tgt.y + cameraDistance * Math.cos(phi);
    const camZ = tgt.z + cameraDistance * Math.sin(phi) * Math.cos(thR);

    const lf = 1.0 - Math.exp(-12 * delta);
    camera.position.x += (camX - camera.position.x) * lf;
    camera.position.y += (camY - camera.position.y) * lf;
    camera.position.z += (camZ - camera.position.z) * lf;
    camera.lookAt(tgt);

    // FOV zoom on dash
    _fovCurrent += (_fovTarget - _fovCurrent) * (1.0 - Math.exp(-15 * delta));
    if (Math.abs(_fovCurrent - camera.fov) > 0.05) {
      camera.fov = _fovCurrent;
      camera.updateProjectionMatrix();
    }
    if (_fovTarget > BASE_FOV && _dashCd < DASH_CD - 0.12) _fovTarget = BASE_FOV;

    _shadow.position.set(tgt.x, tgt.y - 1.55, tgt.z);
    _nametag.position.set(tgt.x, tgt.y + 2.4, tgt.z);
    if (_glow)    { _glow.position.copy(tgt); _glow.material.opacity = 0.14 + Math.sin(gt * 2.5) * 0.05; }
    if (_skyDome) _skyDome.position.copy(tgt);

    // Animate floatStar objects (spawn pad ring, finish orbs, etc.)
    _decoGroup.traverse(c => {
      if (c.userData && c.userData.floatStar) {
        c.position.y = c.userData.baseY + Math.sin(gt * 1.8) * 0.6;
        c.rotation.y = gt * 1.5;
      }
    });
  }

  /* ── AMBIENT PARTICLES ───────────────────────────────────────────── */
  function _updateAmbient() {
    if (!_ps) return;
    const tgt = _ps.position;
    _ambParts.forEach(ap => {
      ap.position.y += Math.sin(gt * ap.userData.floatSpd + ap.userData.floatOff) * 0.003;
      ap.position.x += ap.userData.driftX;
      ap.position.z += ap.userData.driftZ;
      if (Math.abs(ap.position.x - tgt.x) > 55) {
        ap.position.x = tgt.x + (Math.random() - 0.5) * 70;
        ap.position.y = tgt.y + Math.random() * 28 - 5;
      }
      if (Math.abs(ap.position.z - tgt.z) > 55) {
        ap.position.z = tgt.z + (Math.random() - 0.5) * 70;
        ap.position.y = tgt.y + Math.random() * 28 - 5;
      }
    });
  }

  /* ── HUD HELPERS ─────────────────────────────────────────────────── */
  function _updateHUD() {
    document.getElementById('death-count').textContent = '0';
    document.getElementById('obby-death-display').textContent = '0';
    document.getElementById('checkpoint-stat').style.display = 'none';
    document.getElementById('obby-cp-display').textContent = '0 / ' + _totalCps;
    document.getElementById('timer-display').textContent = '0:00';
    document.getElementById('dash-icon').className = 'ready';
    document.getElementById('dash-cooldown-fill').style.height = '0%';
    _updateHUDStage();
  }

  function _updateHUDStage() {
    const el = document.getElementById('stage-pill');
    if (el) el.textContent = 'TITAN TOWER — STAGE ' + _stageNum;
  }

  function _updateHUDHeight() {
    if (!_ps) return;
    const h  = Math.max(0, Math.round(_ps.position.y));
    const el = document.getElementById('height-display');
    if (el) el.textContent = h;
  }

  /* ── TOAST NOTIFICATION ──────────────────────────────────────────── */
  function _showToast(msg, colorHex, dur) {
    const el = document.getElementById('checkpoint-toast');
    if (!el) return;
    el.textContent = msg;
    const r = (colorHex >> 16) & 0xff;
    const g = (colorHex >> 8)  & 0xff;
    const b =  colorHex        & 0xff;
    el.style.background = `rgba(${r},${g},${b},0.88)`;
    el.style.color = '#fff';
    el.style.opacity = '1';
    clearTimeout(el._hideT);
    el._hideT = setTimeout(() => {
      el.style.opacity = '0';
      el.style.background = '';
    }, dur);
  }

  /* ── RESTART ─────────────────────────────────────────────────────── */
  function restart() {
    if (!_ps) return;
    _ps.position.copy(SPAWN);
    _velY=0; _jumpCount=0; _dvx=0; _dvz=0;
    _coyoteT=0; _jumpBufT=0; _dashCd=0;
    _deathCount=0; _runTimer=0; _timerActive=true;
    _deathCooldown=false; _currentCp=null; _lastCpId=-1;
    _gravInverted=false; _gravFlipTimer=0; _stageNum=1;
    cameraTheta=180; cameraPhi=55; cameraDistance=14;

    // Dispose and clear dash/jump VFX
    _dparts.forEach(dp => {
      scene.remove(dp.mesh);
      if (dp.mesh.geometry) dp.mesh.geometry.dispose();
      if (dp.mesh.material) dp.mesh.material.dispose();
    });
    _dparts = [];

    // Reset shrinking platforms to full size
    _shrinkPlats.forEach(sp => {
      sp.touched = false; sp.scaleTimer = 0;
      sp.platRef.mesh.scale.set(1, 1, 1);
      sp.platRef.mesh.visible = true;
      sp.platRef.type = 'shrink';
      sp.platRef.w = sp.platRef.origW;
      sp.platRef.d = sp.platRef.origW;
    });

    // Reset gravity flippers
    _gravFlippers.forEach(gf => { gf.active = false; });

    // Reset checkpoint visuals
    _checkpoints.forEach(cp => {
      if (cp.activated) {
        cp.meshOuter.material.color.setHex(0xffd700);
        cp.meshInner.material.color.setHex(0xffee88);
        cp.activated = false;
      }
    });

    _sprintFactor=0; _wasSpace=false;
    _fovTarget=BASE_FOV; _fovCurrent=BASE_FOV;
    if (camera) { camera.fov = BASE_FOV; camera.updateProjectionMatrix(); }
    hasWon = false; gameRunning = true;
    _updateHUD();
  }

  /* ── UTILITY ─────────────────────────────────────────────────────── */
  function _lighten(hex, amt) {
    return (
      (Math.min(255, ((hex >> 16) & 0xff) + amt) << 16) |
      (Math.min(255, ((hex >>  8) & 0xff) + amt) <<  8) |
       Math.min(255,  (hex        & 0xff) + amt)
    );
  }

  /* ── PUBLIC API ──────────────────────────────────────────────────── */
  return { init, update, restart, triggerDash, cleanup };

})();
