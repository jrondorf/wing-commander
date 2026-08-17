/**
 * src/ai/chatter.js — the radio.
 *
 * Wing Commander lives or dies on this. A silent dogfight is a screensaver; the
 * same dogfight with someone screaming "I'm hit, I'm hit!" is a story. Every line
 * goes out as a `comms:message` event so ui/ can subtitle it and audio/ can
 * synthesise a voice:
 *
 *   engine.events.emit('comms:message', {
 *     from, text, tone, ship, faction, priority, kind, target
 *   })
 *
 * `tone` is the delivery hint for audio: calm | urgent | panic | smug | angry |
 * pain | grim | wry. `priority` 0..3 lets the UI drop banter when the channel is
 * busy with orders.
 *
 * The Radio enforces two budgets so this never becomes noise:
 *   - per-pilot cooldown per line kind
 *   - a squadron-wide channel budget (one voice at a time, roughly)
 */
import { hash01, clamp01 } from './aimath.js';

/**
 * Lines are keyed `kind` → temperament → variants. `*` is the fallback bucket.
 * `%t` is substituted with the target's callsign/name, `%w` with a wingman's.
 */
const LINES = {
  engage: {
    aggressive: ["Tally one, I'm taking him.", "He's mine. Stay off him.", 'Engaging. This will not take long.'],
    cautious: ['Contact, bearing on my nose. Moving in.', "I have him. Watch my six, will you?", 'Committing. Slowly.'],
    reckless: ["Oh, you're going to hate this.", 'Here we go! Hahaha!', "Come on then, let's dance."],
    disciplined: ['Tally one, engaging.', 'Contact acquired, breaking to engage.', 'Committing on the lead ship.'],
    '*': ['Engaging.', 'Tally, moving in.'],
  },
  attackRun: {
    aggressive: ['Guns hot.', "In the saddle, he can't shake me."],
    cautious: ['In position. Taking the shot.', 'Tracking... steady...'],
    reckless: ['Say goodnight!', "You're already dead, you just don't know it."],
    disciplined: ['In the saddle, guns hot.', 'Solution good. Firing.'],
    '*': ['Guns hot.'],
  },
  kill: {
    aggressive: ['Splash one. Next.', 'Scratch one bandit.', 'That is how it is done.'],
    cautious: ['Splash one. That was closer than I liked.', 'He is gone. Keep your eyes out.'],
    reckless: ["Hahaha! Did you see that?!", 'Scratch one! Who wants seconds?', 'Boom. Beautiful.'],
    disciplined: ['Splash one, confirmed.', 'Target destroyed. Re-engaging.'],
    '*': ['Splash one.'],
  },
  killByAlien: {
    '*': ['Your hull sings as it opens.', 'One more for the chorus.', 'Meat and metal. The same in the end.'],
  },
  nearMiss: {
    aggressive: ['Missed, you blind idiot!', 'Close. Not close enough.'],
    cautious: ['That was close! Too close!', "He nearly had me there."],
    reckless: ['Ha! Try again!', 'You are going to have to do better!'],
    disciplined: ['Rounds close aboard. Breaking.', 'Tracers close. Repositioning.'],
    '*': ['That was close.'],
  },
  hit: {
    aggressive: ['I am hit! Not enough to stop me!', 'He tagged me. He will regret it.'],
    cautious: ['I am taking fire! Somebody help!', "I'm hit! Shields are going!"],
    reckless: ['Is that all you have?!', "Ow. Alright, now I'm annoyed."],
    disciplined: ['Taking hits, shields holding.', 'I am hit. Still combat effective.'],
    '*': ["I'm hit!"],
  },
  help: {
    aggressive: ['Get this thing off me!', 'I have one on my six — anybody!'],
    cautious: ['Help! He is all over me!', "I can't shake him! Somebody get him off!"],
    reckless: ['I could use a hand here! Not that I need one!', 'Slight problem back here!'],
    disciplined: ['Bandit on my six, requesting assistance.', "I'm defensive, need cover."],
    '*': ['Get him off me!'],
  },
  onMyWay: {
    '*': ['Hold on, %w, I am coming.', 'Break right, %w — I have him.', "On my way. Keep him busy."],
  },
  wingmanLost: {
    aggressive: ['They got %w. They are going to pay for that.', 'No... %w! Alright. No mercy.'],
    cautious: ['%w is gone. Oh God. %w is gone.', 'We lost %w! We should pull back!'],
    reckless: ['%w! You bastards!', 'They killed %w! Everyone dies today!'],
    disciplined: ['%w is down. Confirm chute. Continuing the mission.', 'Lost %w. Closing the gap.'],
    '*': ['We lost %w.'],
  },
  eject: {
    aggressive: ['Punching out! This is not over!', "She's breaking up — ejecting!"],
    cautious: ['Ejecting! Ejecting! Get me out of here!', "I can't hold her — punching out!"],
    reckless: ["Well, that's my ride. Punching out!", 'Ejecting! Somebody buy me a drink!'],
    disciplined: ['Airframe is lost. Ejecting.', 'Punching out. Mark my position.'],
    '*': ['Ejecting!'],
  },
  flee: {
    aggressive: ['I am hurt. Falling back — I will be back.', "Breaking off. Don't get comfortable."],
    cautious: ['I am done, I am getting out!', "I can't do this, I'm running!"],
    reckless: ['Fine! Fine! I am leaving!', 'This is a tactical withdrawal! Not a retreat!'],
    disciplined: ['Heavy damage. Withdrawing from the engagement.', 'Combat ineffective. Egressing.'],
    '*': ['Breaking off!'],
  },
  taunt: {
    aggressive: ['You fly like a cargo hauler.', 'Is that the best your squadron has?'],
    cautious: ['You will not get another pass like that.', 'I see you. I have seen better.'],
    reckless: ['Come on! Come on! Right here!', 'I can do this all day!'],
    disciplined: ['You are outclassed. Disengage while you can.', 'Predictable.'],
    '*': ['Is that all?'],
  },
  tauntAlien: {
    '*': [
      'Your species will be quiet soon.',
      'You fly like something that fears death. Good.',
      'We have already counted your dead.',
    ],
  },
  missileLaunch: {
    '*': ['Fox two!', 'Missile away!', 'Bird off the rail!'],
  },
  missileInbound: {
    aggressive: ['Missile on me. Handling it.', 'Incoming! Breaking!'],
    cautious: ['Missile! Missile inbound! Decoys out!', 'I have a lock warning — I am breaking!'],
    reckless: ['Missile! Watch this!', 'They shot a rocket at me! Rude!'],
    disciplined: ['Missile inbound, defending, chaff away.', 'Warning tone — breaking, deploying countermeasures.'],
    '*': ['Missile inbound!'],
  },
  missileDefeated: {
    '*': ['Missile defeated.', 'It went stupid. I am clean.', 'Decoyed. Back to work.'],
  },
  merge: {
    aggressive: ['Head-on! I am not turning!', 'He wants to play chicken. Fine.'],
    cautious: ['Head-on pass — breaking early!', 'Not doing this. Breaking off the merge.'],
    reckless: ['NEITHER OF US IS TURNING!', 'Straight down his throat!'],
    disciplined: ['Merging head-on. Breaking left on the pass.', 'High aspect merge. Committing.'],
    '*': ['Head-on!'],
  },
  formUp: {
    '*': ['Forming up.', 'On your wing.', 'Back in formation.'],
  },
  breakOff: {
    '*': ['Bad angle, coming around.', 'Overshooting — extending for another pass.', 'Reset. Coming back in.'],
  },
  capitalRun: {
    '*': ['Starting my run on the big one.', 'Committing on the capital ship. Watch the flak.', 'In on the cruiser.'],
  },
  orderAck: {
    aggressive: ['About time!', 'Copy that. Finally.'],
    cautious: ['Copy, I am on it.', 'Understood. Moving.'],
    reckless: ['You got it, boss!', 'Whatever you say!'],
    disciplined: ['Acknowledged.', 'Copy that, wilco.'],
    '*': ['Copy that.'],
  },
  orderRefuse: {
    aggressive: ['Negative! I have one on me!', 'Not right now, I am busy dying!'],
    reckless: ['No chance! I nearly have him!', "Can't! Almost got this guy!"],
    '*': ['Negative, I am defensive right now!'],
  },
  damageReport: {
    '*': ['%s'],
  },
  rtb: {
    '*': ['Copy, returning to base.', 'Wilco. Heading for the barn.', 'RTB. See you back aboard.'],
  },
};

const TONE_BY_KIND = {
  engage: 'calm',
  attackRun: 'calm',
  kill: 'smug',
  killByAlien: 'grim',
  nearMiss: 'urgent',
  hit: 'pain',
  help: 'panic',
  onMyWay: 'urgent',
  wingmanLost: 'grim',
  eject: 'panic',
  flee: 'urgent',
  taunt: 'smug',
  tauntAlien: 'grim',
  missileLaunch: 'urgent',
  missileInbound: 'panic',
  missileDefeated: 'wry',
  merge: 'urgent',
  formUp: 'calm',
  breakOff: 'calm',
  capitalRun: 'grim',
  orderAck: 'calm',
  orderRefuse: 'urgent',
  damageReport: 'calm',
  rtb: 'calm',
};

const PRIORITY_BY_KIND = {
  help: 3,
  eject: 3,
  missileInbound: 3,
  wingmanLost: 2,
  hit: 2,
  flee: 2,
  orderAck: 2,
  orderRefuse: 2,
  damageReport: 2,
  onMyWay: 2,
  kill: 1,
  killByAlien: 1,
  merge: 1,
  missileLaunch: 1,
  capitalRun: 1,
  engage: 0,
  attackRun: 0,
  taunt: 0,
  tauntAlien: 0,
  nearMiss: 0,
  breakOff: 0,
  formUp: 0,
  missileDefeated: 0,
  rtb: 1,
};

/** How long before the same pilot may repeat this kind of line. */
const COOLDOWN_BY_KIND = {
  engage: 14,
  attackRun: 11,
  kill: 3,
  killByAlien: 3,
  nearMiss: 9,
  hit: 6,
  help: 8,
  onMyWay: 10,
  wingmanLost: 20,
  eject: 999,
  flee: 25,
  taunt: 16,
  tauntAlien: 16,
  missileLaunch: 4,
  missileInbound: 7,
  missileDefeated: 8,
  merge: 12,
  formUp: 12,
  breakOff: 13,
  capitalRun: 20,
  orderAck: 0.5,
  orderRefuse: 3,
  damageReport: 1,
  rtb: 20,
};

/**
 * The comms channel. One instance per AI system.
 *
 * `budget` models a single radio net: after someone transmits, low-priority
 * chatter is suppressed for a moment. Without this, a 12-ship furball produces
 * forty lines a second and the player reads none of them.
 */
export class Radio {
  constructor(events, { rng = null } = {}) {
    this.events = events;
    this.time = 0;
    this.busyUntil = 0;
    this.lastText = '';
    this.log = [];
    this.keepLog = 64;
    this.enabled = true;
    this._rand = rng ?? ((n) => hash01(n | 0, 991));
  }

  update(dt) {
    this.time += dt;
  }

  /** Pick a line body for kind/temperament, deterministic on `salt`. */
  static pickLine(kind, temperament, salt) {
    const bucket = LINES[kind];
    if (!bucket) return null;
    const list = bucket[temperament] ?? bucket['*'];
    if (!list || !list.length) return null;
    return list[Math.floor(hash01(salt, 7717) * list.length) % list.length];
  }

  /**
   * Transmit. Returns true if the line actually went out.
   *
   * @param {object} pilot   the speaker (needs .profile, .ship)
   * @param {string} kind    key into LINES
   * @param {object} opts    { target, wingman, text, force, priority, tone, subs }
   */
  say(pilot, kind, opts = {}) {
    if (!this.enabled || !this.events) return false;
    const p = pilot?.profile;
    if (!p) return false;

    const prio = opts.priority ?? PRIORITY_BY_KIND[kind] ?? 0;

    // Per-pilot per-kind cooldown.
    pilot.saidAt ??= {};
    const cd = COOLDOWN_BY_KIND[kind] ?? 8;
    if (!opts.force && (pilot.saidAt[kind] ?? -1e9) + cd > this.time) return false;

    // Channel budget: banter yields to anything urgent that just went out.
    if (!opts.force && prio < 2 && this.time < this.busyUntil) return false;

    // Temperament gate: quiet pilots simply talk less.
    if (!opts.force && prio < 2) {
      const roll = hash01((pilot.id | 0) * 131 + Math.floor(this.time * 7), 4441);
      if (roll > 0.25 + p.chatter * 0.75) return false;
    }

    let text = opts.text ?? Radio.pickLine(kind, p.temperament, (pilot.id | 0) * 31 + Math.floor(this.time * 3) + kind.length);
    if (!text) return false;

    const tName = opts.target?.pilot?.profile?.callsign ?? opts.target?.name ?? opts.targetName ?? 'the bandit';
    const wName = opts.wingman?.pilot?.profile?.callsign ?? opts.wingman?.name ?? opts.wingmanName ?? 'wingman';
    text = text.replace(/%t/g, tName).replace(/%w/g, wName);
    if (opts.subs) text = text.replace(/%s/g, opts.subs);

    if (text === this.lastText && !opts.force) return false;

    pilot.saidAt[kind] = this.time;
    this.lastText = text;
    this.busyUntil = this.time + Math.min(2.6, 0.9 + text.length * 0.045);

    const payload = {
      from: p.callsign,
      pilotName: p.name,
      text,
      tone: opts.tone ?? TONE_BY_KIND[kind] ?? 'calm',
      priority: prio,
      kind,
      ship: pilot.ship,
      faction: pilot.ship?.faction ?? p.faction,
      target: opts.target ?? null,
      t: this.time,
    };
    this.log.push(payload);
    if (this.log.length > this.keepLog) this.log.shift();
    this.events.emit('comms:message', payload);
    return true;
  }

  /** Direct transmission from something that is not a pilot (a carrier, control). */
  broadcast(from, text, { tone = 'calm', priority = 2, kind = 'broadcast' } = {}) {
    if (!this.enabled || !this.events) return false;
    const payload = { from, text, tone, priority, kind, ship: null, t: this.time };
    this.log.push(payload);
    if (this.log.length > this.keepLog) this.log.shift();
    this.busyUntil = this.time + Math.min(2.6, 0.9 + text.length * 0.045);
    this.events.emit('comms:message', payload);
    return true;
  }
}

/** Kind-selection helper: aliens use their own line bank where one exists. */
export function speciesKind(kind, faction) {
  const alien = faction && faction !== 'confed' && faction !== 'militia' && faction !== 'civilian';
  if (!alien) return kind;
  if (kind === 'kill' && LINES.killByAlien) return 'killByAlien';
  if (kind === 'taunt' && LINES.tauntAlien) return 'tauntAlien';
  return kind;
}

/** Build a short spoken damage report from whatever the ship exposes. */
export function damageReportText(ship) {
  const hull = clamp01(shipFrac(ship, ['hullFrac', 'hull', 'health'], ['maxHull', 'maxHealth']));
  const sh = clamp01(shipFrac(ship, ['shieldFrac', 'shields'], ['maxShields']));
  const pct = (v) => `${Math.round(v * 100)}%`;
  if (hull > 0.85 && sh > 0.7) return `No damage worth reporting. Shields ${pct(sh)}.`;
  if (hull > 0.6) return `Shields ${pct(sh)}, hull ${pct(hull)}. Still green.`;
  if (hull > 0.3) return `Taken some hits. Shields ${pct(sh)}, hull ${pct(hull)}. I can still fight.`;
  return `I am chewed up. Hull ${pct(hull)}. One more good burst and I am done.`;
}

function shipFrac(ship, valueKeys, maxKeys) {
  if (!ship) return 1;
  for (const k of valueKeys) {
    const v = ship[k];
    if (typeof v === 'number') {
      if (k.endsWith('Frac')) return v;
      for (const mk of maxKeys) {
        const m = ship[mk];
        if (typeof m === 'number' && m > 0) return v / m;
      }
      if (v <= 1) return v;
    }
  }
  return 1;
}
