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
    new THREE.PlaneGeometry(1200, 1200),
    new THREE.MeshPhongMaterial({ color: 0x3d9142 })
  );
  grass.rotation.x = -Math.PI / 2;
  grass.position.y  = -0.05;
  grass.receiveShadow = true;
  scene.add(grass);

  /* ── Organic Catmull-Rom circuit ─────────────────────────────────
     12 control points producing:
       • A long main straight + fast right-hand sweeper  (0 → 3)
       • Technical infield with a chicane                (4 → 6)
       • Wide left-side hairpin                          (7 → 9)
       • Acceleration return straight                    (10 → 0)
  */
  const anchors = [
    { x:    0, z:    0 },  //  0 — start / finish line
    { x:   85, z:   -8 },  //  1 — run to first braking zone
    { x:  175, z:   35 },  //  2 — entry of long right-hander
    { x:  205, z:  115 },  //  3 — apex of right-hander
    { x:  175, z:  195 },  //  4 — exit, opens into infield
    { x:   95, z:  240 },  //  5 — tight left chicane
    { x:   15, z:  265 },  //  6 — chicane exit
    { x:  -80, z:  245 },  //  7 — right kink
    { x: -155, z:  195 },  //  8 — left hairpin entry
    { x: -195, z:  105 },  //  9 — hairpin apex (tightest corner)
    { x: -155, z:   20 },  // 10 — acceleration zone
    { x:  -75, z:  -18 },  // 11 — back to start
  ];
  raceState.waypoints = anchors;

  /* Centroid tells us which perpendicular side is "outer" at each
     segment.  Outer side → concrete barrier.
     Inner side → thin white line only (karts can cut on grass,
     penalised by offTrackDrag).                                    */
  const centX = anchors.reduce((s, a) => s + a.x, 0) / anchors.length;
  const centZ = anchors.reduce((s, a) => s + a.z, 0) / anchors.length;

  const curvePoints = anchors.map(p => new THREE.Vector3(p.x, 0, p.z));
  const curve = new THREE.CatmullRomCurve3(curvePoints, true, 'catmullrom', 0.5);
  raceState.trackCurve = curve;

  const SEGS = 300;
  const pts  = curve.getPoints(SEGS);

  /* Shared materials — created ONCE here, never inside the loop */
  const matTrack   = new THREE.MeshPhongMaterial({ color: 0x262626, shininess: 10 });
  const matWall    = new THREE.MeshPhongMaterial({ color: 0x939393, shininess: 25 });
  const matKerbRed = new THREE.MeshPhongMaterial({ color: 0xcc1a1a });
  const matKerbWht = new THREE.MeshPhongMaterial({ color: 0xeeeeee });
  const matLine    = new THREE.MeshPhongMaterial({ color: 0xdddddd });

  for (let i = 0; i < pts.length; i++) {
    const p1  = pts[i];
    const p2  = pts[(i + 1) % pts.length];
    const dx  = p2.x - p1.x,  dz  = p2.z - p1.z;
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len < 0.001) continue;

    const angle = Math.atan2(dx, dz);
    const midX  = (p1.x + p2.x) * 0.5;
    const midZ  = (p1.z + p2.z) * 0.5;

    /* ── Track surface ─────────────────────────────────────────── */
    const seg = new THREE.Mesh(
      new THREE.BoxGeometry(RACE_CONFIG.trackWidth + 0.2, 0.2, len + 0.3),
      matTrack
    );
    seg.position.set(midX, 0, midZ);
    seg.rotation.y = angle;
    seg.receiveShadow = true;
    scene.add(seg);
    raceState.trackMeshes.push(seg);

    /* ── Perpendicular vector + outer-side detection ────────────── */
    const perpX = Math.cos(angle);
    const perpZ = -Math.sin(angle);
    const off   = RACE_CONFIG.trackWidth / 2 + 0.4;

    // dot(perp, toCentroid) < 0  →  perp points away from centre = outer
    const outerSide = (perpX * (centX - midX) + perpZ * (centZ - midZ)) < 0 ? 1 : -1;

    /* ── Outer concrete barrier (low-profile) ───────────────────── */
    const wall = new THREE.Mesh(
      new THREE.BoxGeometry(0.85, 1.0, len + 0.4),
      matWall
    );
    wall.position.set(midX + perpX * off * outerSide, 0.5, midZ + perpZ * off * outerSide);
    wall.rotation.y = angle;
    wall.castShadow = true;
    scene.add(wall);

    /* ── Outer red/white kerb — alternates every 5 segments ─────── */
    if (i % 5 === 0) {
      const kMat = (Math.floor(i / 5)) % 2 === 0 ? matKerbRed : matKerbWht;
      const kerb = new THREE.Mesh(
        new THREE.BoxGeometry(1.5, 0.16, len * 5.1),
        kMat
      );
      kerb.position.set(
        midX + perpX * (off - 0.8) * outerSide, 0.04,
        midZ + perpZ * (off - 0.8) * outerSide
      );
      kerb.rotation.y = angle;
      scene.add(kerb);
    }

    /* ── Inner white line — no wall, just a guide ───────────────── */
    if (i % 10 === 0) {
      const line = new THREE.Mesh(
        new THREE.BoxGeometry(0.45, 0.055, len * 10.2),
        matLine
      );
      line.position.set(
        midX + perpX * (off * 0.86) * (-outerSide), 0.02,
        midZ + perpZ * (off * 0.86) * (-outerSide)
      );
      line.rotation.y = angle;
      scene.add(line);
    }

    /* ── Boost pads — 5 evenly distributed around the circuit ───── */
    if (i % 55 === 22) {
      const padMesh = new THREE.Mesh(
        new THREE.PlaneGeometry(RACE_CONFIG.trackWidth * 0.75, 6),
        new THREE.MeshBasicMaterial({
          color: 0x00ffff, transparent: true, opacity: 0.65, side: THREE.DoubleSide
        })
      );
      padMesh.rotation.x = -Math.PI / 2;
      padMesh.rotation.z = -angle;
      padMesh.position.set(midX, 0.16, midZ);
      scene.add(padMesh);
      raceState.boostRamps.push({ x: midX, z: midZ, angle, mesh: padMesh });
    }
  }

  /* ── Start / finish checkerboard ──────────────────────────────── */
  const sfGroup   = new THREE.Group();
  for (let ci = 0; ci < 10; ci++) {
    for (let cj = 0; cj < 2; cj++) {
      const tile = new THREE.Mesh(
        new THREE.BoxGeometry(RACE_CONFIG.trackWidth / 10, 0.25, 1),
        new THREE.MeshPhongMaterial({ color: (ci + cj) % 2 === 0 ? 0x000000 : 0xffffff })
      );
      tile.position.set(
        -RACE_CONFIG.trackWidth / 2 + ci * (RACE_CONFIG.trackWidth / 10) + RACE_CONFIG.trackWidth / 20,
        0.1, -0.5 + cj
      );
      sfGroup.add(tile);
    }
  }
  const startAngle = Math.atan2(anchors[1].x - anchors[0].x, anchors[1].z - anchors[0].z);
  sfGroup.position.set(anchors[0].x, 0.05, anchors[0].z);
  sfGroup.rotation.y = startAngle;
  scene.add(sfGroup);

  /* ── Gantry arch ────────────────────────────────────────────────  */
  const matGantry = new THREE.MeshPhongMaterial({
    color: 0xffcc00, emissive: 0xff9900, emissiveIntensity: 0.2
  });
  const gx = anchors[0].x, gz = anchors[0].z;
  const gpX = Math.cos(startAngle), gpZ = -Math.sin(startAngle);
  for (const side of [-1, 1]) {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 10, 12), matGantry);
    pole.position.set(
      gx + gpX * (RACE_CONFIG.trackWidth / 2 + 2.5) * side, 5,
      gz + gpZ * (RACE_CONFIG.trackWidth / 2 + 2.5) * side
    );
    scene.add(pole);
  }
  const bar = new THREE.Mesh(new THREE.BoxGeometry(RACE_CONFIG.trackWidth + 5, 2.5, 0.5), matGantry);
  bar.position.set(gx, 9, gz);
  bar.rotation.y = startAngle;
  scene.add(bar);
  const lbl = makeTextSprite('ROD WAVE WORLD GP', '#000000');
  lbl.scale.set(14, 2.2, 1);
  lbl.position.set(gx + Math.sin(startAngle) * 0.3, 9, gz + Math.cos(startAngle) * 0.3);
  lbl.rotation.y = startAngle;
  scene.add(lbl);

  /* ── Perimeter trees ────────────────────────────────────────────── */
  for (let i = 0; i < 200; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = 160 + Math.random() * 450;
    spawnTree(Math.cos(a) * r, Math.sin(a) * r);
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
