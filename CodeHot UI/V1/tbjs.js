/*
 * TBJS — CodeHot UI Button Binding Runtime
 * Version: 15.0.0
 *
 * Connects UI overlay elements (joysticks, buttons) to the "mo" markers
 * that CodeHot game scripts reference. When a CodeHot script does:
 *
 *   update(ctx, self) {
 *     self.position.x = mo.joystick.x * 5;
 *     if (mo.jump) self.position.y += 0.3;
 *   }
 *
 * TBJS provides the live `mo` object whose values update from the UI
 * elements placed by CodeHot UI's design tab.
 *
 * UI elements are expected to have data attributes:
 *   data-tbjs-type   = "joystick" | "button" | "axis"
 *   data-tbjs-name   = "joystick" | "jump" | "action" | custom
 *   data-tbjs-axis   = "x" | "y" (for joysticks/axes)
 *
 * TBJS auto-discovers these on DOMContentLoaded and starts polling.
 * The `mo` object is exposed on `window.mo` so game scripts can read it.
 *
 * Also exposes:
 *   window.TBJS.bindElement(el, config)
 *   window.TBJS.unbindElement(el)
 *   window.TBJS.getState()    — snapshot of all mo values
 *   window.TBJS.reset()       — zeroes everything
 *   window.TBJS.onPress(name, cb)     — callback fires when button name goes true
 *   window.TBJS.onRelease(name, cb)   — callback fires when button name goes false
 */
(function (global) {
  'use strict';

  if (global.TBJS && global.mo) return; // idempotent

  // ── mo state ──────────────────────────────────────────────────────
  // The mo object holds the live values game scripts read. Joysticks
  // expose `.x` and `.y` (clamped -1..1). Buttons expose a boolean
  // (true while pressed). Axes (one-dimensional sliders) expose a single
  // number.
  var state = {};
  var pressCallbacks = {};
  var releaseCallbacks = {};
  var boundElements = [];

  function ensurePath(name) {
    if (!state[name]) {
      if (name === 'joystick' || name === 'camera') {
        state[name] = { x: 0, y: 0, active: false };
      } else {
        state[name] = false;
      }
    }
  }

  function setValue(name, value) {
    ensurePath(name);
    var prev = JSON.parse(JSON.stringify(state[name]));
    if (typeof state[name] === 'object' && state[name] !== null && typeof value === 'object') {
      // merge {x, y} into joystick-like
      if (typeof value.x === 'number') state[name].x = clamp(value.x, -1, 1);
      if (typeof value.y === 'number') state[name].y = clamp(value.y, -1, 1);
      if (typeof value.active === 'boolean') state[name].active = value.active;
    } else {
      var newVal = !!value;
      state[name] = newVal;
      // fire callbacks on transition
      if (newVal && !prev) {
        (pressCallbacks[name] || []).forEach(function (cb) { try { cb(); } catch (e) {} });
      } else if (!newVal && prev) {
        (releaseCallbacks[name] || []).forEach(function (cb) { try { cb(); } catch (e) {} });
      }
    }
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // ── Joystick binding ──────────────────────────────────────────────
  // A joystick element is a circular div. Touch/mouse drag inside it
  // moves a "stick" child and updates mo.joystick.x/y proportionally.
  // Releasing the pointer snaps back to center.
  function bindJoystick(el, name) {
    var stick = el.querySelector('.tbjs-stick') || el;
    var rect = el.getBoundingClientRect();
    var radius = Math.min(rect.width, rect.height) / 2;
    var pointerId = null;
    var center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };

    function refreshRect() {
      rect = el.getBoundingClientRect();
      radius = Math.min(rect.width, rect.height) / 2;
      center.x = rect.left + rect.width / 2;
      center.y = rect.top + rect.height / 2;
    }

    function onDown(e) {
      e.preventDefault();
      refreshRect();
      pointerId = (e.pointerId !== undefined) ? e.pointerId : 'mouse';
      if (e.setPointerCapture && e.pointerId !== undefined) {
        try { el.setPointerCapture(e.pointerId); } catch (err) {}
      }
      onMove(e);
    }

    function onMove(e) {
      if (pointerId === null) return;
      if (e.pointerId !== undefined && e.pointerId !== pointerId) return;
      var x = (e.clientX - center.x) / radius;
      var y = (e.clientY - center.y) / radius;
      // clamp to unit circle
      var mag = Math.sqrt(x * x + y * y);
      if (mag > 1) { x /= mag; y /= mag; }
      setValue(name, { x: x, y: y, active: true });
      if (stick && stick !== el) {
        stick.style.transform = 'translate(' + (x * radius) + 'px,' + (y * radius) + 'px)';
      }
    }

    function onUp(e) {
      if (pointerId === null) return;
      if (e.pointerId !== undefined && e.pointerId !== pointerId) return;
      pointerId = null;
      setValue(name, { x: 0, y: 0, active: false });
      if (stick && stick !== el) {
        stick.style.transform = 'translate(0,0)';
      }
    }

    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
    el.addEventListener('pointerleave', onUp);

    return {
      el: el,
      type: 'joystick',
      name: name,
      destroy: function () {
        el.removeEventListener('pointerdown', onDown);
        el.removeEventListener('pointermove', onMove);
        el.removeEventListener('pointerup', onUp);
        el.removeEventListener('pointercancel', onUp);
        el.removeEventListener('pointerleave', onUp);
      }
    };
  }

  // ── Button binding ────────────────────────────────────────────────
  // A button element toggles mo.<name> between false (released) and
  // true (pressed). Works with both touch and mouse.
  function bindButton(el, name) {
    function onDown(e) {
      e.preventDefault();
      setValue(name, true);
      el.classList.add('tbjs-active');
    }
    function onUp(e) {
      setValue(name, false);
      el.classList.remove('tbjs-active');
    }
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
    el.addEventListener('pointerleave', onUp);
    return {
      el: el,
      type: 'button',
      name: name,
      destroy: function () {
        el.removeEventListener('pointerdown', onDown);
        el.removeEventListener('pointerup', onUp);
        el.removeEventListener('pointercancel', onUp);
        el.removeEventListener('pointerleave', onUp);
      }
    };
  }

  // ── Axis binding (slider) ─────────────────────────────────────────
  // An axis element is a horizontal/vertical bar; dragging sets a
  // single number in [-1, 1]. Useful for throttle sliders.
  function bindAxis(el, name, axis) {
    axis = axis || 'x';
    var rect = el.getBoundingClientRect();
    var pointerId = null;

    function refreshRect() { rect = el.getBoundingClientRect(); }

    function onDown(e) {
      e.preventDefault();
      refreshRect();
      pointerId = (e.pointerId !== undefined) ? e.pointerId : 'mouse';
      if (e.setPointerCapture && e.pointerId !== undefined) {
        try { el.setPointerCapture(e.pointerId); } catch (err) {}
      }
      onMove(e);
    }

    function onMove(e) {
      if (pointerId === null) return;
      if (e.pointerId !== undefined && e.pointerId !== pointerId) return;
      var v;
      if (axis === 'y') {
        v = ((e.clientY - rect.top) / rect.height) * 2 - 1;
      } else {
        v = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      }
      v = clamp(v, -1, 1);
      ensurePath(name);
      if (typeof state[name] === 'object' && state[name] !== null) {
        state[name][axis] = v;
        state[name].active = true;
      } else {
        state[name] = v;
      }
    }

    function onUp(e) {
      if (pointerId === null) return;
      pointerId = null;
      if (typeof state[name] === 'object' && state[name] !== null) {
        state[name].active = false;
      }
    }

    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
    return {
      el: el,
      type: 'axis',
      name: name,
      destroy: function () {
        el.removeEventListener('pointerdown', onDown);
        el.removeEventListener('pointermove', onMove);
        el.removeEventListener('pointerup', onUp);
        el.removeEventListener('pointercancel', onUp);
      }
    };
  }

  // ── Public API ────────────────────────────────────────────────────
  function bindElement(el, config) {
    config = config || {};
    var type = config.type || el.getAttribute('data-tbjs-type') || 'button';
    var name = config.name || el.getAttribute('data-tbjs-name') || 'action';
    var axis = config.axis || el.getAttribute('data-tbjs-axis') || 'x';
    ensurePath(name);
    var binding;
    if (type === 'joystick') binding = bindJoystick(el, name);
    else if (type === 'axis') binding = bindAxis(el, name, axis);
    else binding = bindButton(el, name);
    boundElements.push(binding);
    return binding;
  }

  function unbindElement(el) {
    boundElements = boundElements.filter(function (b) {
      if (b.el === el) { b.destroy(); return false; }
      return true;
    });
  }

  function autoDiscover() {
    var els = document.querySelectorAll('[data-tbjs-type]');
    els.forEach(function (el) { bindElement(el); });
  }

  function getState() { return JSON.parse(JSON.stringify(state)); }

  function reset() {
    Object.keys(state).forEach(function (k) {
      if (typeof state[k] === 'object' && state[k] !== null) {
        state[k] = { x: 0, y: 0, active: false };
      } else {
        state[k] = false;
      }
    });
  }

  function onPress(name, cb) {
    if (!pressCallbacks[name]) pressCallbacks[name] = [];
    pressCallbacks[name].push(cb);
  }

  function onRelease(name, cb) {
    if (!releaseCallbacks[name]) releaseCallbacks[name] = [];
    releaseCallbacks[name].push(cb);
  }

  // Keyboard fallback: map WASD/arrows to mo.joystick, Space to mo.jump.
  // This lets the exported game be playable on desktop without touch UI.
  var keyboardKeys = {};
  function bindKeyboard() {
    document.addEventListener('keydown', function (e) {
      if (e.repeat) return;
      keyboardKeys[e.code] = true;
      updateKeyboardJoystick();
      // Space → jump
      if (e.code === 'Space') setValue('jump', true);
      // Common action keys
      if (e.code === 'KeyE' || e.code === 'Enter') setValue('action', true);
      if (e.code === 'KeyF' || e.code === 'ShiftLeft') setValue('fire', true);
    });
    document.addEventListener('keyup', function (e) {
      keyboardKeys[e.code] = false;
      updateKeyboardJoystick();
      if (e.code === 'Space') setValue('jump', false);
      if (e.code === 'KeyE' || e.code === 'Enter') setValue('action', false);
      if (e.code === 'KeyF' || e.code === 'ShiftLeft') setValue('fire', false);
    });
  }

  function updateKeyboardJoystick() {
    var x = 0, y = 0;
    if (keyboardKeys['ArrowLeft'] || keyboardKeys['KeyA']) x -= 1;
    if (keyboardKeys['ArrowRight'] || keyboardKeys['KeyD']) x += 1;
    if (keyboardKeys['ArrowUp'] || keyboardKeys['KeyW']) y -= 1;
    if (keyboardKeys['ArrowDown'] || keyboardKeys['KeyS']) y += 1;
    ensurePath('joystick');
    var active = (x !== 0 || y !== 0);
    setValue('joystick', { x: x, y: y, active: active });
  }

  // ── Bootstrap ─────────────────────────────────────────────────────
  global.mo = state;
  global.TBJS = {
    version: '15.0.0',
    bindElement: bindElement,
    unbindElement: unbindElement,
    autoDiscover: autoDiscover,
    getState: getState,
    reset: reset,
    onPress: onPress,
    onRelease: onRelease,
    state: state
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      autoDiscover();
      bindKeyboard();
    });
  } else {
    autoDiscover();
    bindKeyboard();
  }
})(typeof window !== 'undefined' ? window : this);
