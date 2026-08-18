/**
 * src/ai/wingmen.js — the comms menu.
 *
 * Wing Commander's comms menu is a gameplay system, not a cosmetic one: the
 * difference between "Break and attack" and "Keep formation" decides whether you
 * get a kill or lose a wingman. Each order maps to a *behaviour override* that
 * the state machine honours (behaviors.desiredState, step 2), plus a spoken
 * acknowledgement — including a refusal when the wingman is too busy dying.
 *
 * Usage from ui/ or cockpit/:
 *
 *   const wc = engine.game.ai.wingmen;
 *   wc.issue('attackMyTarget');            // to the whole flight
 *   wc.issue('breakAndAttack', { to: 2 }); // to wingman #2
 *   wc.list();                             // menu entries for the UI
 *
 * Every order emits `comms:message` twice: the player's transmission and the
 * wingman's reply, so subtitles read as a conversation.
 */
import * as THREE from 'three';
import { damageReportText, speciesKind } from './chatter.js';
import { setState } from './behaviors.js';

/**
 * The menu. `apply(pilot, ai, ctxOpts)` mutates the pilot's override block.
 * `state` (when present) is the state the HSM is pinned to;
 * `yieldsToDanger` lets a wingman defend themselves rather than obey and die.
 */
export const COMMANDS = {
  breakAndAttack: {
    key: 'breakAndAttack',
    label: 'Break and attack',
    say: 'Break and attack!',
    reply: 'orderAck',
    apply(pilot, ai) {
      pilot.order = { id: 'breakAndAttack', state: null, yieldsToDanger: true, until: ai.time + 300 };
      pilot.holdFire = false;
      pilot.freeEngage = true;
      pilot.forcedTarget = null;
      pilot.waypoint = null;
      pilot.disengaged = false;
      pilot.leader = null; // out of formation until told otherwise
      if (pilot.squadron) pilot.squadron.intact = false;
    },
  },

  formOnMyWing: {
    key: 'formOnMyWing',
    label: 'Form on my wing',
    say: 'Form on my wing.',
    reply: 'formUp',
    apply(pilot, ai) {
      pilot.order = { id: 'formOnMyWing', state: 'formUp', yieldsToDanger: true, until: ai.time + 600 };
      pilot.holdFire = false;
      pilot.freeEngage = false;
      pilot.forcedTarget = null;
      pilot.waypoint = null;
      pilot.disengaged = false;
      ai.bindToPlayerWing(pilot);
    },
  },

  helpMeOut: {
    key: 'helpMeOut',
    label: 'Help me out!',
    say: 'I need some help here!',
    reply: 'onMyWay',
    apply(pilot, ai) {
      const pp = ai.playerPilot;
      pilot.order = { id: 'helpMeOut', state: 'defend', yieldsToDanger: true, urgent: true, until: ai.time + 45 };
      pilot.protecting = pp;
      pilot.protectUntil = ai.time + 45;
      pilot.forcedTarget = pp?.threat ?? null;
      pilot.holdFire = false;
      pilot.disengaged = false;
    },
  },

  attackMyTarget: {
    key: 'attackMyTarget',
    label: 'Attack my target',
    say: 'Attack my target.',
    reply: 'orderAck',
    apply(pilot, ai) {
      const tgt = ai.playerTarget();
      pilot.order = { id: 'attackMyTarget', state: null, yieldsToDanger: true, until: ai.time + 60 };
      pilot.forcedTarget = tgt;
      pilot.forcedTargetUntil = ai.time + 60;
      pilot.holdFire = false;
      pilot.freeEngage = true;
      pilot.disengaged = false;
      pilot.leader = null;
      if (pilot.squadron) pilot.squadron.intact = false;
    },
    valid(ai) {
      return !!ai.playerTarget();
    },
  },

  keepFormation: {
    key: 'keepFormation',
    label: 'Keep formation',
    say: 'Keep formation. Weapons tight.',
    reply: 'orderAck',
    apply(pilot, ai) {
      pilot.order = { id: 'keepFormation', state: 'formUp', yieldsToDanger: true, until: ai.time + 900 };
      pilot.holdFire = true;
      pilot.freeEngage = false;
      pilot.forcedTarget = null;
      pilot.disengaged = false;
      ai.bindToPlayerWing(pilot);
    },
  },

  returnToBase: {
    key: 'returnToBase',
    label: 'Return to base',
    say: 'Return to base.',
    reply: 'rtb',
    apply(pilot, ai) {
      pilot.order = { id: 'returnToBase', state: 'regroup', yieldsToDanger: true, until: ai.time + 3600 };
      pilot.disengaged = true;
      pilot.holdFire = true;
      pilot.freeEngage = false;
      pilot.forcedTarget = null;
      pilot.target = null;
      pilot.leader = null;
      pilot.waypoint = ai.basePosition();
    },
  },

  damageReport: {
    key: 'damageReport',
    label: 'Damage report',
    say: 'Give me a damage report.',
    reply: 'damageReport',
    apply() {
      /* no behaviour change — it is a question */
    },
    replyOpts(pilot) {
      return { subs: damageReportText(pilot.ship), force: true };
    },
  },
};

export const COMMAND_IDS = Object.keys(COMMANDS);

/**
 * The commander. One per AI system, reachable at `engine.game.ai.wingmen`.
 */
export class WingmanCommander {
  constructor(ai) {
    this.ai = ai;
    this.lastOrder = null;
    this.lastOrderTime = -99;
  }

  /** Menu entries for the UI, with availability flags. */
  list() {
    return COMMAND_IDS.map((id) => ({
      id,
      label: COMMANDS[id].label,
      available: COMMANDS[id].valid ? COMMANDS[id].valid(this.ai) === true : true,
    }));
  }

  /** Every friendly AI pilot the player can give orders to. */
  wingmen() {
    const player = this.ai.engine.game?.player;
    if (!player) return [];
    return this.ai.pilots.filter(
      (p) => p.ship?.alive !== false && p.ship !== player && !this.ai.isHostileToPlayer(p.ship),
    );
  }

  /** Resolve `to`: a pilot, a ship, an index (1-based, WC style), or 'all'. */
  resolve(to) {
    const wing = this.wingmen();
    if (to == null || to === 'all') return wing;
    if (typeof to === 'number') {
      const p = wing[Math.max(0, to - 1)];
      return p ? [p] : [];
    }
    if (to.profile && to.ship) return wing.includes(to) ? [to] : [];
    const p = this.ai.pilotOf(to);
    return p ? [p] : [];
  }

  /**
   * Issue an order. Returns the number of wingmen who took it.
   * A wingman who is defensive right now refuses out loud — which is a feature:
   * it tells the player their wingman is in trouble without a HUD element.
   */
  issue(id, { to = 'all', silent = false } = {}) {
    const cmd = COMMANDS[id];
    const ai = this.ai;
    if (!cmd) return 0;
    if (cmd.valid && cmd.valid(ai) !== true) return 0;

    const targets = this.resolve(to);
    if (!targets.length) return 0;

    if (!silent) {
      const callsign = ai.engine.game?.player?.pilotName ?? 'Wing Leader';
      ai.radio.broadcast(callsign, cmd.say, { tone: 'calm', priority: 3, kind: 'order' });
    }

    this.lastOrder = id;
    this.lastOrderTime = ai.time;

    let taken = 0;
    for (const pilot of targets) {
      const desperate =
        pilot.incoming ||
        (pilot.state === 'evade' && pilot.underAttackFor > 1.2) ||
        pilot.state === 'flee';
      if (desperate && id !== 'damageReport' && id !== 'returnToBase') {
        ai.radio.say(pilot, 'orderRefuse', { force: true });
        continue;
      }

      cmd.apply(pilot, ai);
      pilot.orderTime = ai.time;
      taken++;

      const kind = speciesKind(cmd.reply, pilot.ship?.faction);
      const opts = cmd.replyOpts ? cmd.replyOpts(pilot, ai) : {};
      ai.radio.say(pilot, kind, { force: true, ...opts });

      // Snap the state immediately when the order names one, so the player sees
      // the wingman react on the same beat as the acknowledgement.
      if (cmd.apply && pilot.order?.state) {
        const ctx = ai.contextFor(pilot, 0);
        if (ctx) setState(pilot, pilot.order.state, ctx);
      }
    }
    return taken;
  }

  /** Expire orders whose clock has run out. */
  update(dt) {
    const t = this.ai.time;
    for (const p of this.ai.pilots) {
      if (p.order && p.order.until != null && t > p.order.until) {
        p.order = null;
        p.freeEngage = false;
      }
      if (p.forcedTarget && p.forcedTargetUntil != null && t > p.forcedTargetUntil) {
        p.forcedTarget = null;
      }
      if (p.forcedTarget && p.forcedTarget.alive === false) p.forcedTarget = null;
      if (p.protecting && t > p.protectUntil) p.protecting = null;
    }
  }
}
