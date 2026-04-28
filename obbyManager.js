const ObbyManager = (function () {
  'use strict';

  const COURSE_END_Z = 1000;
  const SECTOR_BREAKS = [200, 400, 600, 850, 1000];
  const BASE_JUMP = 18;
  const DOUBLE_JUMP_BONUS = 12;
  const MOVE_SPEED = 14;
  const GRAVITY = 32;
  const FOOT = 1.0;
  const PLAYER_RADIUS = 0.5;
  const SPAWN = new THREE.Vector3(0, 2, 0);
  const SPAWN_SAFE_RADIUS = 20;

  let _obbyGroup = null;
  let _decoGroup = null;
  let _ps = null;
  let _shadow = null;
  let _nametag = null;
  let _glow = null;

  let _platforms = [];
  let _windZones = [];
  let _conveyors = [];
  let _bouncePads = [];
  let _phasingPlatforms = [];
  let _gravityPads = [];
  let _challengeBoxes = [];
  let _shrinkingPlatforms = [];
  let _rotatingLasers = [];

  let _runTimer = 0;
  let _deathCount = 0;
  let _gt = 0;
  let _timerActive = false;
  let _hasWon = false;
  let _dashCd = 0;

  const _vel = new THREE.Vector3();
  const _constantVelocity = new THREE.Vector3();
  let _jumpCount = 0;
  let _isGrounded = false;
  let _wasSpace = false;

  function init() {
    _resetWorld();
    _buildLinearCourse();
    _createPlayer();
    _runTimer = 0;
    _deathCount = 0;
    _gt = 0;
    _timerActive = true;
    _hasWon = false;
    _updateHUD(0);
  }

  function cleanup() {
    function disposeGroup(group) {
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
    disposeGroup(_obbyGroup);
    disposeGroup(_decoGroup);
    if (_ps) scene.remove(_ps);
    if (_shadow) scene.remove(_shadow);
    if (_nametag) scene.remove(_nametag);
    if (_glow) scene.remove(_glow);
  }

  function restart() {
    cleanup();
    init();
  }

  function triggerDash() {
    if (!_ps || _dashCd > 0) return;
    const yaw = (cameraTheta * Math.PI) / 180;
    _constantVelocity.x += Math.sin(yaw) * 18;
    _constantVelocity.z += Math.cos(yaw) * 18;
    _dashCd = 1.25;
  }

  function update(delta) {
    if (!_ps) return;
    _gt += delta;
    if (_timerActive) _runTimer += delta;
    _updatePhasingPlatforms();
    _updateRotatingLasers(delta);
    _updateShrinkingPlatforms(delta);
    _updatePlayer(delta);
    _updateCamera(delta);
    _updateVisuals();
    _updateHUD(delta);
  }

  function _resetWorld() {
    // Collision audit: remove old groups before spawning.
    if (_obbyGroup) scene.remove(_obbyGroup);
    if (_decoGroup) scene.remove(_decoGroup);

    _platforms = [];
    _windZones = [];
    _conveyors = [];
    _bouncePads = [];
    _phasingPlatforms = [];
    _gravityPads = [];
    _challengeBoxes = [];
    _shrinkingPlatforms = [];
    _rotatingLasers = [];

    _obbyGroup = new THREE.Group();
    _decoGroup = new THREE.Group();
    scene.add(_obbyGroup);
    scene.add(_decoGroup);

    scene.gravity = { y: -9.8 };
    _vel.set(0, 0, 0);
    _constantVelocity.set(0, 0, 0);
    _jumpCount = 0;
    _isGrounded = false;
    _wasSpace = false;
    _dashCd = 0;
  }

  function _buildLinearCourse() {
    const spawn = _mkPlatform(0, 0.5, 0, 14, 1, 14, 0x1d2c3b, 'spawn');
    let prev = spawn;
    let z = 0;

    while (z < COURSE_END_Z - 6) {
      const sector = _sectorFromZ(z);
      const forcedLargeGap = (sector === 4 && Math.random() < 0.28) ? 50 : 0;
      const gap = forcedLargeGap || (8 + Math.random() * 6);
      const nextZ = Math.min(COURSE_END_Z - 8, z + gap);
      const x = (Math.random() - 0.5) * (sector >= 4 ? 20 : 12);
      const y = 0.5 + Math.sin(nextZ * 0.018) * 1.2 + sector * 0.2;
      const p = _createSectorPlatform(sector, x, y, nextZ, prev, gap);
      if (gap > 14) _mkGapAssist(prev, p);
      prev = p;
      z = nextZ;
    }
    _mkPlatform(0, 1, COURSE_END_Z, 18, 2, 18, 0xd4af37, 'finish');
  }

  function _createSectorPlatform(sector, x, y, z, prev, gap) {
    let p;
    if (sector === 1) {
      p = _mkPlatform(x, y, z, 8, 1, 8, 0x45c4ff, 'static');
      if (Math.random() < 0.2) _mkWindElevator(x, y + 1, z, 2.4, 6, 20);
    } else if (sector === 2) {
      if (Math.random() < 0.5) {
        p = _mkPlatform(x, y, z, 8, 1, 8, 0x5f79cf, 'conveyor');
        const sideOrForward = Math.random() < 0.5 ? new THREE.Vector3(0, 0, 1.6) : new THREE.Vector3((Math.random() < 0.5 ? -1 : 1) * 1.3, 0, 0);
        _conveyors.push({ platform: p, velocity: sideOrForward });
      } else {
        p = _mkPlatform(x, y, z, 8, 1, 8, 0x4f6aa2, 'static');
      }
      if (Math.random() < 0.3) _mkBouncePad(x, y + 1.0, z);
    } else if (sector === 3) {
      const type = Math.random() < 0.8 ? 'phasing' : 'static';
      p = _mkPlatform(x, y, z, 7, 1, 7, 0x56bfc8, type);
      if (type === 'phasing') _phasingPlatforms.push({ platform: p });
    } else if (sector === 4) {
      p = _mkPlatform(x, y, z, 9, 1, 9, 0x8969c4, 'static');
      if (gap >= 49) _mkHorizontalWindTunnel((prev.z + z) * 0.5, x, y + 4.8);
      if (Math.random() < 0.2) _mkGravityChallengeBox(x, y + 1, z + 6);
    } else {
      p = _mkPlatform(x, y, z, 6, 1, 6, 0xc26edb, 'shrinking');
      _shrinkingPlatforms.push({ platform: p, active: false, timer: 0 });
      if (Math.random() < 0.28) _mkRotatingLaser(x, y + 1.8, z);
    }
    return p;
  }

  function _mkGapAssist(a, b) {
    const cx = (a.x + b.x) * 0.5;
    const cy = (a.y + b.y) * 0.5 + 1;
    const cz = (a.z + b.z) * 0.5;
    if (_inSpawnSafeZone(cx, cy, cz)) return;
    if (Math.random() < 0.5) _mkWindElevator(cx, cy, cz, 2.2, 5, 20);
    else _mkBouncePad(cx, cy, cz);
  }

  function _mkPlatform(x, y, z, w, h, d, color, type) {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(w, h, d),
      new THREE.MeshPhongMaterial({ color })
    );
    mesh.position.set(x, y, z);
    _resolveOverlap(mesh);
    _obbyGroup.add(mesh);
    const p = { mesh, x: mesh.position.x, y: mesh.position.y, z: mesh.position.z, w, h, d, type, collidable: true };
    _platforms.push(p);
    return p;
  }

  function _resolveOverlap(newMesh) {
    newMesh.updateMatrixWorld(true);
    const newBox = new THREE.Box3().setFromObject(newMesh);
    for (const old of _platforms) {
      old.mesh.updateMatrixWorld(true);
      const oldBox = new THREE.Box3().setFromObject(old.mesh);
      if (newBox.intersectsBox(oldBox)) {
        newMesh.position.x += 10;
        newMesh.updateMatrixWorld(true);
        newBox.setFromObject(newMesh);
      }
    }
  }

  function _mkWindElevator(x, y, z, radius, height, forceY) {
    if (_inSpawnSafeZone(x, y, z)) return;
    const mesh = new THREE.Mesh(
      new THREE.CylinderGeometry(radius, radius, height, 12, 1, true),
      new THREE.MeshBasicMaterial({ color: 0x00c4ff, transparent: true, opacity: 0.2, side: THREE.DoubleSide })
    );
    mesh.position.set(x, y + height * 0.5, z);
    _decoGroup.add(mesh);
    _windZones.push({ x, y: y + height * 0.5, z, w: radius * 2, h: height, d: radius * 2, fx: 0, fy: forceY, fz: 0 });
  }

  function _mkHorizontalWindTunnel(midZ, x, y) {
    if (_inSpawnSafeZone(x, y, midZ)) return;
    const length = 50;
    const mesh = new THREE.Mesh(
      new THREE.CylinderGeometry(4, 4, length, 12, 1, true),
      new THREE.MeshBasicMaterial({ color: 0x73c7ff, transparent: true, opacity: 0.16, side: THREE.DoubleSide })
    );
    mesh.rotation.x = Math.PI * 0.5;
    mesh.position.set(x, y, midZ);
    _decoGroup.add(mesh);
    _windZones.push({ x, y, z: midZ, w: 8, h: 8, d: length, fx: 0, fy: 0, fz: 20 });
  }

  function _mkBouncePad(x, y, z) {
    if (_inSpawnSafeZone(x, y, z)) return;
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(2, 2, 2),
      new THREE.MeshPhongMaterial({ color: 0xffe600, emissive: 0x8c7f00, emissiveIntensity: 0.35 })
    );
    mesh.position.set(x, y, z);
    _decoGroup.add(mesh);
    _bouncePads.push({ x, y, z, size: 2, impulse: 28 });
  }

  function _mkGravityChallengeBox(x, y, z) {
    if (_inSpawnSafeZone(x, y, z)) return;
    const box = new THREE.Mesh(
      new THREE.BoxGeometry(20, 20, 20),
      new THREE.MeshBasicMaterial({ color: 0xff4ddd, wireframe: true, transparent: true, opacity: 0.2 })
    );
    box.position.set(x, y + 10, z);
    _decoGroup.add(box);
    _challengeBoxes.push({ x, y: y + 10, z, w: 20, h: 20, d: 20 });
    _gravityPads.push({ x, y, z, w: 4, h: 1, d: 4 });
    const pad = _mkPlatform(x, y, z, 4, 1, 4, 0xff66ff, 'gravityPad');
    pad.gravityPad = true;
  }

  function _mkRotatingLaser(x, y, z) {
    const pivot = new THREE.Group();
    pivot.position.set(x, y, z);
    _decoGroup.add(pivot);
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.2, 0.2, 16, 10),
      new THREE.MeshBasicMaterial({ color: 0xff3344 })
    );
    beam.rotation.z = Math.PI * 0.5;
    pivot.add(beam);
    _rotatingLasers.push({ pivot, x, y, z, speed: 1.8 + Math.random() * 1.2 });
  }

  function _createPlayer() {
    const tex = new THREE.TextureLoader().load('https://i.postimg.cc/6pzzgj5j/39-Rod-Wave-1200x834-2.webp');
    _ps = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
    _ps.scale.set(2.2, 3.3, 1);
    _ps.position.copy(SPAWN);
    scene.add(_ps);

    _shadow = new THREE.Mesh(new THREE.CircleGeometry(0.7, 14), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.3 }));
    _shadow.rotation.x = -Math.PI / 2;
    scene.add(_shadow);

    _nametag = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0xd0b05f, transparent: true, opacity: 0.5 }));
    _nametag.scale.set(1.8, 0.3, 1);
    scene.add(_nametag);

    _glow = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0xd0b05f, transparent: true, opacity: 0.18 }));
    _glow.scale.set(4.6, 5.3, 1);
    scene.add(_glow);
  }

  function _updatePlayer(delta) {
    const yaw = (cameraTheta * Math.PI) / 180;
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    const rx = -Math.cos(yaw);
    const rz = Math.sin(yaw);

    let moveX = 0;
    let moveZ = 0;
    if (keys['KeyW'] || keys['ArrowUp']) { moveX += fx; moveZ += fz; }
    if (keys['KeyS'] || keys['ArrowDown']) { moveX -= fx; moveZ -= fz; }
    if (keys['KeyA'] || keys['ArrowLeft']) { moveX -= rx; moveZ -= rz; }
    if (keys['KeyD'] || keys['ArrowRight']) { moveX += rx; moveZ += rz; }
    if (isMobile && (Math.abs(touchJoystickX) > 0.1 || Math.abs(touchJoystickY) > 0.1)) {
      moveX += (-touchJoystickY * fx + touchJoystickX * rx);
      moveZ += (-touchJoystickY * fz + touchJoystickX * rz);
    }

    const len = Math.hypot(moveX, moveZ) || 1;
    moveX = (moveX / len) * MOVE_SPEED;
    moveZ = (moveZ / len) * MOVE_SPEED;

    const spaceNow = !!keys['Space'];
    if (spaceNow && !_wasSpace) {
      if (_isGrounded) {
        _vel.y = BASE_JUMP;
        _jumpCount = 1;
        _isGrounded = false;
      } else if (_jumpCount === 1) {
        _vel.y = BASE_JUMP + DOUBLE_JUMP_BONUS;
        _jumpCount = 2;
      }
    }
    _wasSpace = spaceNow;

    _constantVelocity.multiplyScalar(Math.exp(-4 * delta));
    if (_dashCd > 0) _dashCd -= delta;

    _vel.x = moveX + _constantVelocity.x;
    _vel.z = moveZ + _constantVelocity.z;
    const gravitySign = (scene.gravity && scene.gravity.y > 0) ? 1 : -1;
    _vel.y += gravitySign * GRAVITY * delta;

    _ps.position.x += _vel.x * delta;
    _ps.position.z += _vel.z * delta;
    _ps.position.y += _vel.y * delta;

    _isGrounded = false;
    _applyPlatformCollisions();
    _applyWind();
    _applyConveyors();
    _applyBouncePads();
    _applyGravityPads();
    _applyLaserHazards();
    if (_ps.position.y < -20) _respawn();
    if (_ps.position.z >= COURSE_END_Z - 2 && !_hasWon) _triggerWin();
  }

  function _applyPlatformCollisions() {
    const px = _ps.position.x;
    const py = _ps.position.y;
    const pz = _ps.position.z;
    const footY = py - FOOT;
    for (const p of _platforms) {
      if (!p.collidable) continue;
      if (Math.abs(px - p.x) > p.w * 0.5 + PLAYER_RADIUS) continue;
      if (Math.abs(pz - p.z) > p.d * 0.5 + PLAYER_RADIUS) continue;
      const top = p.y + p.h * 0.5;
      if (footY <= top + 0.2 && footY >= top - 1.2 && _vel.y <= 0) {
        _ps.position.y = top + FOOT;
        _vel.y = 0;
        _isGrounded = true;
        if (_jumpCount > 0) _jumpCount = 0;
        if (p.type === 'shrinking') {
          const rec = _shrinkingPlatforms.find(s => s.platform === p);
          if (rec) rec.active = true;
        }
      }
    }
  }

  function _applyWind() {
    for (const w of _windZones) {
      if (Math.abs(_ps.position.x - w.x) < w.w * 0.5 &&
          Math.abs(_ps.position.y - w.y) < w.h * 0.5 &&
          Math.abs(_ps.position.z - w.z) < w.d * 0.5) {
        _ps.position.x += w.fx / 60;
        _ps.position.z += w.fz / 60;
        _vel.y += w.fy / 60;
      }
    }
  }

  function _applyConveyors() {
    for (const c of _conveyors) {
      const p = c.platform;
      if (Math.abs(_ps.position.x - p.x) < p.w * 0.5 &&
          Math.abs((_ps.position.y - FOOT) - (p.y + p.h * 0.5)) < 0.55 &&
          Math.abs(_ps.position.z - p.z) < p.d * 0.5) {
        _constantVelocity.add(c.velocity);
      }
    }
  }

  function _applyBouncePads() {
    for (const b of _bouncePads) {
      if (Math.abs(_ps.position.x - b.x) < b.size &&
          Math.abs(_ps.position.z - b.z) < b.size &&
          Math.abs((_ps.position.y - FOOT) - b.y) < 1.2 &&
          _vel.y <= 0) {
        _vel.y = b.impulse;
      }
    }
  }

  function _applyGravityPads() {
    let inside = false;
    for (const room of _challengeBoxes) {
      if (Math.abs(_ps.position.x - room.x) < room.w * 0.5 &&
          Math.abs(_ps.position.y - room.y) < room.h * 0.5 &&
          Math.abs(_ps.position.z - room.z) < room.d * 0.5) {
        inside = true;
        break;
      }
    }
    if (!inside) {
      scene.gravity.y = -9.8;
      return;
    }
    for (const p of _gravityPads) {
      if (Math.abs(_ps.position.x - p.x) < p.w &&
          Math.abs(_ps.position.z - p.z) < p.d &&
          Math.abs((_ps.position.y - FOOT) - p.y) < 1.1) {
        scene.gravity.y = 9.8;
        return;
      }
    }
    scene.gravity.y = -9.8;
  }

  function _applyLaserHazards() {
    for (const l of _rotatingLasers) {
      if (Math.abs(_ps.position.y - l.y) > 2) continue;
      if (Math.abs(_ps.position.z - l.z) > 9) continue;
      if (Math.abs(_ps.position.x - l.x) > 9) continue;
      _respawn();
      return;
    }
  }

  function _updatePhasingPlatforms() {
    // Global fixed timer: 3s solid, 1s flicker (no collision), 1s invisible.
    const t = ((_gt % 5) + 5) % 5;
    for (const rec of _phasingPlatforms) {
      if (t < 3) {
        rec.platform.collidable = true;
        rec.platform.mesh.visible = true;
        rec.platform.mesh.material.transparent = false;
        rec.platform.mesh.material.opacity = 1;
      } else if (t < 4) {
        rec.platform.collidable = false;
        rec.platform.mesh.visible = true;
        rec.platform.mesh.material.transparent = true;
        rec.platform.mesh.material.opacity = 0.35 + 0.25 * Math.sin(_gt * 24);
      } else {
        rec.platform.collidable = false;
        rec.platform.mesh.visible = false;
      }
    }
  }

  function _updateRotatingLasers(delta) {
    for (const l of _rotatingLasers) l.pivot.rotation.y += l.speed * delta;
  }

  function _updateShrinkingPlatforms(delta) {
    for (const s of _shrinkingPlatforms) {
      if (!s.active) continue;
      s.timer += delta;
      const t = Math.min(1, s.timer / 2);
      const scale = 1 - t;
      s.platform.mesh.scale.set(scale, 1, scale);
      s.platform.collidable = scale > 0.02;
    }
  }

  function _updateCamera(delta) {
    if (!camera) return;
    const th = (cameraTheta * Math.PI) / 180;
    const ph = (typeof cameraPhi === 'number' ? cameraPhi : 55) * Math.PI / 180;
    const dist = 16;
    const tx = _ps.position.x - Math.sin(th) * dist * Math.cos(ph);
    const ty = _ps.position.y + dist * Math.sin(ph) + 2;
    const tz = _ps.position.z - Math.cos(th) * dist * Math.cos(ph);
    const sm = 1 - Math.exp(-10 * delta);
    camera.position.x += (tx - camera.position.x) * sm;
    camera.position.y += (ty - camera.position.y) * sm;
    camera.position.z += (tz - camera.position.z) * sm;
    camera.lookAt(_ps.position.x, _ps.position.y + 1, _ps.position.z);
  }

  function _updateVisuals() {
    if (_shadow) _shadow.position.set(_ps.position.x, _ps.position.y - FOOT + 0.05, _ps.position.z);
    if (_nametag) _nametag.position.set(_ps.position.x, _ps.position.y + 2.2, _ps.position.z);
    if (_glow) _glow.position.copy(_ps.position);
  }

  function _updateHUD() {
    const timer = document.getElementById('timer-display');
    if (timer) {
      const mins = Math.floor(_runTimer / 60);
      const secs = Math.floor(_runTimer % 60).toString().padStart(2, '0');
      timer.textContent = `${mins}:${secs}`;
    }
    const sector = document.getElementById('sector-display');
    if (sector) sector.textContent = `${_sectorFromZ(_ps.position.z)}`;
    const deaths = document.getElementById('obby-death-display');
    if (deaths) deaths.textContent = `${_deathCount}`;
    const distance = document.getElementById('distance-display');
    if (distance) distance.textContent = `${Math.max(0, Math.round(COURSE_END_Z - _ps.position.z))}`;
    const stage = document.getElementById('stage-pill');
    if (stage) stage.textContent = 'LINEAR OBBY 1000M';
  }

  function _respawn() {
    _deathCount += 1;
    _ps.position.copy(SPAWN);
    _vel.set(0, 0, 0);
    _constantVelocity.set(0, 0, 0);
    _jumpCount = 0;
    _isGrounded = false;
    scene.gravity.y = -9.8;
  }

  function _triggerWin() {
    _hasWon = true;
    _timerActive = false;
    const toast = document.getElementById('checkpoint-toast');
    if (toast) {
      toast.textContent = 'FINISH REACHED';
      toast.style.opacity = '1';
    }
    setTimeout(() => {
      if (typeof backToMenu === 'function') backToMenu();
    }, 2200);
  }

  function _sectorFromZ(z) {
    if (z < SECTOR_BREAKS[0]) return 1;
    if (z < SECTOR_BREAKS[1]) return 2;
    if (z < SECTOR_BREAKS[2]) return 3;
    if (z < SECTOR_BREAKS[3]) return 4;
    return 5;
  }

  function _inSpawnSafeZone(x, y, z) {
    return Math.sqrt(x * x + y * y + z * z) < SPAWN_SAFE_RADIUS;
  }

  return { init, cleanup, restart, update, triggerDash };
})();
