/* ═══════════════════════════════════════════════════════════════════
   abilityManager.js — Rod Wave Worlds · Unique Abilities System

   5 special abilities, each with a distinct mechanical effect:
   ─────────────────────────────────────────────────────────────────
   ⚡ STATIC LINK   Tether to nearest kart ahead; drain their speed
                    and feed it to you.  Duration: 3 s.
   🌀 GRAVITY WELL  Drop a vortex that pulls nearby karts toward its
                    centre (inverse-square force).  Duration: 4 s.
   👻 PHASE SHIFT   Semi-transparent; wall collisions disabled. 3 s.
   🔴 OVERCLOCK     2× top speed, steering 50% more sensitive. 4 s.
   🟦 DECOY PAD     Drop a fake boost pad that stuns on contact.

   Public API:
     AbilityManager.init(raceState)
     AbilityManager.update(delta)
     AbilityManager.usePlayerAbility()
     AbilityManager.botUseAbility(k)
     AbilityManager.isPhaseActive(k)      ← queried by updateKartPhysics
     AbilityManager.tickPhaseShift(k, dt) ← called by updateKartPhysics
     AbilityManager.tickOverclock(k, dt)  ← called by updateKartPhysics
     AbilityManager.getOverclockTopSpeed(k, base)  ← multiplies topSpeed
     AbilityManager.getOverclockTurnMul(k)         ← multiplies turnRate
     AbilityManager.cleanup()
   ═══════════════════════════════════════════════════════════════════ */

/* Ability metadata (icon shown in HUD, label, cooldown seconds) */
const ABILITY_DEFS = {
  static_link:  { icon: '⚡', label: 'STATIC LINK',  cooldown: 18, color: 0xffee44 },
  gravity_well: { icon: '🌀', label: 'GRAVITY WELL', cooldown: 22, color: 0xaa44ff },
  phase_shift:  { icon: '👻', label: 'PHASE SHIFT',  cooldown: 15, color: 0x44ffdd },
  overclock:    { icon: '🔴', label: 'OVERCLOCK',    cooldown: 20, color: 0xff4400 },
  decoy_pad:    { icon: '🟦', label: 'DECOY PAD',    cooldown: 14, color: 0x0088ff },
};
const ABILITY_KEYS = Object.keys(ABILITY_DEFS);

const AbilityManager = (function () {

  /* ─── Module-private state ───────────────────────────────────── */
  let _rs          = null;
  let _boxes       = [];   // AbilityBox instances
  let _links       = [];   // active Static Link effects
  let _wells       = [];   // active Gravity Well effects
  let _decoys      = [];   // live Decoy Pad meshes

  /* ════════════════════════════════════════════════════════════════
     ABILITY PICKUP BOX
  ════════════════════════════════════════════════════════════════ */
  class AbilityBox {
    constructor(x, z) {
      this.x = x; this.z = z;
      this.active       = true;
      this.respawnTimer = 0;
      this.mesh         = _makeBoxMesh();
      this.mesh.position.set(x, 1.5, z);
      scene.add(this.mesh);
    }

    update(dt) {
      if (!this.active) {
        this.respawnTimer -= dt;
        if (this.respawnTimer <= 0) { this.active = true; this.mesh.visible = true; }
        return;
      }
      this.mesh.rotation.y += dt * 1.9;
      this.mesh.rotation.x += dt * 0.7;
      this.mesh.position.y  = 1.5 + Math.sin(performance.now() * 0.003 + this.x * 0.1) * 0.22;
    }
  }

  function _makeBoxMesh() {
    const g = new THREE.Group();

    // Octahedron core — visually distinct from yellow item boxes
    const core = new THREE.Mesh(
      new THREE.OctahedronGeometry(1.1, 0),
      new THREE.MeshPhongMaterial({
        color: 0xcc44ff, emissive: 0x8800cc, emissiveIntensity: 0.85,
        transparent: true, opacity: 0.92, shininess: 180
      })
    );
    g.add(core);

    // Outer spinning torus ring
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(1.55, 0.1, 8, 28),
      new THREE.MeshBasicMaterial({ color: 0xee88ff, transparent: true, opacity: 0.55 })
    );
    ring.rotation.x = Math.PI / 2;
    g.add(ring);

    return g;
  }

  /* ════════════════════════════════════════════════════════════════
     VISUAL HELPERS — tether, gravity rings, decoy pad
  ════════════════════════════════════════════════════════════════ */

  /** Creates a dynamic Line mesh for the Static Link tether */
  function _makeTether() {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    const mat = new THREE.LineBasicMaterial({
      color: 0xffee44, linewidth: 2, transparent: true, opacity: 0.85
    });
    return new THREE.Line(geo, mat);
  }

  function _updateTether(link) {
    const pos = link.tether.geometry.attributes.position;
    pos.setXYZ(0, link.source.pos.x, link.source.pos.y + 1.5, link.source.pos.z);
    pos.setXYZ(1, link.target.pos.x, link.target.pos.y + 1.5, link.target.pos.z);
    pos.needsUpdate = true;
  }

  /** Creates the 3-ring vortex visual for a Gravity Well */
  function _makeWellMesh(x, z) {
    const g = new THREE.Group();
    g.position.set(x, 0.3, z);
    for (let i = 0; i < 3; i++) {
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(4 + i * 3, 0.28, 8, 32),
        new THREE.MeshBasicMaterial({
          color: 0xaa44ff, transparent: true, opacity: 0.55 - i * 0.13
        })
      );
      ring.rotation.x = Math.PI / 2;
      ring._spin = 1.6 + i * 0.7;   // private per-ring spin rate
      g.add(ring);
    }
    scene.add(g);
    return g;
  }

  /** Creates the fake (blue) boost pad mesh for a Decoy Pad */
  function _makeDecoyMesh(x, z) {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(RACE_CONFIG.trackWidth * 0.75, 5),
      new THREE.MeshBasicMaterial({
        color: 0x0055ff, transparent: true, opacity: 0.7, side: THREE.DoubleSide
      })
    );
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, 0.18, z);
    scene.add(m);
    return m;
  }

  /* ════════════════════════════════════════════════════════════════
     HUD UPDATE
  ════════════════════════════════════════════════════════════════ */
  function _hud(k) {
    const slot = document.getElementById('ability-slot');
    const icon = document.getElementById('ability-icon');
    const bar  = document.getElementById('ability-cooldown-bar');
    const lbl  = document.getElementById('ability-label');
    if (!slot) return;

    if (k.ability) {
      const def = ABILITY_DEFS[k.ability];
      icon.textContent = def ? def.icon : '?';
      lbl.textContent  = def ? def.label : k.ability;
      slot.classList.add('has-ability');
    } else {
      icon.textContent = '—';
      lbl.textContent  = 'ABILITY [E]';
      slot.classList.remove('has-ability');
    }

    /* Cooldown bar: scaleX 0 (full cooldown) → 1 (ready) */
    const cd    = k.abilityCooldown || 0;
    const maxCd = k._lastAbilityCooldown || 1;
    const pct   = cd > 0 ? Math.max(0, 1 - cd / maxCd) : 1;
    if (bar) bar.style.transform = `scaleX(${pct.toFixed(3)})`;
  }

  /* ════════════════════════════════════════════════════════════════
     CORE ACTIVATION LOGIC  (shared by player + bots)
  ════════════════════════════════════════════════════════════════ */
  function _activate(k) {
    const id  = k.ability;
    const def = ABILITY_DEFS[id];
    if (!def) return;

    k._lastAbilityCooldown = def.cooldown;
    k.abilityCooldown      = def.cooldown;
    k.ability              = null;   // consumed on use

    if (k.isPlayer) {
      showRaceMsg(def.icon + ' ' + def.label + '!');
      _hud(k);
    }

    switch (id) {

      /* ── ⚡ STATIC LINK ──────────────────────────────────────── */
      case 'static_link': {
        /* Find nearest kart AHEAD on the track (higher progress).
           Fall back to closest kart overall if none is ahead.      */
        let target = null, best = Infinity;
        _rs.karts.forEach(other => {
          if (other === k || other.finished) return;
          const d = Math.hypot(other.pos.x - k.pos.x, other.pos.z - k.pos.z);
          const ahead = other.progress > k.progress;
          if (d < 55 && d < best && ahead) { best = d; target = other; }
        });
        if (!target) {
          _rs.karts.forEach(other => {
            if (other === k || other.finished) return;
            const d = Math.hypot(other.pos.x - k.pos.x, other.pos.z - k.pos.z);
            if (d < best) { best = d; target = other; }
          });
        }
        if (target) {
          const tether = _makeTether();
          scene.add(tether);
          _links.push({ source: k, target, timer: 3.0, tether });
        }
        break;
      }

      /* ── 🌀 GRAVITY WELL ────────────────────────────────────── */
      case 'gravity_well': {
        const mesh = _makeWellMesh(k.pos.x, k.pos.z);
        _wells.push({ x: k.pos.x, z: k.pos.z, timer: 4.0, mesh });
        break;
      }

      /* ── 👻 PHASE SHIFT ─────────────────────────────────────── */
      case 'phase_shift': {
        k.phaseShift = 3.0;
        /* Make kart semi-transparent */
        k.mesh.traverse(child => {
          if (child.isMesh && child.material) {
            child.material             = child.material.clone();
            child.material.transparent = true;
            child.material.opacity     = 0.32;
          }
        });
        /* Cyan wireframe glow */
        const glow = new THREE.Mesh(
          new THREE.SphereGeometry(2.5, 12, 10),
          new THREE.MeshBasicMaterial({
            color: 0x44ffdd, transparent: true, opacity: 0.2, wireframe: true
          })
        );
        k.mesh.add(glow);
        k._phaseGlow = glow;
        break;
      }

      /* ── 🔴 OVERCLOCK ───────────────────────────────────────── */
      case 'overclock': {
        k.overclock = 4.0;
        /* Burst of red particles from exhaust */
        if (typeof spawnParticle === 'function') {
          for (let i = 0; i < 10; i++) {
            spawnParticle(
              k.pos.x - Math.sin(k.angle) * 2 + (Math.random() - 0.5) * 3,
              0.5 + Math.random() * 0.5,
              k.pos.z - Math.cos(k.angle) * 2 + (Math.random() - 0.5) * 3,
              0xff4400, 0.7
            );
          }
        }
        break;
      }

      /* ── 🟦 DECOY PAD ───────────────────────────────────────── */
      case 'decoy_pad': {
        const mesh = _makeDecoyMesh(k.pos.x, k.pos.z);
        _decoys.push({ x: k.pos.x, z: k.pos.z, mesh, active: true, owner: k });
        break;
      }
    }
  }

  /* ════════════════════════════════════════════════════════════════
     PUBLIC API
  ════════════════════════════════════════════════════════════════ */
  return {

    /* ── init: call once from initRace(), after spawnRaceItemBoxes */
    init(rs) {
      _rs      = rs;
      _boxes   = [];
      _links   = [];
      _wells   = [];
      _decoys  = [];

      /* Seed every kart with empty ability state */
      rs.karts.forEach(k => {
        if (k.ability         === undefined) k.ability         = null;
        if (k.abilityCooldown === undefined) k.abilityCooldown = 0;
        if (k.phaseShift      === undefined) k.phaseShift      = 0;
        if (k.overclock       === undefined) k.overclock       = 0;
      });

      /* Place 5 ability boxes staggered around the track */
      const curve   = rs.trackCurve;
      if (!curve) return;
      const offsets = [0.08, 0.24, 0.42, 0.60, 0.78];
      offsets.forEach((t, i) => {
        const pt  = curve.getPointAt(t);
        const tan = curve.getTangentAt(t);
        const ang = Math.atan2(tan.x, tan.z);
        const px  = Math.cos(ang), pz = -Math.sin(ang);
        const side = (i % 2 === 0 ? 1 : -1) * 5.5;
        _boxes.push(new AbilityBox(pt.x + px * side, pt.z + pz * side));
      });
    },

    /* ── update: call every frame from animateRace()  ─────────── */
    update(delta) {
      if (!_rs) return;

      /* ── Ability box pickup ───────────────────────────────────── */
      _boxes.forEach(box => {
        box.update(delta);
        if (!box.active) return;
        _rs.karts.forEach(k => {
          if (k.finished) return;
          if (Math.hypot(k.pos.x - box.x, k.pos.z - box.z) < 3.2) {
            box.active        = false;
            box.mesh.visible  = false;
            box.respawnTimer  = 20;
            if (!k.ability) {
              k.ability = ABILITY_KEYS[Math.floor(Math.random() * ABILITY_KEYS.length)];
              if (k.isPlayer) {
                _hud(k);
                if (typeof showRaceMsg === 'function')
                  showRaceMsg('⚡ ' + ABILITY_DEFS[k.ability].label + ' READY!');
              }
            }
          }
        });
      });

      /* ── Tick cooldowns for every kart ───────────────────────── */
      _rs.karts.forEach(k => {
        if (k.abilityCooldown > 0)
          k.abilityCooldown = Math.max(0, k.abilityCooldown - delta);
      });

      /* ── ACTIVE: Static Link ─────────────────────────────────── */
      for (let i = _links.length - 1; i >= 0; i--) {
        const lnk = _links[i];
        lnk.timer -= delta;
        if (lnk.timer <= 0 || !lnk.target || lnk.target.finished) {
          scene.remove(lnk.tether);
          _links.splice(i, 1);
          continue;
        }
        _updateTether(lnk);
        /* Drain target speed → feed source */
        const drain = 14 * delta;
        lnk.target.speed = Math.max(0, lnk.target.speed - drain);
        lnk.source.speed = Math.min(
          RACE_CONFIG.maxSpeed * 1.3,
          lnk.source.speed + drain * 0.6
        );
        /* Pulse the tether opacity */
        lnk.tether.material.opacity = 0.45 + Math.abs(Math.sin(performance.now() * 0.008)) * 0.45;
      }

      /* ── ACTIVE: Gravity Well ────────────────────────────────── */
      for (let i = _wells.length - 1; i >= 0; i--) {
        const gw = _wells[i];
        gw.timer -= delta;
        if (gw.timer <= 0) {
          scene.remove(gw.mesh);
          _wells.splice(i, 1);
          continue;
        }
        /* Spin rings */
        gw.mesh.children.forEach(ring => {
          ring.rotation.z += ring._spin * delta;
        });
        /* Inverse-square pull on all karts within radius 20 */
        _rs.karts.forEach(k => {
          if (k.finished) return;
          const dx   = gw.x - k.pos.x, dz = gw.z - k.pos.z;
          const dst2 = dx * dx + dz * dz;
          if (dst2 < 1 || dst2 > 400) return;          // 20² = 400
          const dst   = Math.sqrt(dst2);
          const force = Math.min(28, 200 / dst2);       // capped pull force
          k.vx += (dx / dst) * force * delta;
          k.vz += (dz / dst) * force * delta;
        });
      }

      /* ── ACTIVE: Decoy Pads ──────────────────────────────────── */
      for (let i = _decoys.length - 1; i >= 0; i--) {
        const dp = _decoys[i];
        if (!dp.active) continue;
        _rs.karts.forEach(k => {
          if (k === dp.owner || k.finished) return;
          if (Math.hypot(k.pos.x - dp.x, k.pos.z - dp.z) < 4.0) {
            /* Stun — no boost */
            k.stunnedTimer    = 2.2;
            k.spinVisualTimer = 1.8;
            if (k.isPlayer && typeof showRaceMsg === 'function')
              showRaceMsg('💥 DECOY!');
            dp.active       = false;
            scene.remove(dp.mesh);
            _decoys.splice(i, 1);
          }
        });
      }

      /* ── Refresh player HUD every frame ─────────────────────── */
      const player = _rs.karts[0];
      if (player) _hud(player);
    },

    /* ── usePlayerAbility: bound to 'E' key in raceKeyDown ─────── */
    usePlayerAbility() {
      if (!_rs || _rs.finished) return;
      const k = _rs.karts[0];
      if (!k || k.finished || !k.ability) return;
      if (k.abilityCooldown > 0) {
        if (typeof showRaceMsg === 'function') showRaceMsg('⏳ COOLING DOWN...');
        return;
      }
      _activate(k);
    },

    /* ── botUseAbility: called from advancedBotUpdate ──────────── */
    botUseAbility(k) {
      if (!k.ability || k.abilityCooldown > 0) return;
      const player = _rs ? _rs.karts[0] : null;
      const dist   = player
        ? Math.hypot(k.pos.x - player.pos.x, k.pos.z - player.pos.z)
        : Infinity;

      let fire = false;
      switch (k.ability) {
        case 'static_link':  fire = dist < 22 && Math.random() < 0.03;  break;
        case 'gravity_well': fire = dist < 28 && Math.random() < 0.02;  break;
        case 'phase_shift':  fire = k.position <= 3 && Math.random() < 0.015; break;
        case 'overclock':    fire = k.position <= 4 && Math.random() < 0.012; break;
        case 'decoy_pad':    fire = k.position >= 3 && Math.random() < 0.02;  break;
      }
      if (fire) _activate(k);
    },

    /* ── Physics hooks  (called per-kart inside updateKartPhysics) */

    /** Returns true while Phase Shift is active — physics skips wall collision */
    isPhaseActive(k) {
      return !!(k.phaseShift && k.phaseShift > 0);
    },

    /** Tick Phase Shift timer; restore opacity when it expires */
    tickPhaseShift(k, delta) {
      if (!k.phaseShift || k.phaseShift <= 0) return;
      k.phaseShift -= delta;
      if (k.phaseShift <= 0) {
        k.phaseShift = 0;
        k.mesh.traverse(child => {
          if (child.isMesh && child.material && child.material.transparent) {
            child.material.opacity = 1.0;
            child.material.transparent = false;
          }
        });
        if (k._phaseGlow) { k.mesh.remove(k._phaseGlow); k._phaseGlow = null; }
      }
    },

    /** Tick Overclock timer */
    tickOverclock(k, delta) {
      if (k.overclock > 0) k.overclock = Math.max(0, k.overclock - delta);
    },

    /** Returns modified topSpeed (2× while Overclocked) */
    getOverclockTopSpeed(k, base) {
      return (k.overclock > 0) ? base * 2.0 : base;
    },

    /** Returns turn-rate multiplier (1.5× while Overclocked = slippery) */
    getOverclockTurnMul(k) {
      return (k.overclock > 0) ? 1.5 : 1.0;
    },

    /* ── cleanup: call from restartRace() before initRace() ─────── */
    cleanup() {
      _links.forEach(l => scene.remove(l.tether));
      _wells.forEach(g => scene.remove(g.mesh));
      _decoys.forEach(d => scene.remove(d.mesh));
      _boxes.forEach(b => scene.remove(b.mesh));
      _links  = [];
      _wells  = [];
      _decoys = [];
      _boxes  = [];
      _rs     = null;
    },
  };

})();
