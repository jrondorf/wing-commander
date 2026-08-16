/**
 * Input — keyboard, mouse and gamepad folded into one action map.
 *
 * Flight axes are normalized to [-1, 1]; buttons expose both level (`held`) and
 * edge (`pressed`/`released`) queries. A scripted capture run can take control by
 * setting `input.scripted = true` and writing straight into `input.axes`.
 */

export const ACTIONS = {
  // Flight axes
  pitch: 'pitch',
  yaw: 'yaw',
  roll: 'roll',
  throttle: 'throttle',
  // Buttons
  fire: 'fire',
  missile: 'missile',
  afterburner: 'afterburner',
  brake: 'brake',
  matchSpeed: 'matchSpeed',
  nextTarget: 'nextTarget',
  nearestEnemy: 'nearestEnemy',
  targetAttacker: 'targetAttacker',
  cycleWeapon: 'cycleWeapon',
  cycleMissile: 'cycleMissile',
  cycleView: 'cycleView',
  lookBack: 'lookBack',
  autopilot: 'autopilot',
  fullStop: 'fullStop',
  commsMenu: 'commsMenu',
  pause: 'pause',
  eject: 'eject',
  cloak: 'cloak',
  decoy: 'decoy',
  shieldFwd: 'shieldFwd',
  shieldAft: 'shieldAft',
  shieldBalance: 'shieldBalance',
  powerGuns: 'powerGuns',
  powerShields: 'powerShields',
  powerEngines: 'powerEngines',
};

const KEY_BINDINGS = {
  // axis: [negativeKey, positiveKey]
  _axes: {
    pitch: ['ArrowDown', 'ArrowUp'],
    yaw: ['ArrowLeft', 'ArrowRight'],
    roll: ['KeyQ', 'KeyE'],
    throttle: ['Minus', 'Equal'],
  },
  Space: ACTIONS.fire,
  Enter: ACTIONS.missile,
  Tab: ACTIONS.afterburner,
  Backspace: ACTIONS.brake,
  KeyT: ACTIONS.nextTarget,
  KeyR: ACTIONS.nearestEnemy,
  KeyA: ACTIONS.targetAttacker,
  KeyW: ACTIONS.cycleWeapon,
  KeyM: ACTIONS.cycleMissile,
  KeyF: ACTIONS.cycleView,
  KeyB: ACTIONS.lookBack,
  KeyN: ACTIONS.autopilot,
  KeyS: ACTIONS.matchSpeed,
  Backquote: ACTIONS.fullStop,
  KeyC: ACTIONS.commsMenu,
  KeyP: ACTIONS.pause,
  KeyD: ACTIONS.decoy,
  KeyK: ACTIONS.cloak,
  Comma: ACTIONS.shieldFwd,
  Period: ACTIONS.shieldAft,
  Slash: ACTIONS.shieldBalance,
  Digit1: ACTIONS.powerGuns,
  Digit2: ACTIONS.powerShields,
  Digit3: ACTIONS.powerEngines,
};

export class Input {
  constructor(target = window) {
    this.target = target;
    this.scripted = false;

    this.axes = { pitch: 0, yaw: 0, roll: 0, throttle: 0 };
    /** Raw analog stick/mouse contribution, kept separate so keys and stick sum. */
    this.analog = { pitch: 0, yaw: 0, roll: 0 };

    this._held = new Set();
    this._pressed = new Set();
    this._released = new Set();
    this._keysDown = new Set();

    this.mouse = { x: 0, y: 0, dx: 0, dy: 0, locked: false, buttons: 0 };
    this.mouseFlight = false;
    this.gamepadIndex = null;

    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
    this._onMouseMove = this._onMouseMove.bind(this);
    this._onMouseDown = this._onMouseDown.bind(this);
    this._onMouseUp = this._onMouseUp.bind(this);
    this._onPointerLock = this._onPointerLock.bind(this);
    this._onBlur = this._onBlur.bind(this);

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('mousemove', this._onMouseMove);
    window.addEventListener('mousedown', this._onMouseDown);
    window.addEventListener('mouseup', this._onMouseUp);
    window.addEventListener('blur', this._onBlur);
    document.addEventListener('pointerlockchange', this._onPointerLock);
  }

  _onKeyDown(e) {
    if (e.repeat) return;
    // Let the browser keep F5/devtools; swallow everything the sim binds.
    const action = KEY_BINDINGS[e.code];
    const isAxisKey = Object.values(KEY_BINDINGS._axes).some((p) => p.includes(e.code));
    if (action || isAxisKey) e.preventDefault();
    this._keysDown.add(e.code);
    if (action && !this._held.has(action)) {
      this._held.add(action);
      this._pressed.add(action);
    }
  }

  _onKeyUp(e) {
    this._keysDown.delete(e.code);
    const action = KEY_BINDINGS[e.code];
    if (action) {
      this._held.delete(action);
      this._released.add(action);
    }
  }

  _onMouseDown(e) {
    this.mouse.buttons |= 1 << e.button;
    const action = e.button === 0 ? ACTIONS.fire : e.button === 2 ? ACTIONS.missile : null;
    if (action && !this._held.has(action)) {
      this._held.add(action);
      this._pressed.add(action);
    }
  }

  _onMouseUp(e) {
    this.mouse.buttons &= ~(1 << e.button);
    const action = e.button === 0 ? ACTIONS.fire : e.button === 2 ? ACTIONS.missile : null;
    if (action) {
      this._held.delete(action);
      this._released.add(action);
    }
  }

  _onMouseMove(e) {
    if (this.mouse.locked) {
      this.mouse.dx += e.movementX;
      this.mouse.dy += e.movementY;
    }
    this.mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
    this.mouse.y = -((e.clientY / window.innerHeight) * 2 - 1);
  }

  _onPointerLock() {
    this.mouse.locked = document.pointerLockElement != null;
  }

  _onBlur() {
    this._keysDown.clear();
    this._held.clear();
    this.mouse.buttons = 0;
  }

  requestPointerLock() {
    this.target?.requestPointerLock?.();
  }

  beginFrame() {
    if (this.scripted) return;

    const axisFromKeys = (pair) =>
      (this._keysDown.has(pair[1]) ? 1 : 0) - (this._keysDown.has(pair[0]) ? 1 : 0);

    const a = KEY_BINDINGS._axes;
    this.axes.pitch = clamp11(axisFromKeys(a.pitch) + this.analog.pitch);
    this.axes.yaw = clamp11(axisFromKeys(a.yaw) + this.analog.yaw);
    this.axes.roll = clamp11(axisFromKeys(a.roll) + this.analog.roll);

    this._pollGamepad();

    if (this.mouseFlight && this.mouse.locked) {
      // Relative mouse steering with a deadzone — the "virtual stick" feel WC used
      // for mouse pilots.
      const s = 0.0022;
      this.axes.yaw = clamp11(this.axes.yaw + this.mouse.dx * s);
      this.axes.pitch = clamp11(this.axes.pitch - this.mouse.dy * s);
    }
  }

  _pollGamepad() {
    if (!navigator.getGamepads) return;
    const pads = navigator.getGamepads();
    const pad = pads?.[this.gamepadIndex ?? 0] ?? null;
    if (!pad) return;
    const dz = (v) => (Math.abs(v) < 0.12 ? 0 : (v - Math.sign(v) * 0.12) / 0.88);
    this.axes.roll = clamp11(this.axes.roll + dz(pad.axes[0] ?? 0));
    this.axes.pitch = clamp11(this.axes.pitch - dz(pad.axes[1] ?? 0));
    this.axes.yaw = clamp11(this.axes.yaw + dz(pad.axes[2] ?? 0));
    const setBtn = (idx, action) => {
      const down = pad.buttons[idx]?.pressed;
      if (down && !this._held.has(action)) {
        this._held.add(action);
        this._pressed.add(action);
      } else if (!down && this._held.has(action)) {
        this._held.delete(action);
        this._released.add(action);
      }
    };
    setBtn(7, ACTIONS.fire);
    setBtn(5, ACTIONS.missile);
    setBtn(0, ACTIONS.afterburner);
    setBtn(3, ACTIONS.nextTarget);
  }

  endFrame() {
    this._pressed.clear();
    this._released.clear();
    this.mouse.dx = 0;
    this.mouse.dy = 0;
  }

  held(action) { return this._held.has(action); }
  pressed(action) { return this._pressed.has(action); }
  released(action) { return this._released.has(action); }

  /** Used by scripted capture runs to inject a single-frame button press. */
  injectPress(action) {
    this._pressed.add(action);
    this._held.add(action);
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('mousemove', this._onMouseMove);
    window.removeEventListener('mousedown', this._onMouseDown);
    window.removeEventListener('mouseup', this._onMouseUp);
    window.removeEventListener('blur', this._onBlur);
    document.removeEventListener('pointerlockchange', this._onPointerLock);
  }
}

function clamp11(v) { return v < -1 ? -1 : v > 1 ? 1 : v; }
