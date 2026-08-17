/**
 * Flight and combat stat blocks for the fleet.
 *
 * Units follow ARCHITECTURE §1.6: metres, kilograms, seconds.
 *   maxSpeed / cruiseSpeed / afterburnSpeed  m/s
 *   accel                                    m/s² (main drive, forward)
 *   pitchRate / yawRate / rollRate           rad/s at full deflection
 *   shields.recharge                         points per second, per bank
 *   guns[].refire                            seconds between shots per emitter
 *   guns[].speed                             projectile m/s (0 = hitscan beam)
 *
 * Balance intent: the Vampire is the agile all-rounder the player learns on; the
 * Panther trades turn rate for durability and punch; the Devastator is slow and
 * shielded and exists to deliver torpedoes; Nephilim craft out-accelerate Confed
 * fighters but have thinner armour and no rear shielding worth the name.
 */

export const STATS = {
  confed_vampire: {
    mass: 14_500, length: 22,
    maxSpeed: 480, cruiseSpeed: 380, afterburnSpeed: 1400,
    accel: 190, afterburnAccel: 520, retroAccel: 130,
    pitchRate: 1.55, yawRate: 1.35, rollRate: 2.90,
    shields: { fore: 950, aft: 950, recharge: 62 },
    armor: { fore: 420, aft: 380, left: 340, right: 340 },
    guns: [
      { type: 'particle', mount: 'wing', damage: 44, refire: 0.26, speed: 1500, range: 3800, energy: 13, color: '#9fd8ff' },
      { type: 'laser', mount: 'chin', damage: 26, refire: 0.18, speed: 1900, range: 3200, energy: 7, color: '#ff9a4a' },
    ],
    missiles: [{ type: 'IR', count: 4 }, { type: 'FF', count: 2 }],
    powerPlant: 640, capacitor: 420, radarRange: 24_000, signature: 1.0,
  },

  confed_panther: {
    mass: 22_800, length: 27.5,
    maxSpeed: 420, cruiseSpeed: 330, afterburnSpeed: 1250,
    accel: 160, afterburnAccel: 430, retroAccel: 110,
    pitchRate: 1.25, yawRate: 1.10, rollRate: 2.35,
    shields: { fore: 1450, aft: 1450, recharge: 74 },
    armor: { fore: 720, aft: 620, left: 560, right: 560 },
    guns: [
      { type: 'ion', mount: 'wing', damage: 62, refire: 0.32, speed: 1350, range: 4200, energy: 19, color: '#7fe4ff' },
      { type: 'particle', mount: 'chin', damage: 44, refire: 0.26, speed: 1500, range: 3800, energy: 13, color: '#9fd8ff' },
    ],
    missiles: [{ type: 'IR', count: 4 }, { type: 'FF', count: 4 }, { type: 'dumbfire', count: 2 }],
    powerPlant: 880, capacitor: 620, radarRange: 26_000, signature: 1.25,
  },

  confed_devastator: {
    mass: 48_000, length: 34,
    maxSpeed: 300, cruiseSpeed: 240, afterburnSpeed: 820,
    accel: 96, afterburnAccel: 240, retroAccel: 70,
    pitchRate: 0.72, yawRate: 0.64, rollRate: 1.25,
    shields: { fore: 2600, aft: 2600, recharge: 96 },
    armor: { fore: 1500, aft: 1300, left: 1150, right: 1150 },
    guns: [
      { type: 'particle', mount: 'chin', damage: 44, refire: 0.28, speed: 1500, range: 3800, energy: 13, color: '#9fd8ff' },
      { type: 'turret', mount: 'dorsal', damage: 30, refire: 0.22, speed: 1700, range: 2800, energy: 8, color: '#ff9a4a' },
    ],
    missiles: [{ type: 'torpedo', count: 4 }, { type: 'FF', count: 4 }],
    powerPlant: 1200, capacitor: 900, radarRange: 30_000, signature: 2.4,
  },

  alien_manta: {
    mass: 11_200, length: 19,
    maxSpeed: 520, cruiseSpeed: 400, afterburnSpeed: 1520,
    accel: 235, afterburnAccel: 600, retroAccel: 150,
    pitchRate: 1.72, yawRate: 1.50, rollRate: 3.20,
    shields: { fore: 720, aft: 480, recharge: 85 },
    armor: { fore: 300, aft: 210, left: 250, right: 250 },
    guns: [
      { type: 'plasma', mount: 'wing', damage: 52, refire: 0.30, speed: 1250, range: 3400, energy: 15, color: '#b8ff4a' },
    ],
    missiles: [{ type: 'bio-seeker', count: 3 }],
    powerPlant: 700, capacitor: 380, radarRange: 21_000, signature: 0.75,
  },

  alien_moray: {
    mass: 31_500, length: 30,
    maxSpeed: 400, cruiseSpeed: 320, afterburnSpeed: 1100,
    accel: 140, afterburnAccel: 360, retroAccel: 95,
    pitchRate: 0.98, yawRate: 0.88, rollRate: 1.85,
    shields: { fore: 1900, aft: 1400, recharge: 110 },
    armor: { fore: 980, aft: 760, left: 820, right: 820 },
    guns: [
      { type: 'plasma', mount: 'wing', damage: 52, refire: 0.28, speed: 1250, range: 3400, energy: 15, color: '#b8ff4a' },
      { type: 'bio-lance', mount: 'nose', damage: 88, refire: 0.55, speed: 980, range: 4600, energy: 30, color: '#d8ff7a' },
    ],
    missiles: [{ type: 'bio-seeker', count: 6 }],
    powerPlant: 1050, capacitor: 780, radarRange: 25_000, signature: 1.9,
  },

  civ_drayman: {
    mass: 2_400_000, length: 172,
    maxSpeed: 160, cruiseSpeed: 120, afterburnSpeed: 200,
    accel: 14, afterburnAccel: 22, retroAccel: 11,
    pitchRate: 0.10, yawRate: 0.09, rollRate: 0.14,
    shields: { fore: 5200, aft: 5200, recharge: 130 },
    armor: { fore: 6400, aft: 6400, left: 5600, right: 5600 },
    guns: [],
    missiles: [],
    turrets: [{ class: 'aa', damage: 24, refire: 0.4, range: 2400 }],
    powerPlant: 3000, capacitor: 1200, radarRange: 40_000, signature: 6.0,
  },

  confed_carrier: {
    mass: 128_000_000, length: 900,
    maxSpeed: 130, cruiseSpeed: 95, afterburnSpeed: 130,
    accel: 5.5, afterburnAccel: 5.5, retroAccel: 4.0,
    pitchRate: 0.030, yawRate: 0.028, rollRate: 0.040,
    shields: { fore: 92_000, aft: 92_000, recharge: 1450 },
    armor: { fore: 74_000, aft: 66_000, left: 60_000, right: 60_000 },
    guns: [],
    missiles: [{ type: 'capship-missile', count: 24 }],
    turrets: [
      { class: 'aa', damage: 34, refire: 0.20, range: 3200 },
      { class: 'antiship', damage: 210, refire: 1.6, range: 9000 },
    ],
    fighterComplement: 72,
    powerPlant: 240_000, capacitor: 40_000, radarRange: 120_000, signature: 40,
  },

  alien_leviathan: {
    mass: 61_000_000, length: 620,
    maxSpeed: 150, cruiseSpeed: 110, afterburnSpeed: 150,
    accel: 7.5, afterburnAccel: 7.5, retroAccel: 5.0,
    pitchRate: 0.042, yawRate: 0.038, rollRate: 0.055,
    shields: { fore: 78_000, aft: 62_000, recharge: 2100 },
    armor: { fore: 52_000, aft: 44_000, left: 47_000, right: 47_000 },
    guns: [],
    missiles: [{ type: 'bio-torpedo', count: 16 }],
    turrets: [
      { class: 'aa', damage: 40, refire: 0.24, range: 3000 },
      { class: 'antiship', damage: 260, refire: 2.1, range: 8200 },
    ],
    fighterComplement: 40,
    powerPlant: 190_000, capacitor: 52_000, radarRange: 100_000, signature: 34,
  },
};

export default STATS;
