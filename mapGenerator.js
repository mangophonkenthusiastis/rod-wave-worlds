/* ═══════════════════════════════════════════════════════════════════
   mapGenerator.js — Rod Wave Worlds · Track Generation Module
   Reads globals  : scene, raceState, RACE_CONFIG
   Writes         : raceState.waypoints, .trackCurve,
                    .trackMeshes, .boostRamps
   ═══════════════════════════════════════════════════════════════════ */

/* ─── TRACK BUILDER ─────────────────────────────────────────────── */
function buildRaceTrack() {

  /* Ground plane */
  const grass = new THREE.Mesh(
    new THREE.PlaneGeometry(1400, 1400),
    new THREE.MeshPhongMaterial({ color: 0x3d9142 })
  );
  grass.rotation.x = -Math.PI / 2;
  grass.position.y  = -0.05;
  grass.receiveShadow = true;
  scene.add(grass);
  raceState.floorRaycastTargets = raceState.floorRaycastTargets || [];
  raceState.floorRaycastTargets.push(grass);
  raceState.watchers = raceState.watchers || [];

  /* ── WAVE CIRCUIT — 16-point Catmull-Rom with elevation ─────────
     Five distinct sections around the loop:

     A  Main straight + T1 right hairpin            (P0  → P4)
     B  Rising elevated chicane  (Y peaks at 5)     (P4  → P8)
     C  High-speed left sweeper, descent             (P8  → P11)
     D  Tight left hairpin                           (P11 → P13)
     E  Return acceleration straight                 (P13 → P0)
  */
  const anchors = [
    { x:    0, y: 0, z:    0 },  //  0 — Start/Finish
    { x:  130, y: 0, z:  -15 },  //  1 — Main straight
    { x:  260, y: 0, z:    8 },  //  2 — Braking zone T1
    { x:  310, y: 0, z:   90 },  //  3 — T1 right hairpin apex
    { x:  270, y: 0, z:  168 },  //  4 — T1 exit / acceleration
    { x:  175, y: 3, z:  240 },  //  5 — Rising into chicane
    { x:   65, y: 5, z:  285 },  //  6 — Hilltop left apex
    { x:  -38, y: 5, z:  300 },  //  7 — Hilltop right (highest point)
    { x: -128, y: 3, z:  275 },  //  8 — Descent begins
    { x: -215, y: 1, z:  215 },  //  9 — Fast left sweeper entry
    { x: -268, y: 0, z:  128 },  // 10 — Sweeper apex
    { x: -278, y: 0, z:   32 },  // 11 — Hairpin approach
    { x: -248, y: 0, z:  -52 },  // 12 — Left hairpin entry
    { x: -178, y: 0, z:  -85 },  // 13 — Hairpin apex (tightest)
    { x:  -92, y: 0, z:  -55 },  // 14 — Hairpin exit, acceleration
    { x:  -38, y: 0, z:  -24 },  // 15 — Return to start
  ];
  raceState.waypoints = anchors;

  /* Centroid for outer-wall detection */
  const centX = anchors.reduce((s, a) => s + a.x, 0) / anchors.length;
  const centZ = anchors.reduce((s, a) => s + a.z, 0) / anchors.length;

  const curvePoints = anchors.map(p => new THREE.Vector3(p.x, p.y, p.z));
  const curve = new THREE.CatmullRomCurve3(curvePoints, true, 'catmullrom', 0.5);
  raceState.trackCurve = curve;

  const SEGS = 360;
  const pts  = curve.getPoints(SEGS);

  /* Section colour theme by horizontal angle + progress around track:
     We label each segment with its section (A–E) by index to pick
     barrier and kerb colours.                                         */
  function _sectionOf(i) {
    const t = i / SEGS;
    if (t < 0.27)  return 'A';  // main straight + T1
    if (t < 0.55)  return 'B';  // elevated chicane
    if (t < 0.72)  return 'C';  // sweeper descent
    if (t < 0.87)  return 'D';  // hairpin
    return 'E';                  // return straight
  }

  /* Shared base materials */
  const matTrack   = new THREE.MeshPhongMaterial({ color: 0x1e1e1e, shininess: 12 });
  const matWall    = new THREE.MeshPhongMaterial({ color: 0x9a9a9a, shininess: 30 });
  const matKerbR   = new THREE.MeshPhongMaterial({ color: 0xcc1a1a });
  const matKerbW   = new THREE.MeshPhongMaterial({ color: 0xeeeeee });
  const matLine    = new THREE.MeshPhongMaterial({ color: 0xdddddd });

  /* Section-specific wall accent colours */
  const SECT_WALL = {
    A: 0x9a9a9a,   // neutral grey — main straight
    B: 0x1a6688,   // steel blue   — elevated chicane
    C: 0x226633,   // dark green   — sweeper
    D: 0x882222,   // deep red     — hairpin
    E: 0x9a9a9a,   // grey         — return
  };

  const TW   = RACE_CONFIG.trackWidth;
  const half = TW / 2;
  const obbyBoxes = _getExistingObbyPlatformBoxes();
  let previousExitGate = null;

  function spawnSegment(i, p1, p2, p3, len3d, angle, pitch) {
    const start = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    if (previousExitGate) {
      previousExitGate.getWorldPosition(start);
      previousExitGate.getWorldQuaternion(quat);
    } else {
      start.copy(p1);
      quat.copy(_segmentQuaternionFromPoints(p1, p2));
    }
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(quat);
    const mid = start.clone().addScaledVector(fwd, len3d * 0.5);
    const seg = new THREE.Mesh(
      new THREE.BoxGeometry(TW + 0.2, 0.22, len3d),
      matTrack
    );
    seg.position.copy(mid);
    seg.quaternion.copy(quat);
    seg.receiveShadow = true;
    seg.updateMatrixWorld(true);
    const segBox = new THREE.Box3().setFromObject(seg);
    const nextQuat = _segmentQuaternionFromPoints(p2, p3);
    const exitGate = new THREE.Object3D();
    exitGate.position.copy(start).addScaledVector(fwd, len3d);
    exitGate.quaternion.copy(nextQuat);
    seg.userData.entryGate = previousExitGate || null;
    seg.userData.exitGate = exitGate;
    previousExitGate = exitGate;
    if (_boxIntersectsAny(segBox, obbyBoxes)) {
      seg.geometry.dispose();
      return null;
    }
    scene.add(seg);
    raceState.trackMeshes.push(seg);
    raceState.floorRaycastTargets.push(seg);
    return { mesh: seg, exitGate };
  }

  for (let i = 0; i < pts.length; i++) {
    const p1  = pts[i];
    const p2  = pts[(i + 1) % pts.length];

    const dx  = p2.x - p1.x, dy = p2.y - p1.y, dz = p2.z - p1.z;
    const len3d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len3d < 0.001) continue;

    /* Horizontal angle (Y rotation) and pitch (X rotation) */
    const angle = Math.atan2(dx, dz);
    const pitch = Math.atan2(-dy, Math.hypot(dx, dz));

    const midX = (p1.x + p2.x) * 0.5;
    const midY = (p1.y + p2.y) * 0.5;
    const midZ = (p1.z + p2.z) * 0.5;

    /* ── Track surface  ── */
    const spawned = spawnSegment(i, p1, p2, pts[(i + 2) % pts.length], len3d, angle, pitch);
    if (!spawned) continue;

    /* ── Perpendicular (horizontal only — walls stay vertical) ── */
    const perpX = Math.cos(angle);
    const perpZ = -Math.sin(angle);
    const off   = half + 0.4;

    /* outer wall side */
    const outerSide = (perpX * (centX - midX) + perpZ * (centZ - midZ)) < 0 ? 1 : -1;

    /* ── Outer concrete barrier with section accent stripe ── */
    const sect = _sectionOf(i);
    const wallMat = matWall; // base material reused
    const wall = new THREE.Mesh(
      new THREE.BoxGeometry(0.85, 1.1, len3d + 0.4),
      wallMat
    );
    wall.position.set(midX + perpX * off * outerSide, midY + 0.55, midZ + perpZ * off * outerSide);
    wall.rotation.y = angle;
    wall.castShadow = true;
    scene.add(wall);

    /* Coloured stripe on top of wall — identifies the section */
    if (i % 3 === 0) {
      const stripe = new THREE.Mesh(
        new THREE.BoxGeometry(0.88, 0.22, len3d * 3.1 + 0.4),
        new THREE.MeshBasicMaterial({ color: SECT_WALL[sect] })
      );
      stripe.position.set(
        midX + perpX * off * outerSide,
        midY + 1.12,
        midZ + perpZ * off * outerSide
      );
      stripe.rotation.y = angle;
      scene.add(stripe);
    }

    /* ── Outer kerb — red/white alternating every 4 segs ── */
    if (i % 4 === 0) {
      const kMat = (Math.floor(i / 4)) % 2 === 0 ? matKerbR : matKerbW;
      const kerb = new THREE.Mesh(
        new THREE.BoxGeometry(1.6, 0.16, len3d * 4.1),
        kMat
      );
      kerb.position.set(
        midX + perpX * (off - 0.9) * outerSide, midY + 0.04,
        midZ + perpZ * (off - 0.9) * outerSide
      );
      kerb.rotation.y = angle;
      scene.add(kerb);
    }

    /* ── Inner white guide line ── */
    if (i % 8 === 0) {
      const line = new THREE.Mesh(
        new THREE.BoxGeometry(0.45, 0.055, len3d * 8.2),
        matLine
      );
      line.position.set(
        midX + perpX * (off * 0.82) * (-outerSide), midY + 0.02,
        midZ + perpZ * (off * 0.82) * (-outerSide)
      );
      line.rotation.y = angle;
      scene.add(line);
    }

    /* ── Boost pads — 6 placed around the circuit ── */
    if (i % 50 === 18) {
      const padMesh = new THREE.Mesh(
        new THREE.PlaneGeometry(TW * 0.7, 5.5),
        new THREE.MeshBasicMaterial({
          color: 0x00ffff, transparent: true, opacity: 0.65, side: THREE.DoubleSide
        })
      );
      padMesh.rotation.x = -Math.PI / 2;
      padMesh.position.set(midX, midY + 0.18, midZ);
      scene.add(padMesh);
      raceState.boostRamps.push({ x: midX, z: midZ, angle, mesh: padMesh });
    }

    if (typeof evilMode !== 'undefined' && evilMode && i % 32 === 11) {
      const side = Math.random() < 0.5 ? 1 : -1;
      _spawnRaceWatcher(
        midX + perpX * (half + 8 + Math.random() * 8) * side,
        midY,
        midZ + perpZ * (half + 8 + Math.random() * 8) * side,
        angle + (side > 0 ? -Math.PI / 2 : Math.PI / 2)
      );
    }
  }

  /* ── Elevated section bridge barriers (decorative arch pillars) ──
     Placed at the chicane entry and exit to frame the hillcrest.     */
  const elevatedPts = [
    { x: 175, y: 3, z: 240 },
    { x: -128, y: 3, z: 275 }
  ];
  const archMat = new THREE.MeshPhongMaterial({ color: 0x1a6688, emissive: 0x0a2233, emissiveIntensity: 0.5 });
  elevatedPts.forEach(ep => {
    for (const sx of [-14, 14]) {
      const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 10, 8), archMat);
      pillar.position.set(ep.x + sx, ep.y + 4, ep.z);
      scene.add(pillar);
    }
    const arch = new THREE.Mesh(new THREE.BoxGeometry(30, 1.2, 0.6), archMat);
    arch.position.set(ep.x, ep.y + 9.2, ep.z);
    scene.add(arch);
    const lbl = makeTextSprite('CHICANE', '#00ccff');
    lbl.scale.set(9, 1.5, 1);
    lbl.position.set(ep.x, ep.y + 10.5, ep.z);
    scene.add(lbl);
  });

  /* ── Start / finish checkerboard ── */
  const sfGroup = new THREE.Group();
  for (let ci = 0; ci < 10; ci++) {
    for (let cj = 0; cj < 2; cj++) {
      const tile = new THREE.Mesh(
        new THREE.BoxGeometry(TW / 10, 0.25, 1),
        new THREE.MeshPhongMaterial({ color: (ci + cj) % 2 === 0 ? 0x000000 : 0xffffff })
      );
      tile.position.set(
        -TW / 2 + ci * (TW / 10) + TW / 20,
        0.1, -0.5 + cj
      );
      sfGroup.add(tile);
    }
  }
  const startAngle = Math.atan2(anchors[1].x - anchors[0].x, anchors[1].z - anchors[0].z);
  sfGroup.position.set(anchors[0].x, 0.05, anchors[0].z);
  sfGroup.rotation.y = startAngle;
  scene.add(sfGroup);

  /* ── Start gantry arch ── */
  const matGantry = new THREE.MeshPhongMaterial({ color: 0xffcc00, emissive: 0xff9900, emissiveIntensity: 0.25 });
  const gx = anchors[0].x, gz = anchors[0].z;
  const gpX = Math.cos(startAngle), gpZ = -Math.sin(startAngle);
  for (const side of [-1, 1]) {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 11, 12), matGantry);
    pole.position.set(gx + gpX * (TW / 2 + 2.5) * side, 5.5, gz + gpZ * (TW / 2 + 2.5) * side);
    scene.add(pole);
  }
  const bar = new THREE.Mesh(new THREE.BoxGeometry(TW + 6, 2.5, 0.55), matGantry);
  bar.position.set(gx, 10.5, gz);
  bar.rotation.y = startAngle;
  scene.add(bar);
  const lbl = makeTextSprite('ROD WAVE WORLD GP', '#000000');
  lbl.scale.set(15, 2.4, 1);
  lbl.position.set(gx + Math.sin(startAngle) * 0.3, 10.5, gz + Math.cos(startAngle) * 0.3);
  lbl.rotation.y = startAngle;
  scene.add(lbl);

  /* ── Section signs on inner wall ── */
  const SECT_LABELS = [
    { z:  160, x:  200, label: 'T1', color: '#ff9900' },
    { z:  285, x:  -40, label: 'CHICANE', color: '#00ccff' },
    { z:  130, x: -268, label: 'SWEEPER', color: '#44ff88' },
    { z:  -70, x: -190, label: 'HAIRPIN', color: '#ff4444' },
  ];
  SECT_LABELS.forEach(sl => {
    const sp = makeTextSprite(sl.label, sl.color);
    sp.scale.set(10, 1.8, 1);
    sp.position.set(sl.x, 4.5, sl.z);
    scene.add(sp);
  });

  /* ── Perimeter trees ── */
  for (let i = 0; i < 220; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = 180 + Math.random() * 500;
    spawnTree(Math.cos(a) * r, Math.sin(a) * r);
  }

  /* ── Grandstand on the main straight ── */
  const standMat = new THREE.MeshPhongMaterial({ color: 0x8888aa });
  for (let row = 0; row < 5; row++) {
    const stand = new THREE.Mesh(
      new THREE.BoxGeometry(80, 1.5 + row * 1.2, 3.5),
      standMat
    );
    stand.position.set(85, row * 1.8 + 1, -22 - row * 3.2);
    scene.add(stand);
  }
}

/* ─── HELPERS ───────────────────────────────────────────────────── */
function spawnTree(x, z) {
  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.3, 0.4, 2, 6),
    new THREE.MeshPhongMaterial({ color: 0x5a3a22 })
  );
  trunk.position.set(x, 1, z);
  scene.add(trunk);
  const leaves = new THREE.Mesh(
    new THREE.ConeGeometry(1.8, 3.5, 7),
    new THREE.MeshPhongMaterial({ color: 0x2c8a3a })
  );
  leaves.position.set(x, 3.5, z);
  leaves.castShadow = true;
  scene.add(leaves);
}

function makeTextSprite(text, color) {
  const c   = document.createElement('canvas');
  c.width   = 512; c.height = 80;
  const ctx = c.getContext('2d');
  ctx.font          = 'bold 52px "Bebas Neue", sans-serif';
  ctx.textAlign     = 'center';
  ctx.textBaseline  = 'middle';
  ctx.fillStyle     = color;
  ctx.fillText(text, 256, 40);
  return new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), transparent: true }));
}

function _segmentQuaternionFromPoints(a, b) {
  const dir = new THREE.Vector3(b.x - a.x, b.y - a.y, b.z - a.z).normalize();
  const quat = new THREE.Quaternion();
  quat.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
  return quat;
}

function _boxIntersectsAny(box, boxes) {
  for (const b of boxes) {
    if (box.intersectsBox(b)) return true;
  }
  return false;
}

function _getExistingObbyPlatformBoxes() {
  if (typeof ObbyManager !== 'undefined' && typeof ObbyManager.getPlatformBoxes === 'function') {
    return ObbyManager.getPlatformBoxes();
  }
  return [];
}

function _spawnRaceWatcher(x, y, z, yaw) {
  const mat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.82, depthWrite: false });
  const group = new THREE.Group();
  const body = new THREE.Mesh(new THREE.ConeGeometry(0.9, 4.2, 5), mat);
  body.position.y = 2.1;
  const head = new THREE.Mesh(new THREE.IcosahedronGeometry(0.55, 0), mat);
  head.position.y = 4.45;
  group.add(body);
  group.add(head);
  group.position.set(x, y, z);
  group.rotation.y = yaw;
  scene.add(group);
  raceState.watchers.push({ group, materials: [mat], opacity: 0.82, dissolving: false });
}

function updateRaceWatchers(delta) {
  if (!raceState || !raceState.watchers || !camera) return;
  for (const w of raceState.watchers) {
    if (!w.group.visible) continue;
    if (!w.dissolving && camera.position.distanceTo(w.group.position) < 15) w.dissolving = true;
    if (w.dissolving) {
      w.opacity += (0 - w.opacity) * Math.min(1, 7 * delta);
      w.materials.forEach(m => { m.opacity = w.opacity; });
      if (w.opacity < 0.02) w.group.visible = false;
    }
  }
}
