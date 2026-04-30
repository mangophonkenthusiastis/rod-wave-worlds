/* ═══════════════════════════════════════════════════════════════════
   underground.js — Rod Wave Worlds · Underground Mode Placeholder
   Exposes: loadUndergroundMode()
   ═══════════════════════════════════════════════════════════════════ */

function loadUndergroundMode() {
  if (!scene || typeof THREE === 'undefined') return null;

  const group = new THREE.Group();
  group.name = 'UndergroundMode';

  const baseplate = new THREE.Mesh(
    new THREE.PlaneGeometry(1200, 1200),
    new THREE.MeshStandardMaterial({
      color: 0x000000,
      metalness: 0.9,
      roughness: 0.0
    })
  );
  baseplate.rotation.x = -Math.PI / 2;
  baseplate.receiveShadow = true;
  group.add(baseplate);

  const redLight = new THREE.PointLight(0xff0000, 7, 130, 2.2);
  redLight.position.set(0, 18, -260);
  group.add(redLight);

  const marker = new THREE.Mesh(
    new THREE.SphereGeometry(1.4, 12, 8),
    new THREE.MeshBasicMaterial({ color: 0xff0000, transparent: true, opacity: 0.55 })
  );
  marker.position.copy(redLight.position);
  group.add(marker);

  const flicker = () => {
    if (!group.parent) return;
    const t = Date.now() * 0.006;
    redLight.intensity = 4.5 + Math.sin(t) * 1.7 + Math.random() * 2.2;
    marker.material.opacity = 0.25 + Math.random() * 0.45;
    requestAnimationFrame(flicker);
  };
  flicker();

  scene.add(group);
  return group;
}
