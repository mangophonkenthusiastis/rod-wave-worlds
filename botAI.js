/* ═══════════════════════════════════════════════════════════════════
   botAI.js — Rod Wave Worlds · Advanced Bot AI Module

   Replaces the old updateBotKart.  Called as advancedBotUpdate(k, delta)
   from the main game loop in racing.js.

   Reads globals: raceState, RACE_CONFIG, nearestTrackDistance,
                  useItem, AbilityManager
   ═══════════════════════════════════════════════════════════════════ */

function advancedBotUpdate(k, delta) {
  /* ── Stun: bleed speed, skip all input ──────────────────────────*/
  if (k.stunnedTimer > 0) {
    k.stunnedTimer -= delta;
    k.vel          *= Math.pow(0.3, delta);
    k.engineForce   = 0;
    return;
  }

  const wps    = raceState.waypoints;
  const numWps = wps.length;

  /* ══════════════════════════════════════════════════════════════
     1. APEX-SEEKING NAVIGATION  (shortest-path racing line)
     ══════════════════════════════════════════════════════════════
     Standard waypoint AI aims dead-centre at the next waypoint.
     Real drivers apex corners: they aim slightly toward the inside
     of the turn so they exit faster.

     We compute the apex offset by:
       a) Taking the incoming vector  (bot → nextWp)
       b) Taking the outgoing vector  (nextWp → nextNextWp)
       c) Cross product gives us the turn direction (L/R)
       d) Offset the aim point toward the inside, scaled by corner
          "sharpness" (dot product of normalised in/out vectors)  */

  const wpNext   = wps[k.nextWp];
  const wpAfter  = wps[(k.nextWp + 1) % numWps];

  // Incoming and outgoing direction vectors
  const inX  = wpNext.x  - k.pos.x,  inZ  = wpNext.z  - k.pos.z;
  const outX = wpAfter.x - wpNext.x, outZ = wpAfter.z - wpNext.z;
  const inL  = Math.hypot(inX,  inZ)  || 1;
  const outL = Math.hypot(outX, outZ) || 1;

  // Normalised
  const inNX  = inX  / inL,  inNZ  = inZ  / inL;
  const outNX = outX / outL, outNZ = outZ / outL;

  // Z-component of cross product (inN × outN) → +ve = right turn, -ve = left
  const crossY = inNX * outNZ - inNZ * outNX;

  // Perpendicular pointing toward the inside of the corner
  const iPerpX = crossY >= 0 ?  inNZ : -inNZ;
  const iPerpZ = crossY >= 0 ? -inNX :  inNX;

  // Corner sharpness: 0 = straight, approaches 1 as it nears hairpin
  const dot       = Math.max(-1, Math.min(1, inNX * outNX + inNZ * outNZ));
  const sharpness = Math.max(0, 1.0 - dot) * 0.5;

  // Apex target: up to 7 units toward the inside of the corner
  const apexBias = sharpness * 7.0;
  const aimX = wpNext.x + iPerpX * apexBias + (k.aiTargetOffset || 0);
  const aimZ = wpNext.z + iPerpZ * apexBias;

  // Normalised direction to apex target
  const toAimX  = aimX - k.pos.x, toAimZ  = aimZ - k.pos.z;
  const toAimL  = Math.hypot(toAimX, toAimZ) || 1;
  let dirX = toAimX / toAimL, dirZ = toAimZ / toAimL;

  /* ══════════════════════════════════════════════════════════════
     2. BOOST PAD MAGNETISM
     ══════════════════════════════════════════════════════════════
     If a boost pad lies within 35 units AND is within ~45° of the
     current heading, blend the steering direction 30% toward it.
     Bots actively chase pad lines on straights.                   */
  const fwdX = Math.sin(k.angle), fwdZ = Math.cos(k.angle);
  let bestDot = 0.62;   // cos(~52°) threshold — pad must be roughly ahead

  raceState.boostRamps.forEach(r => {
    const pdX  = r.x - k.pos.x, pdZ  = r.z - k.pos.z;
    const pdL  = Math.hypot(pdX, pdZ);
    if (pdL > 35 || pdL < 0.5) return;
    const dot2 = (pdX / pdL) * fwdX + (pdZ / pdL) * fwdZ;
    if (dot2 > bestDot) {
      bestDot = dot2;
      // Blend 30% toward boost pad, 70% toward apex target
      let bx = dirX * 0.7 + (pdX / pdL) * 0.3;
      let bz = dirZ * 0.7 + (pdZ / pdL) * 0.3;
      const bl = Math.hypot(bx, bz) || 1;
      dirX = bx / bl;  dirZ = bz / bl;
    }
  });

  /* ══════════════════════════════════════════════════════════════
     3. CONTEXT STEERING  (12-direction interest/danger map)
     ══════════════════════════════════════════════════════════════
     Each direction gets an interest score (aligned with apex aim)
     and a danger score (close karts + track edges).
     The best net-score direction becomes the steering target.     */
  const N_DIRS = 12;
  const interest = new Array(N_DIRS).fill(0);
  const danger   = new Array(N_DIRS).fill(0);

  // Slight random variance per bot so they don't all stack up
  if (!k.aiVariance) k.aiVariance = (Math.random() - 0.5) * 0.18;
  // Rotate the target vector by the bot's variance angle
  const cosV = Math.cos(k.aiVariance), sinV = Math.sin(k.aiVariance);
  const varDirX = dirX * cosV - dirZ * sinV;
  const varDirZ = dirX * sinV + dirZ * cosV;

  for (let i = 0; i < N_DIRS; i++) {
    const a   = (i / N_DIRS) * Math.PI * 2;
    const dx  = Math.sin(a), dz = Math.cos(a);
    interest[i] = Math.max(0, dx * varDirX + dz * varDirZ);

    // Danger from nearby karts
    raceState.karts.forEach(other => {
      if (other === k) return;
      const ox = other.pos.x - k.pos.x, oz = other.pos.z - k.pos.z;
      const od = Math.hypot(ox, oz);
      if (od < 10) {
        const w = (10 - od) / 10;
        danger[i] = Math.max(danger[i], (dx * (ox / od) + dz * (oz / od)) * w * 0.85);
      }
    });

    // Danger from track edges (lookahead 8 units)
    const ex = k.pos.x + dx * 8, ez = k.pos.z + dz * 8;
    if (nearestTrackDistance(ex, ez) > RACE_CONFIG.trackWidth / 2 - 2) {
      danger[i] = Math.max(danger[i], 1.0);
    }
  }

  let bestIdx = 0, bestScore = -Infinity;
  for (let i = 0; i < N_DIRS; i++) {
    const s = interest[i] - danger[i];
    if (s > bestScore) { bestScore = s; bestIdx = i; }
  }

  const chosenAng = (bestIdx / N_DIRS) * Math.PI * 2;
  let angleDiff   = chosenAng - k.angle;
  while (angleDiff >  Math.PI) angleDiff -= Math.PI * 2;
  while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
  k.steering = Math.max(-1, Math.min(1, angleDiff * 4));

  /* ══════════════════════════════════════════════════════════════
     4. THROTTLE — ease off in tight corners for realistic lines
     ══════════════════════════════════════════════════════════════ */
  let throttle = 1.0;
  if (Math.abs(k.steering) > 0.50) throttle = 0.84;
  if (Math.abs(k.steering) > 0.78) throttle = 0.66;
  throttle    *= k.aiSkill;
  k.engineForce = RACE_CONFIG.accel * throttle;

  /* ══════════════════════════════════════════════════════════════
     5. CLASSIC ITEM USE  (mushrooms, shells, shield)
     ══════════════════════════════════════════════════════════════ */
  if (k.powerup) {
    const fwd = { x: fwdX, z: fwdZ };
    const straight = varDirX * fwdX + varDirZ * fwdZ;

    if ((k.powerup.includes('mushroom') || k.powerup === 'star') && straight > 0.92) {
      if (Math.random() < 0.04) { useItem(k, k.powerup); k.powerup = null; }
    }
    if (k.powerup === 'shell' || k.powerup === 'blue_shell') {
      const pl = raceState.karts[0];
      const px = pl.pos.x - k.pos.x, pz = pl.pos.z - k.pos.z;
      const pl2 = Math.hypot(px, pz);
      if (pl2 < 40 && (px / pl2) * fwdX + (pz / pl2) * fwdZ > 0.97) {
        useItem(k, k.powerup); k.powerup = null;
      }
    }
    if (k.powerup === 'shield' && !k.shieldTimer) { useItem(k, 'shield'); k.powerup = null; }
  }

  /* ══════════════════════════════════════════════════════════════
     6. ABILITY USE  (new ability system from abilityManager.js)
     ══════════════════════════════════════════════════════════════
     Only activates if AbilityManager is loaded and the bot has
     an ability ready.  BotUseAbility checks conditions itself.   */
  if (k.ability && typeof AbilityManager !== 'undefined') {
    AbilityManager.botUseAbility(k);
  }
}
