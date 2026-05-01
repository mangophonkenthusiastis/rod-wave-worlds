/* ═══════════════════════════════════════════════════════════════════
   underground.js — Rod Wave Worlds · Underground Mode Placeholder
   Exposes: loadUndergroundMode(), updateUndergroundMode(), cleanupUndergroundMode()
   ═══════════════════════════════════════════════════════════════════ */

const UndergroundMode = (function () {
  'use strict';

  const PLAYER_HEIGHT = 2.0;
  const MOVE_SPEED = 14;
  const SPRINT_SPEED = 22;
  const SPRITE_URL_FALLBACK = 'https://i.postimg.cc/6pzzgj5j/39-Rod-Wave-1200x834-2.webp';

  let _group = null;
  let _player = null;
  let _shadow = null;
  let _vel = new THREE.Vector3();
  let _flickerLight = null;
  let _goat = 'Bleood';

  function load(options = {}) {
    cleanup();
    if (!scene || typeof THREE === 'undefined') return null;

    _goat = options.goat || _goat;
    _group = new THREE.Group();
    _group.name = 'UndergroundMode';

    const baseplate = new THREE.Mesh(
      new THREE.PlaneGeometry(1200, 1200),
      new THREE.MeshStandardMaterial({
        color: 0x050505,
        metalness: 0.9,
        roughness: 0.0,
        emissive: 0x180000,
        emissiveIntensity: 0.38
      })
    );
    baseplate.rotation.x = -Math.PI / 2;
    baseplate.receiveShadow = true;
    _group.add(baseplate);

    const grid = new THREE.GridHelper(1200, 80, 0xff1111, 0x440000);
    grid.position.y = 0.035;
    _group.add(grid);

    const stripMat = new THREE.MeshBasicMaterial({ color: 0x880000, transparent: true, opacity: 0.55 });
    for (let i = -5; i <= 5; i++) {
      const strip = new THREE.Mesh(new THREE.BoxGeometry(1200, 0.035, 0.28), stripMat);
      strip.position.set(0, 0.06, i * 42);
      _group.add(strip);
    }

    _flickerLight = new THREE.PointLight(0xff0000, 8, 160, 2.0);
    _flickerLight.position.set(0, 18, -240);
    _group.add(_flickerLight);

    const nearLight = new THREE.PointLight(0x660000, 2.5, 55, 2.5);
    nearLight.position.set(0, 8, 18);
    _group.add(nearLight);

    for (let i = 0; i < 14; i++) {
      const pillar = new THREE.Mesh(
        new THREE.BoxGeometry(3, 18 + Math.random() * 12, 3),
        new THREE.MeshStandardMaterial({ color: 0x060606, roughness: 0.35, metalness: 0.4, emissive: 0x090000 })
      );
      const side = i % 2 === 0 ? -1 : 1;
      pillar.position.set(side * (42 + Math.random() * 22), pillar.geometry.parameters.height * 0.5, -40 - i * 34);
      _group.add(pillar);
    }

    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(1.6, 16, 8),
      new THREE.MeshBasicMaterial({ color: 0xff0000, transparent: true, opacity: 0.7 })
    );
    marker.position.copy(_flickerLight.position);
    _group.add(marker);

    const tex = new THREE.TextureLoader().load(options.spriteUrl || SPRITE_URL_FALLBACK);
    _player = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
    _player.scale.set(2.2, 3.3, 1);
    _player.position.set(0, PLAYER_HEIGHT, 22);
    _group.add(_player);

    const label = _makeTextSprite(_goat, '#f0d080');
    label.scale.set(3.8, 0.8, 1);
    label.position.set(0, 4.1, 0);
    _player.add(label);

    _shadow = new THREE.Mesh(
      new THREE.CircleGeometry(0.75, 18),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.42, depthWrite: false })
    );
    _shadow.rotation.x = -Math.PI / 2;
    _shadow.position.set(0, 0.04, 22);
    _group.add(_shadow);

    scene.add(_group);
    if (camera) {
      camera.position.set(0, 8, 38);
      camera.lookAt(_player.position.x, _player.position.y + 1, _player.position.z);
    }
    return _group;
  }

  function update(delta) {
    if (!_player || !camera) return;

    const yaw = (typeof cameraTheta === 'number' ? cameraTheta : 180) * Math.PI / 180;
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const rx = -Math.cos(yaw), rz = Math.sin(yaw);
    let mx = 0, mz = 0;

    if (keys['KeyW'] || keys['ArrowUp'])    { mx += fx; mz += fz; }
    if (keys['KeyS'] || keys['ArrowDown'])  { mx -= fx; mz -= fz; }
    if (keys['KeyA'] || keys['ArrowLeft'])  { mx -= rx; mz -= rz; }
    if (keys['KeyD'] || keys['ArrowRight']) { mx += rx; mz += rz; }
    if (isMobile && (Math.abs(touchJoystickX) > 0.1 || Math.abs(touchJoystickY) > 0.1)) {
      mx += (-touchJoystickY * fx + touchJoystickX * rx);
      mz += (-touchJoystickY * fz + touchJoystickX * rz);
    }

    const ml = Math.hypot(mx, mz);
    if (ml > 0.05) {
      const speed = (keys['ShiftLeft'] || keys['ShiftRight']) ? SPRINT_SPEED : MOVE_SPEED;
      mx = (mx / ml) * speed;
      mz = (mz / ml) * speed;
    }

    _vel.x += (mx - _vel.x) * Math.min(1, 10 * delta);
    _vel.z += (mz - _vel.z) * Math.min(1, 10 * delta);
    _player.position.x = THREE.MathUtils.clamp(_player.position.x + _vel.x * delta, -560, 560);
    _player.position.z = THREE.MathUtils.clamp(_player.position.z + _vel.z * delta, -560, 560);

    if (_shadow) _shadow.position.set(_player.position.x, 0.04, _player.position.z);

    if (_flickerLight) {
      const t = Date.now() * 0.006;
      _flickerLight.intensity = 5.0 + Math.sin(t) * 1.8 + Math.random() * 2.2;
    }

    const ph = ((typeof cameraPhi === 'number' ? cameraPhi : 55) * Math.PI) / 180;
    const dist = 16;
    const tx = _player.position.x - Math.sin(yaw) * dist * Math.cos(ph);
    const ty = _player.position.y + dist * Math.sin(ph) + 2;
    const tz = _player.position.z - Math.cos(yaw) * dist * Math.cos(ph);
    const sm = 1 - Math.exp(-10 * delta);
    camera.position.x += (tx - camera.position.x) * sm;
    camera.position.y += (ty - camera.position.y) * sm;
    camera.position.z += (tz - camera.position.z) * sm;
    camera.lookAt(_player.position.x, _player.position.y + 1, _player.position.z);
  }

  function cleanup() {
    if (!_group) return;
    if (scene) scene.remove(_group);
    _group.traverse(obj => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose && m.dispose());
        else if (obj.material.dispose) obj.material.dispose();
      }
    });
    _group = null;
    _player = null;
    _shadow = null;
    _flickerLight = null;
    _vel.set(0, 0, 0);
  }

  function _makeTextSprite(text, color) {
    const c = document.createElement('canvas');
    c.width = 512; c.height = 96;
    const ctx = c.getContext('2d');
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.fillRect(0, 0, 512, 96);
    ctx.font = 'bold 48px "Bebas Neue", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = color;
    ctx.fillText(text, 256, 50);
    return new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false }));
  }

  return { load, update, cleanup };
})();

function loadUndergroundMode(options) {
  return UndergroundMode.load(options);
}

function updateUndergroundMode(delta) {
  UndergroundMode.update(delta);
}

function cleanupUndergroundMode() {
  UndergroundMode.cleanup();
}
