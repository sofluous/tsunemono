const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function setup() {
  function target(k) {
    const handlers = {};
    const held = new Set();
    const captures = new Set();
    return {
      addEventListener(type, callback) { (handlers[type] ??= []).push(callback); },
      emit(type, props = {}) {
        const event = { pointerId: 1, pointerType: 'touch', clientX: 50, clientY: 50,
          preventDefault() {}, ...props };
        for (const callback of handlers[type] || []) callback(event);
      },
      getAttribute() { return k; },
      classList: { toggle(name, on) { if (on) held.add(name); else held.delete(name); } },
      held,
      getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 100 }; },
      setPointerCapture(id) { captures.add(id); },
      hasPointerCapture(id) { return captures.has(id); },
      releasePointerCapture(id) { captures.delete(id); this.emit('lostpointercapture', { pointerId: id }); },
    };
  }
  const buttons = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Action', 'Pause'].map(target);
  const pad = target();
  pad.querySelectorAll = () => buttons.slice(0, 4);
  const window = target();
  const stage = target();
  const document = Object.assign(target(), {
    querySelector: () => pad,
    querySelectorAll: () => buttons,
    getElementById: () => stage,
    hidden: false,
  });
  const key = {};
  const pressed = {};
  const actions = [];
  const context = vm.createContext({ window, document, key, pressed,
    mouseDown: false, nozzleDrag: false, lastMouse: null,
    mapKey: (e) => e.key === 'a' ? 'Action' : e.key,
    triggerVirtualButton: (k) => { actions.push(k); return k === 'Action' || k === 'Pause'; },
  });
  const start = script.indexOf('  // Merge independent input sources');
  const end = script.indexOf("  canvas.addEventListener('pointerdown'", start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(script.slice(start, end), context);
  return { pad, window, document, buttons, key, pressed, actions, context };
}

test('application inline script compiles', () => { new vm.Script(script); });

test('one held thumb traverses all eight directions and returns to neutral', () => {
  const { pad, key } = setup();
  pad.emit('pointerdown', { clientX: 50, clientY: 0 });
  const cases = [
    [50, 0, ['ArrowUp']], [100, 0, ['ArrowRight', 'ArrowUp']],
    [100, 50, ['ArrowRight']], [100, 100, ['ArrowDown', 'ArrowRight']],
    [50, 100, ['ArrowDown']], [0, 100, ['ArrowDown', 'ArrowLeft']],
    [0, 50, ['ArrowLeft']], [0, 0, ['ArrowLeft', 'ArrowUp']], [50, 50, []],
  ];
  for (const [clientX, clientY, expected] of cases) {
    pad.emit('pointermove', { clientX, clientY });
    assert.deepEqual(Object.keys(key).filter(k => key[k]).sort(), expected.sort());
  }
});

test('distance changes do not change digital output; capture allows outside release', () => {
  const { pad, key } = setup();
  pad.emit('pointerdown', { clientX: 70 });
  assert.equal(key.ArrowRight, true);
  pad.emit('pointermove', { clientX: 300 });
  assert.equal(key.ArrowRight, true);
  assert.equal(Object.values(key).filter(Boolean).length, 1);
  pad.emit('pointerup', { clientX: 300 });
  assert.equal(key.ArrowRight, false);
  assert.equal(pad.hasPointerCapture(1), false);
});

for (const event of ['pointercancel', 'lostpointercapture']) {
  test(`${event} clears movement and permits another gesture`, () => {
    const { pad, key } = setup();
    pad.emit('pointerdown', { clientX: 0 });
    pad.emit(event);
    assert.equal(key.ArrowLeft, false);
    pad.emit('pointerdown', { pointerId: 2, clientY: 0 });
    assert.equal(key.ArrowUp, true);
  });
}

test('secondary pointer cannot steal or release steering; A still works', () => {
  const { pad, key, buttons, actions } = setup();
  pad.emit('pointerdown', { clientX: 0 });
  pad.emit('pointerdown', { pointerId: 2, clientX: 100 });
  pad.emit('pointermove', { pointerId: 2, clientX: 100 });
  pad.emit('pointerup', { pointerId: 2 });
  buttons[4].emit('pointerdown', { pointerId: 2 });
  assert.equal(key.ArrowLeft, true);
  assert.equal(key.ArrowRight, undefined);
  assert.deepEqual(actions, ['Action']);
});

test('keyboard and touch release independently and update held feedback', () => {
  const { pad, window, key, buttons } = setup();
  window.emit('keydown', { key: 'ArrowLeft', code: 'ArrowLeft' });
  pad.emit('pointerdown', { clientX: 0 });
  pad.emit('pointerup');
  assert.equal(key.ArrowLeft, true);
  assert.equal(buttons[2].held.has('is-held'), true);
  pad.emit('pointerdown', { clientX: 0 });
  window.emit('keyup', { key: 'ArrowLeft', code: 'ArrowLeft' });
  assert.equal(key.ArrowLeft, true);
  pad.emit('pointerup');
  assert.equal(key.ArrowLeft, false);
  assert.equal(buttons[2].held.has('is-held'), false);
});

test('blur, hidden document and pause reset clear held input and stale presses', () => {
  for (const reset of ['blur', 'hidden', 'pause']) {
    const s = setup();
    s.pad.emit('pointerdown', { clientY: 0 });
    s.window.emit('keydown', { key: 'ArrowRight', code: 'ArrowRight' });
    if (reset === 'blur') s.window.emit('blur');
    if (reset === 'hidden') { s.document.hidden = true; s.document.emit('visibilitychange'); }
    if (reset === 'pause') {
      assert.match(script, /function setPaused\(v\)\s*\{\s*paused = v;\s*resetControls\(\);/);
      vm.runInContext('resetControls()', s.context);
    }
    assert.ok(Object.values(s.key).every(v => !v));
    assert.ok(Object.values(s.pressed).every(v => !v));
    s.pad.emit('pointermove', { clientY: 0 });
    assert.equal(s.key.ArrowUp, false);
  }
});

test('keyboard auto-repeat does not retrigger actions', () => {
  const { window, actions } = setup();
  window.emit('keydown', { key: 'a', code: 'KeyA' });
  window.emit('keydown', { key: 'a', code: 'KeyA', repeat: true });
  assert.deepEqual(actions, ['Action']);
});
