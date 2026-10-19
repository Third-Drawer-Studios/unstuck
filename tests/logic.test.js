// Unit tests for Unstuck's decision core. Zero dependencies — node --test only.
// Run with ./test.sh (or `node --test tests/`).

const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../logic.js');

// --------------------------------------------------------------- fixtures

let seq = 0;
const item = (text, extra) => Object.assign(L.newItem(text), { id: 'i' + ++seq }, extra || {});

function list(name, kind, texts, extra) {
  const l = L.newList(name, kind, 'amber');
  l.id = 'l-' + name;
  l.items = texts.map((t) => (typeof t === 'string' ? item(t) : t));
  return Object.assign(l, extra || {});
}

/** Built from emptyState so these fixtures follow the real shape as it grows. */
function stateWith(lists, selection, history) {
  return Object.assign(L.emptyState(), { lists, selection: selection || [], history: history || [] });
}

/** Deterministic stand-in for Math.random: replays the given fractions. */
function rng(...values) {
  let i = 0;
  return () => values[i++ % values.length];
}

// ---------------------------------------------------------------- migrate

test('migrate rejects payloads that are not an Unstuck backup', () => {
  for (const bad of [null, undefined, 42, 'text', [], {}, { lists: 'nope' }, { lists: null }]) {
    assert.throws(() => L.migrate(bad), /not in the expected format/, 'accepted ' + JSON.stringify(bad));
  }
});

test('migrate coerces field types rather than trusting the file', () => {
  const out = L.migrate({
    lists: [{
      id: 'keep-me',
      name: 42,
      kind: 'endless',
      color: 'sky',
      items: [{ id: 'x', text: 'Thing', done: 'yes', doneAt: 'nope', count: '3', lastDone: 1700000000000 }],
    }],
  });
  const it = out.lists[0].items[0];
  assert.equal(out.lists[0].id, 'keep-me');
  assert.equal(out.lists[0].name, '42');
  assert.equal(it.done, true, 'truthy strings must become a real boolean');
  assert.equal(it.doneAt, 0, 'an unparseable number must fall back to 0, not NaN');
  assert.equal(it.count, 3, 'numeric strings must become numbers');
  assert.equal(it.lastDone, 1700000000000);
});

test('migrate falls back on unknown kinds and colours', () => {
  const out = L.migrate({ lists: [{ name: 'X', kind: 'wat', color: 'chartreuse', items: [] }] });
  assert.equal(out.lists[0].kind, 'once');
  assert.equal(out.lists[0].color, L.COLORS[0]);
});

test('migrate does not let a prototype-polluting kind through', () => {
  // A bare `KIND_LABEL[kind]` truthiness check would accept "constructor".
  const out = L.migrate({ lists: [{ name: 'X', kind: 'constructor', items: [] }] });
  assert.equal(out.lists[0].kind, 'once');
});

// A backup arrives from a file, which never met the edit fields' maxlength. These
// guard the gap: without the clamps, an imported list can hand the renderer a
// string or a row count nothing in the app could ever have produced.

test('migrate holds text to the length the edit fields allow', () => {
  const out = L.migrate({
    lists: [{
      name: 'n'.repeat(5000),
      items: [{ text: 't'.repeat(100000), subs: [{ text: 's'.repeat(100000) }] }],
    }],
  });
  assert.equal(out.lists[0].name.length, L.MAX_NAME_LENGTH);
  assert.equal(out.lists[0].items[0].text.length, L.MAX_TEXT_LENGTH);
  assert.equal(out.lists[0].items[0].subs[0].text.length, L.MAX_TEXT_LENGTH);
});

test('text already within the caps is left exactly as it was', () => {
  const out = L.migrate({ lists: [{ name: 'Chores', items: [{ text: 'Wash up' }] }] });
  assert.equal(out.lists[0].name, 'Chores', 'clamping may never trim an ordinary backup');
  assert.equal(out.lists[0].items[0].text, 'Wash up');
});

test('migrate bounds how many lists, items and steps a file can carry', () => {
  const subs = Array.from({ length: L.MAX_SUBS_PER_ITEM + 20 }, (_, i) => ({ text: 'step ' + i }));
  const items = Array.from({ length: L.MAX_ITEMS_PER_LIST + 20 }, (_, i) => ({ text: 'thing ' + i }));
  items[0].subs = subs;
  const lists = Array.from({ length: L.MAX_LISTS + 20 }, (_, i) => ({ name: 'List ' + i, items: [] }));
  lists[0].items = items;

  const out = L.migrate({ lists });
  assert.equal(out.lists.length, L.MAX_LISTS);
  assert.equal(out.lists[0].items.length, L.MAX_ITEMS_PER_LIST);
  assert.equal(out.lists[0].items[0].subs.length, L.MAX_SUBS_PER_ITEM);
});

test('junk is dropped before anything is counted, so real entries keep their place', () => {
  // The unusable entries lead, and there are more of them than the cap allows.
  // Counting first would spend the whole budget on them and lose every real list.
  const lists = Array.from({ length: L.MAX_LISTS + 5 }, () => null)
    .concat([{ name: 'Survivor', items: [] }]);
  const out = L.migrate({ lists });
  assert.equal(out.lists.length, 1);
  assert.equal(out.lists[0].name, 'Survivor');
});

test('a timer label is held to an item length too — it is an item text', () => {
  const out = L.migrate({ lists: [], timer: { duration: 60000, endsAt: 123, label: 'x'.repeat(9000) } });
  assert.equal(out.timer.label.length, L.MAX_TEXT_LENGTH);
});

test('a schema 1 to-do list keeps behaving exactly as it did', () => {
  const out = L.migrate({
    schema: 1,
    lists: [{ id: 'a', name: 'Chores', kind: 'todo', color: 'sky', items: [{ id: 'x', text: 'Wash up' }] }],
  });
  assert.deepEqual(
    { kind: out.lists[0].kind, keepDone: out.lists[0].keepDone, showProgress: out.lists[0].showProgress },
    { kind: 'once', keepDone: false, showProgress: false },
    'a to-do swept finished things away and showed what was left'
  );
  assert.equal(out.lists[0].items[0].text, 'Wash up', 'nothing in it may be lost');
});

test('a schema 1 collection keeps its record and its progress bar', () => {
  const out = L.migrate({
    schema: 1,
    lists: [{ id: 'b', name: 'Books', kind: 'checklist', color: 'rose', items: [{ id: 'y', text: 'Piranesi', done: true }] }],
  });
  assert.deepEqual(
    { kind: out.lists[0].kind, keepDone: out.lists[0].keepDone, showProgress: out.lists[0].showProgress },
    { kind: 'once', keepDone: true, showProgress: true },
    'a collection was exactly these two display choices switched on'
  );
  assert.equal(out.lists[0].items[0].done, true, 'checks must survive the migration');
});

test('a legacy kind cannot be overridden by stray display fields in the file', () => {
  // The old kind fully determined both, so a schema 1 payload's own flags are noise.
  const out = L.migrate({
    lists: [{ name: 'Books', kind: 'checklist', keepDone: false, showProgress: false, items: [] }],
  });
  assert.equal(out.lists[0].keepDone, true);
  assert.equal(out.lists[0].showProgress, true);
});

test('migrating twice changes nothing the second time', () => {
  const once = L.migrate({ schema: 1, lists: [{ name: 'Books', kind: 'checklist', items: [{ text: 'X' }] }] });
  assert.deepEqual(L.migrate(JSON.parse(JSON.stringify(once))), once, 'migration must be idempotent');
});

test('migrate drops items with no usable text and gives every item an id', () => {
  const out = L.migrate({
    lists: [{ name: 'X', items: [{ text: 'Real' }, { text: '   ' }, { text: '' }, { text: null }, 'junk', null] }],
  });
  assert.deepEqual(out.lists[0].items.map((i) => i.text), ['Real']);
  assert.ok(out.lists[0].items[0].id, 'a missing id must be generated');
});

test('migrate drops selection entries whose list is gone', () => {
  const out = L.migrate({
    lists: [{ id: 'a', name: 'A', items: [] }],
    selection: ['a', 'deleted-list', 7],
  });
  assert.deepEqual(out.selection, ['a']);
});

test('migrate caps history and keeps only the newest entries', () => {
  const history = Array.from({ length: 60 }, (_, i) => 'h' + i);
  const out = L.migrate({ lists: [], history });
  assert.equal(out.history.length, L.HISTORY_LIMIT);
  assert.equal(out.history[out.history.length - 1], 'h59', 'the newest entry must survive');
});

test('migrate survives a missing items array', () => {
  const out = L.migrate({ lists: [{ name: 'X' }] });
  assert.deepEqual(out.lists[0].items, []);
});

// ---------------------------------------------------------------- colours

test('normalizeHex accepts the forms people actually type', () => {
  assert.equal(L.normalizeHex('#4dd0c4'), '#4dd0c4');
  assert.equal(L.normalizeHex('4dd0c4'), '#4dd0c4', 'a missing hash is not a mistake worth rejecting');
  assert.equal(L.normalizeHex('#4DD0C4'), '#4dd0c4', 'case is normalised');
  assert.equal(L.normalizeHex('  #4dd0c4  '), '#4dd0c4');
  assert.equal(L.normalizeHex('#0f8'), '#00ff88', 'shorthand expands');
  assert.equal(L.normalizeHex('0f8'), '#00ff88');
});

test('normalizeHex refuses anything that is not a colour', () => {
  const bad = ['', '   ', 'red', '#12345', '#1234567', '#gggggg', 'rgb(1,2,3)', null, undefined, 42, {},
    '#fff;background:url(x)', 'var(--x)', 'javascript:alert(1)'];
  for (const value of bad) {
    assert.equal(L.normalizeHex(value), null, 'accepted ' + JSON.stringify(value));
  }
});

test('normalizeColor takes palette names and hexes, and nothing else', () => {
  assert.equal(L.normalizeColor('sky'), 'sky');
  assert.equal(L.normalizeColor('#0f8'), '#00ff88');
  assert.equal(L.normalizeColor('chartreuse'), null);
  assert.equal(L.normalizeColor('expression(alert(1))'), null);
});

test('a custom colour is distinguishable from a palette name', () => {
  assert.equal(L.isCustomColor('#00ff88'), true);
  assert.equal(L.isCustomColor('sky'), false);
  assert.equal(L.isCustomColor(undefined), false);
});

test('hsvToHex hits the primaries exactly', () => {
  assert.equal(L.hsvToHex(0, 1, 1), '#ff0000');
  assert.equal(L.hsvToHex(60, 1, 1), '#ffff00');
  assert.equal(L.hsvToHex(120, 1, 1), '#00ff00');
  assert.equal(L.hsvToHex(180, 1, 1), '#00ffff');
  assert.equal(L.hsvToHex(240, 1, 1), '#0000ff');
  assert.equal(L.hsvToHex(300, 1, 1), '#ff00ff');
  assert.equal(L.hsvToHex(360, 1, 1), '#ff0000', 'the wheel wraps');
});

test('hsvToHex handles the colourless cases', () => {
  assert.equal(L.hsvToHex(0, 0, 1), '#ffffff', 'no saturation is white');
  assert.equal(L.hsvToHex(200, 0.5, 0), '#000000', 'no brightness is black whatever the hue');
  assert.equal(L.hsvToHex(0, 0, 0.5), '#808080');
});

test('hsvToHex clamps rather than producing a broken colour', () => {
  assert.equal(L.hsvToHex(-60, 1, 1), '#ff00ff', 'a negative angle wraps round');
  assert.equal(L.hsvToHex(720, 1, 1), '#ff0000');
  assert.equal(L.hsvToHex(0, 5, 5), '#ff0000', 'out-of-range saturation and value clamp');
  assert.equal(L.hsvToHex(0, -1, -1), '#000000');
});

test('a colour survives the trip out to the wheel and back', () => {
  for (const hex of ['#4dd0c4', '#f4a13c', '#8b9cf7', '#00ff88', '#123456', '#ffffff', '#000000', '#7f7f7f']) {
    const hsv = L.hexToHsv(hex);
    assert.equal(L.hsvToHex(hsv.h, hsv.s, hsv.v), hex, hex + ' did not round-trip');
  }
});

test('hexToHsv refuses what is not a colour, and takes what normalizeHex takes', () => {
  assert.equal(L.hexToHsv('nonsense'), null);
  assert.equal(L.hexToHsv(''), null);
  assert.deepEqual(L.hexToHsv('#0f8'), L.hexToHsv('#00ff88'), 'shorthand is the same colour');
});

test('grey has no meaningful hue, and says so as zero', () => {
  const grey = L.hexToHsv('#808080');
  assert.equal(grey.s, 0, 'no saturation');
  assert.equal(grey.h, 0);
  const black = L.hexToHsv('#000000');
  assert.equal(black.v, 0);
  assert.equal(black.s, 0, 'saturation is undefined at zero brightness, not NaN');
});

test('migrate keeps a valid custom colour and normalises it', () => {
  const out = L.migrate({ lists: [{ name: 'X', color: '#FF5C8A', items: [] }] });
  assert.equal(out.lists[0].color, '#ff5c8a');
});

test('migrate refuses a colour that could leak into the stylesheet', () => {
  // This value reaches a CSS custom property, so a bad one must never survive.
  const out = L.migrate({
    lists: [{ name: 'X', color: '#fff; background-image: url(https://evil.example/pixel)', items: [] }],
  });
  assert.equal(out.lists[0].color, L.COLORS[0], 'fell back to a safe palette colour');
});

// ------------------------------------------------------------------ timer

test('a timer is stored as when it ends, so it survives a suspended tab', () => {
  const t = L.startTimer(30, 'Reading', 1000);
  assert.equal(t.duration, 1800000);
  assert.equal(t.endsAt, 1801000);
  assert.equal(t.label, 'Reading');
  // Ten minutes later, twenty remain — measured, not counted down.
  assert.equal(L.timerRemaining(t, 1000 + 600000), 1200000);
});

test('a timer never reports negative time, however late you look', () => {
  const t = L.startTimer(15, '', 0);
  assert.equal(L.timerRemaining(t, 900000), 0);
  assert.equal(L.timerRemaining(t, 999999999), 0);
  assert.equal(L.timerFinished(t, 999999999), true);
  assert.equal(L.timerFinished(t, 100), false);
});

test('startTimer refuses a length that is not one', () => {
  for (const bad of [0, -5, null, undefined, 'soon', NaN, {}]) {
    assert.equal(L.startTimer(bad, 'x', 0), null, 'accepted ' + JSON.stringify(bad));
  }
  assert.equal(L.startTimer(99999, 'x', 0).duration, 24 * 60 * 60000, 'absurd lengths are capped at a day');
});

test('pausing freezes the clock and resuming gives back exactly what was left', () => {
  const t = L.startTimer(10, 'x', 0);
  const paused = L.pauseTimer(t, 60000);
  assert.equal(L.timerRemaining(paused, 60000), 540000);
  // Five minutes pass in the real world; a paused timer must not notice.
  assert.equal(L.timerRemaining(paused, 360000), 540000);
  const resumed = L.resumeTimer(paused, 360000);
  assert.equal(L.timerRemaining(resumed, 360000), 540000);
  assert.equal(resumed.pausedAt, 0);
});

test('pausing twice, or resuming a running timer, changes nothing', () => {
  const t = L.startTimer(10, 'x', 0);
  const paused = L.pauseTimer(t, 1000);
  assert.deepEqual(L.pauseTimer(paused, 5000), paused);
  assert.deepEqual(L.resumeTimer(t, 5000), t);
});

test('adding time extends a running timer and restarts a finished one', () => {
  const t = L.startTimer(10, 'x', 0);
  const longer = L.extendTimer(t, 5, 60000);
  assert.equal(L.timerRemaining(longer, 60000), 840000, 'nine minutes left plus five');

  const done = L.startTimer(10, 'x', 0);
  const revived = L.extendTimer(done, 5, 900000);
  assert.equal(L.timerRemaining(revived, 900000), 300000, 'a finished timer restarts from now');
});

test('normalizeTimer keeps a usable timer and drops a broken one', () => {
  const good = { duration: 1000, endsAt: 5000, label: 'x', pausedAt: 0 };
  assert.deepEqual(L.normalizeTimer(good), good);
  for (const bad of [null, undefined, 'timer', {}, { duration: 0, endsAt: 5 }, { duration: 'ten', endsAt: 5 },
    { duration: 5, endsAt: 'later' }]) {
    assert.equal(L.normalizeTimer(bad), null, 'accepted ' + JSON.stringify(bad));
  }
});

test('formatClock counts in minutes, and only shows hours when there are some', () => {
  assert.equal(L.formatClock(0), '0:00');
  assert.equal(L.formatClock(1000), '0:01');
  assert.equal(L.formatClock(59000), '0:59');
  assert.equal(L.formatClock(60000), '1:00');
  assert.equal(L.formatClock(1800000), '30:00');
  assert.equal(L.formatClock(3600000), '1:00:00');
  assert.equal(L.formatClock(-5000), '0:00', 'overdue reads as zero, not backwards');
  assert.equal(L.formatClock(1500), '0:02', 'a part-second still counts as remaining');
});

test('formatMinutes reads the way a person would say it', () => {
  assert.equal(L.formatMinutes(0), 'Off');
  assert.equal(L.formatMinutes(15), '15 min');
  assert.equal(L.formatMinutes(60), '1 hour');
  assert.equal(L.formatMinutes(90), '1 hour 30 min');
  assert.equal(L.formatMinutes(120), '2 hours');
});

test('formatMinutesShort trims the same length down to chip width', () => {
  // Five chips have to sit across a phone, so the hour spells out as "hr".
  assert.equal(L.formatMinutesShort(0), 'Off');
  assert.equal(L.formatMinutesShort(45), '45 min');
  assert.equal(L.formatMinutesShort(60), '1 hr');
  assert.equal(L.formatMinutesShort(90), '1 hr 30');
  assert.equal(L.formatMinutesShort(120), '2 hr');
});

test('a list carries its own standing timer length, validated', () => {
  assert.equal(L.newList('A', 'once', 'sky', { timerMinutes: 30 }).timerMinutes, 30);
  assert.equal(L.newList('A', 'once', 'sky').timerMinutes, 0, 'no timer is the default');
  assert.equal(L.normalizeTimerMinutes('45'), 45);
  assert.equal(L.normalizeTimerMinutes(-5), 0);
  assert.equal(L.normalizeTimerMinutes('soon'), 0);
  assert.equal(L.migrate({ lists: [{ name: 'X', timerMinutes: 20, items: [] }] }).lists[0].timerMinutes, 20);
});

// --------------------------------------------------------------- settings

test('settings fall back to safe defaults rather than trusting the file', () => {
  assert.deepEqual(L.normalizeSettings(), L.DEFAULT_SETTINGS);
  assert.deepEqual(L.normalizeSettings('nonsense'), L.DEFAULT_SETTINGS);
  assert.deepEqual(L.normalizeSettings({
    textScale: 'huge', contrast: 'weird', motion: 'spin', speak: 'yes', accent: 'chartreuse',
  }), { textScale: 'normal', contrast: 'auto', motion: 'auto', speak: true, accent: 'amber', listSort: 'added' });
});

test('settings that are valid are kept as they are', () => {
  const wanted = {
    textScale: 'larger', contrast: 'high', motion: 'reduced', speak: true, accent: 'teal', listSort: 'az',
  };
  assert.deepEqual(L.normalizeSettings(wanted), wanted);
  assert.equal(L.normalizeSettings({ accent: '#00FF88' }).accent, '#00ff88', 'a custom accent too');
  assert.equal(L.normalizeSettings({ accent: 'rgb(0,255,136)' }).accent, 'amber', 'only what the app stores');
  // Contrast follows the phone by default, and says so rather than guessing normal.
  assert.equal(L.normalizeSettings({ contrast: 'auto' }).contrast, 'auto');
  assert.equal(L.normalizeSettings({ contrast: 'normal' }).contrast, 'normal');
});

test('contrast maths match the WCAG figures they claim to be', () => {
  assert.equal(Math.round(L.contrastRatio('#ffffff', '#000000')), 21, 'the extremes');
  assert.equal(L.contrastRatio('#123456', '#123456'), 1, 'a colour against itself is invisible');
  assert.equal(L.luminance('#ffffff'), 1);
  assert.equal(L.luminance('#000000'), 0);
  assert.equal(L.contrastRatio('#ffffff', 'not a colour'), null, 'refused, not guessed');
});

test('a list colour too dark to read is lifted, keeping its hue', () => {
  const surface = '#1d222b';
  // The colour wheel's brightness slider reaches black, and the colour is used as
  // text: this is the case that put an unreadable label on the pick card.
  const lifted = L.readableOn('#101010', surface, 4.5);
  assert.ok(L.contrastRatio(lifted, surface) >= 4.5, 'got ' + L.contrastRatio(lifted, surface));

  const dark = L.readableOn('#3a0d0d', surface, 4.5);
  assert.ok(L.contrastRatio(dark, surface) >= 4.5);
  assert.equal(Math.round(L.hexToHsv(dark).h), Math.round(L.hexToHsv('#3a0d0d').h), 'the hue is what was chosen');

  const fine = '#5cb8f5';
  assert.equal(L.readableOn(fine, surface, 4.5), fine, 'a colour that already reads is left alone');
  assert.equal(L.readableOn('nope', surface, 4.5), null, 'refused, not guessed');
});

test('an accent carries its own gradient ends and its own ink', () => {
  const amber = '#f4a13c';
  const lit = L.shade(amber, 0.72, 1.06);
  const deep = L.shade(amber, 1.08, 0.82);
  assert.ok(L.luminance(lit) > L.luminance(amber), 'the top of the gradient is the lighter end');
  assert.ok(L.luminance(deep) < L.luminance(amber), 'and the bottom is the darker one');
  assert.equal(Math.round(L.hexToHsv(lit).h), Math.round(L.hexToHsv(amber).h), 'same hue throughout');
  assert.equal(L.shade('not a colour', 1, 1), null, 'refused, not guessed');

  // Ink has to be readable on whatever the accent turns out to be, either end.
  for (const accent of [amber, '#0d0d10', '#ffffff', '#4dd0c4', '#3a0d0d']) {
    const ink = L.inkOn(accent);
    assert.ok(L.contrastRatio(ink, accent) >= 4.5,
      accent + ' would carry text at ' + L.contrastRatio(ink, accent).toFixed(2) + ':1');
  }
  assert.equal(L.inkOn('nope'), null);
});

test('every palette colour is already legible on a card', () => {
  // The palette lives in the stylesheet, so this reads it there: a new swatch too
  // dark to read as text would otherwise only show up on someone's phone.
  const css = require('node:fs').readFileSync(require('node:path').join(__dirname, '../index.html'), 'utf8');
  for (const name of L.COLORS) {
    const match = css.match(new RegExp('\\.c-' + name + '\\s*{\\s*--list-color:\\s*(#[0-9a-f]{6})'));
    assert.ok(match, name + ' must be defined in the stylesheet');
    assert.ok(L.contrastRatio(match[1], '#1d222b') >= 4.5,
      name + ' reads at ' + L.contrastRatio(match[1], '#1d222b').toFixed(2) + ' on a card');
  }
});

test('every text scale is a real multiplier', () => {
  for (const [name, scale] of Object.entries(L.TEXT_SCALES)) {
    assert.ok(scale >= 1 && scale <= 2, name + ' has an unusable scale: ' + scale);
  }
  assert.equal(L.TEXT_SCALES.normal, 1);
});

test('a state with settings and a running timer round-trips through migrate', () => {
  const s = L.emptyState();
  s.settings = {
    textScale: 'large', contrast: 'high', motion: 'full', speak: true, accent: '#4dd0c4', listSort: 'fewest',
  };
  s.timer = { duration: 60000, endsAt: 123456, label: 'Reading', pausedAt: 0 };
  assert.deepEqual(L.migrate(JSON.parse(JSON.stringify(s))), s);
});

test('an older save with no settings or timer still loads', () => {
  const out = L.migrate({ schema: 1, lists: [{ name: 'X', kind: 'todo', items: [] }] });
  assert.deepEqual(out.settings, L.DEFAULT_SETTINGS);
  assert.equal(out.timer, null);
  assert.equal(out.lists[0].timerMinutes, 0);
});

// ------------------------------------------------------------------- pool

test('an endless list keeps its items in the pool even when flagged done', () => {
  const endless = list('Ongoing', 'endless', [item('Guitar', { done: true, count: 4 })]);
  assert.equal(L.isPickable(endless, endless.items[0]), true);
  assert.equal(L.pickableCount(endless), 1);
});

test('a check-off list drops done items from the pool however it displays them', () => {
  // The display choices must be invisible to the picker — that is the whole
  // reason they stopped being separate kinds.
  for (const display of [{}, { keepDone: true }, { showProgress: true }, { keepDone: true, showProgress: true }]) {
    const l = list('L', 'once', [item('open'), item('closed', { done: true })], display);
    assert.equal(L.pickableCount(l), 1, 'counted a done item with ' + JSON.stringify(display));
    assert.equal(L.isPickable(l, l.items[1]), false);
  }
});

test('an empty selection means every list is in play', () => {
  const s = stateWith([list('A', 'once', ['a1']), list('B', 'once', ['b1'])]);
  assert.equal(L.activeLists(s).length, 2);
  assert.equal(L.pool(s).length, 2);
});

test('a selection scopes the pool to the chosen lists only', () => {
  const a = list('A', 'once', ['a1', 'a2']);
  const b = list('B', 'once', ['b1']);
  const s = stateWith([a, b], [b.id]);
  assert.deepEqual(L.pool(s).map((c) => c.item.text), ['b1']);
});

test('pool entries carry the list they came from', () => {
  const s = stateWith([list('Books', 'once', ['Piranesi'])]);
  assert.equal(L.pool(s)[0].list.name, 'Books');
});

// -------------------------------------------------------------- list sort

/** Named for what each sort should do to them: three sizes, three names. */
const sortFixtures = () => [
  list('Chores', 'once', ['a', 'b', 'c']),
  list('apples', 'once', ['a']),
  list('Books', 'once', ['a', 'b']),
];

const names = (rows) => rows.map((l) => l.name);

test('sorting by name ignores case and reverses cleanly', () => {
  assert.deepEqual(names(L.sortLists(sortFixtures(), 'az')), ['apples', 'Books', 'Chores']);
  assert.deepEqual(names(L.sortLists(sortFixtures(), 'za')), ['Chores', 'Books', 'apples']);
});

test('sorting by size counts what is left to pick, both ways round', () => {
  assert.deepEqual(names(L.sortLists(sortFixtures(), 'most')), ['Chores', 'Books', 'apples']);
  assert.deepEqual(names(L.sortLists(sortFixtures(), 'fewest')), ['apples', 'Books', 'Chores']);
});

test('a size sort counts the pool, not the items', () => {
  // Two things each, but one is checked off — so this list is the smaller one.
  // Named so that counting items instead would tie, and the name tie-break would
  // then put them the other way round.
  const done = list('Almost done', 'once', [item('x'), item('y', { done: true })]);
  const open = list('Busy', 'once', ['x', 'y']);
  assert.deepEqual(names(L.sortLists([done, open], 'most')), ['Busy', 'Almost done']);
});

test('lists of equal size fall back to their names, so the grid cannot shuffle', () => {
  const rows = [list('Zebra', 'once', ['a']), list('Ant', 'once', ['a'])];
  assert.deepEqual(names(L.sortLists(rows, 'most')), ['Ant', 'Zebra']);
  assert.deepEqual(names(L.sortLists(rows, 'fewest')), ['Ant', 'Zebra']);
});

test('an ongoing list counts every item, however many are flagged done', () => {
  const endless = list('Ongoing', 'endless', [item('a', { done: true }), item('b', { done: true })]);
  const once = list('Check off', 'once', ['a']);
  assert.deepEqual(names(L.sortLists([once, endless], 'most')), ['Ongoing', 'Check off']);
});

test('"as added" and anything unrecognised leave the stored order alone', () => {
  for (const mode of ['added', 'sideways', '', null, undefined]) {
    assert.deepEqual(names(L.sortLists(sortFixtures(), mode)), ['Chores', 'apples', 'Books'],
      'reordered under ' + JSON.stringify(mode));
  }
});

test('sortLists returns a copy, so the stored order survives every sort', () => {
  const rows = sortFixtures();
  const sorted = L.sortLists(rows, 'az');
  assert.notEqual(sorted, rows);
  assert.deepEqual(names(rows), ['Chores', 'apples', 'Books']);
  assert.deepEqual(names(L.sortLists([], 'az')), []);
});

test('every sort the settings accept is one the picker offers a name for', () => {
  for (const mode of Object.keys(L.LIST_SORTS)) {
    assert.equal(L.normalizeSettings({ listSort: mode }).listSort, mode);
    assert.equal(typeof L.LIST_SORTS[mode], 'string');
  }
  assert.equal(L.normalizeSettings({ listSort: 'sideways' }).listSort, 'added');
});

// ------------------------------------------------------------------ search

const searchFixtures = () => [
  list('Admin', 'once', [item('Pay that bill'), withSubs(item('Get the car serviced'), 'Sign up for an account')]),
  list('Around the house', 'once', [item('Wash up'), item('Sign the form')]),
];

test('folding a string for search drops case, accents and repeated spaces', () => {
  assert.equal(L.foldForSearch('  Café   AU  Lait ').text, 'cafe au lait');
  assert.equal(L.foldForSearch('').text, '');
  assert.equal(L.foldForSearch('   ').text, '', 'whitespace alone is not a search');
  assert.equal(L.foldForSearch(null).text, '');
});

test('a match maps back to where it sits in the original text', () => {
  // The fold is shorter than the original here — two spaces became one, and the
  // accent decomposed — so an index taken from the folded string would be wrong.
  const range = L.matchRange('Book a  café table', 'cafe');
  assert.deepEqual(range, { start: 8, end: 12 });
  assert.equal('Book a  café table'.slice(range.start, range.end), 'café');
});

test('a match that runs to the end of the text still has an end', () => {
  const range = L.matchRange('Wash up', 'up');
  assert.deepEqual(range, { start: 5, end: 7 });
});

test('matchRange refuses what is not in there, and refuses an empty query', () => {
  assert.equal(L.matchRange('Wash up', 'dishes'), null);
  assert.equal(L.matchRange('Wash up', ''), null);
  assert.equal(L.matchRange('Wash up', '   '), null, 'spaces must not match everything');
});

test('a search says which list a thing is on', () => {
  const groups = L.searchLists(searchFixtures(), 'sign up for');
  assert.equal(groups.length, 1, 'only one list has it');
  assert.equal(groups[0].list.name, 'Admin');
  assert.equal(groups[0].hits.length, 1);
  assert.equal(groups[0].hits[0].text, 'Sign up for an account');
});

test('a step is findable, and names the thing it is a step of', () => {
  const hit = L.searchLists(searchFixtures(), 'account')[0].hits[0];
  assert.equal(hit.subId !== null, true, 'the hit must point at the step itself');
  assert.equal(hit.parent, 'Get the car serviced');
});

test('a thing standing on its own carries no parent', () => {
  const hit = L.searchLists(searchFixtures(), 'wash up')[0].hits[0];
  assert.equal(hit.subId, null);
  assert.equal(hit.parent, null);
});

test('one query can land in several lists at once', () => {
  const groups = L.searchLists(searchFixtures(), 'sign');
  assert.deepEqual(groups.map((g) => g.list.name), ['Admin', 'Around the house']);
  assert.equal(L.countMatches(groups), 2, 'both the step and the item must count');
});

test('a list whose own name matches is offered even with nothing in it that does', () => {
  const groups = L.searchLists(searchFixtures(), 'around the house');
  assert.equal(groups.length, 1);
  assert.equal(groups[0].nameMatch, true);
  assert.deepEqual(groups[0].hits, [], 'nothing in it says "around the house"');
});

test('a list matched only through its contents is not marked as a name match', () => {
  assert.equal(L.searchLists(searchFixtures(), 'wash up')[0].nameMatch, false);
});

test('finished things are still findable — checking one off does not hide it', () => {
  const rows = [list('Done pile', 'once', [item('Sign up for an account', { done: true })])];
  const hit = L.searchLists(rows, 'sign up')[0].hits[0];
  assert.equal(hit.done, true, 'the result has to be able to show it as checked off');
});

test('an empty query finds nothing rather than everything', () => {
  for (const query of ['', '   ', null, undefined]) {
    assert.deepEqual(L.searchLists(searchFixtures(), query), [],
      'returned results for ' + JSON.stringify(query));
  }
});

test('results keep the order they were handed, so a sort upstream holds', () => {
  const rows = L.sortLists(searchFixtures(), 'za');
  assert.deepEqual(L.searchLists(rows, 'sign').map((g) => g.list.name),
    ['Around the house', 'Admin']);
});

test('countMatches counts the things found, not the lists they were found in', () => {
  assert.equal(L.countMatches([]), 0);
  // Two lists, three hits — a count of lists would read 2 and a count of groups
  // with any hit would read 2 as well, so only the real tally passes here.
  const rows = [
    list('Admin', 'once', [item('Sign the form'), withSubs(item('Renew it'), 'Sign in first')]),
    list('House', 'once', [item('Sign for the parcel')]),
  ];
  assert.equal(L.countMatches(L.searchLists(rows, 'sign')), 3);
});

test('a list found by its own name counts as one of the matches', () => {
  // Otherwise a search that put a row on the screen reports finding nothing.
  const rows = [list('Signatures', 'once', [item('Wash up')])];
  assert.equal(L.countMatches(L.searchLists(rows, 'sign')), 1);
  // And it is counted alongside the things inside, not instead of them.
  const both = [list('Signatures', 'once', [item('Sign the form')])];
  assert.equal(L.countMatches(L.searchLists(both, 'sign')), 2);
});

test('listById returns null for an unknown id rather than undefined', () => {
  assert.equal(L.listById(stateWith([]), 'nope'), null);
});

// ------------------------------------------------------------------- pick

test('recentDepth scales with pool size and never exceeds its cap', () => {
  assert.equal(L.recentDepth(0), 0);
  assert.equal(L.recentDepth(1), 0);
  assert.equal(L.recentDepth(2), 1);
  assert.equal(L.recentDepth(7), 3);
  assert.equal(L.recentDepth(500), 5);
});

test('chooseFrom returns null for an empty pool', () => {
  assert.equal(L.chooseFrom([], new Set(), []), null);
});

test('a one-item pool still picks that item even though it fills history', () => {
  // Regression: recentDepth is 0 here and history.slice(-0) returns the WHOLE
  // history, which would filter the only candidate out.
  const l = list('Solo', 'once', ['The only thing']);
  const all = L.pool(stateWith([l]));
  const history = Array(10).fill(l.items[0].id);
  const drawn = L.chooseFrom(all, new Set(), history, rng(0));
  assert.ok(drawn, 'must not refuse to pick');
  assert.equal(drawn.choice.item.text, 'The only thing');
});

test('chooseFrom skips items already offered in this reroll run', () => {
  const l = list('A', 'once', ['one', 'two', 'three']);
  const all = L.pool(stateWith([l]));
  const shown = new Set([all[0].item.id, all[1].item.id]);
  const drawn = L.chooseFrom(all, shown, [], rng(0));
  assert.equal(drawn.choice.item.text, 'three');
  assert.equal(drawn.exhausted, false);
});

test('chooseFrom reports exhaustion and still picks once everything was shown', () => {
  const l = list('A', 'once', ['one', 'two']);
  const all = L.pool(stateWith([l]));
  const shown = new Set(all.map((c) => c.item.id));
  const drawn = L.chooseFrom(all, shown, [], rng(0));
  assert.equal(drawn.exhausted, true, 'the caller needs this to reset the run');
  assert.ok(drawn.choice, 'must never stall when every item has been seen');
});

test('chooseFrom avoids the recent history when fresh candidates exist', () => {
  const l = list('A', 'once', ['one', 'two', 'three', 'four']);
  const all = L.pool(stateWith([l]));
  // depth for a pool of 4 is 2, so the last two ids are off-limits.
  const history = [all[0].item.id, all[1].item.id];
  for (const r of [0, 0.4, 0.9]) {
    const drawn = L.chooseFrom(all, new Set(), history, rng(r));
    assert.ok(['three', 'four'].includes(drawn.choice.item.text), 'picked a recent item: ' + drawn.choice.item.text);
  }
});

test('chooseFrom ignores history when avoiding it would leave nothing', () => {
  const l = list('A', 'once', ['one', 'two']);
  const all = L.pool(stateWith([l]));
  const history = all.map((c) => c.item.id);
  const drawn = L.chooseFrom(all, new Set(), history, rng(0.99));
  assert.ok(drawn.choice, 'a fully-recent pool must still yield a pick');
});

test('chooseFrom still picks when every remaining candidate is also recent', () => {
  // Rerolled past one and two, and three and four were the two most recent
  // picks — every survivor is disqualified, so the recency rule must yield.
  const l = list('A', 'once', ['one', 'two', 'three', 'four']);
  const all = L.pool(stateWith([l]));
  const shown = new Set([all[0].item.id, all[1].item.id]);
  const history = [all[2].item.id, all[3].item.id];
  for (const r of [0, 0.99]) {
    const drawn = L.chooseFrom(all, shown, history, rng(r));
    assert.ok(drawn.choice, 'must not return an empty pick');
    assert.ok(['three', 'four'].includes(drawn.choice.item.text), 'got ' + drawn.choice.item.text);
  }
});

test('chooseFrom uses the injected randomness across the whole candidate set', () => {
  const l = list('A', 'once', ['one', 'two', 'three', 'four']);
  const all = L.pool(stateWith([l]));
  assert.equal(L.chooseFrom(all, new Set(), [], rng(0)).choice.item.text, 'one');
  assert.equal(L.chooseFrom(all, new Set(), [], rng(0.99)).choice.item.text, 'four');
  assert.equal(L.chooseFrom(all, new Set(), [], rng(0.5)).choice.item.text, 'three');
});

test('chooseFrom draws across every selected list, not just the first', () => {
  const s = stateWith([list('A', 'once', ['a1']), list('B', 'endless', ['b1'])]);
  const all = L.pool(s);
  const names = new Set();
  for (const r of [0, 0.99]) names.add(L.chooseFrom(all, new Set(), [], rng(r)).choice.list.name);
  assert.deepEqual([...names].sort(), ['A', 'B']);
});

test('pushHistory appends and trims to the newest entries', () => {
  assert.deepEqual(L.pushHistory(['a'], 'b'), ['a', 'b']);
  const full = Array.from({ length: L.HISTORY_LIMIT }, (_, i) => 'h' + i);
  const next = L.pushHistory(full, 'newest');
  assert.equal(next.length, L.HISTORY_LIMIT);
  assert.equal(next[next.length - 1], 'newest');
  assert.equal(next[0], 'h1', 'the oldest entry must fall off the front');
});

test('pushHistory does not mutate the array it was given', () => {
  const before = ['a'];
  L.pushHistory(before, 'b');
  assert.deepEqual(before, ['a']);
});

// ---------------------------------------------------------------- strings

test('plural switches on exactly one', () => {
  assert.equal(L.plural(0, 'thing', 'things'), '0 things');
  assert.equal(L.plural(1, 'thing', 'things'), '1 thing');
  assert.equal(L.plural(2, 'thing', 'things'), '2 things');
});

test('relativeDay names the near past and falls back to a date', () => {
  const now = new Date(2026, 7, 4, 13, 0, 0).getTime();
  const daysAgo = (n, hour) => new Date(2026, 7, 4 - n, hour === undefined ? 9 : hour).getTime();
  assert.equal(L.relativeDay(0, now), '', 'no timestamp means no text');
  assert.equal(L.relativeDay(daysAgo(0, 1), now), 'today', 'earlier the same day is still today');
  assert.equal(L.relativeDay(daysAgo(1), now), 'yesterday');
  assert.equal(L.relativeDay(daysAgo(3), now), '3 days ago');
  assert.equal(L.relativeDay(daysAgo(6), now), '6 days ago');
  assert.equal(L.relativeDay(daysAgo(8), now), 'last week');
  assert.ok(/\d/.test(L.relativeDay(daysAgo(60), now)), 'older than a fortnight shows a date');
});

test('relativeDay treats a future timestamp as today rather than a negative count', () => {
  const now = new Date(2026, 7, 4, 13, 0, 0).getTime();
  assert.equal(L.relativeDay(new Date(2026, 7, 9).getTime(), now), 'today');
});

test('backupFileName dates the file by the local day, not the UTC one', () => {
  // An evening export west of UTC, or an early one east of it, is on a different
  // UTC day; whichever side the test machine is on, one of these two catches it.
  assert.equal(L.backupFileName(new Date(2026, 9, 18, 23, 45)), 'unstuck-backup-2026-10-18.json');
  assert.equal(L.backupFileName(new Date(2026, 9, 18, 0, 15)), 'unstuck-backup-2026-10-18.json');
  assert.equal(L.backupFileName(new Date(2026, 0, 5, 12)), 'unstuck-backup-2026-01-05.json', 'month and day are padded');
});

test('listSummary reads as what is left, or as progress, on request', () => {
  assert.equal(L.listSummary(list('E', 'once', [])), 'Empty');
  assert.equal(L.listSummary(list('T', 'once', [item('a'), item('b', { done: true })])), '1 thing left');
  assert.equal(L.listSummary(list('T', 'once', [item('a', { done: true })])), 'All done');
  assert.equal(
    L.listSummary(list('C', 'once', [item('a', { done: true }), item('b')], { showProgress: true })),
    '1 of 2 done'
  );
  assert.equal(
    L.listSummary(list('O', 'endless', [item('a', { count: 2 }), item('b', { count: 1 })])),
    '2 things · 3 sessions logged'
  );
});

test('the summary style is independent of where finished items go', () => {
  const items = () => [item('a', { done: true }), item('b')];
  // Sweeping finished things away while still reading as progress, and vice versa.
  assert.equal(L.listSummary(list('X', 'once', items(), { keepDone: false, showProgress: true })), '1 of 2 done');
  assert.equal(L.listSummary(list('Y', 'once', items(), { keepDone: true, showProgress: false })), '1 thing left');
});

test('cardMeta explains where the picked item sits in its list', () => {
  const now = new Date(2026, 7, 4).getTime();
  const todo = list('T', 'once', [item('a'), item('b'), item('c', { done: true })]);
  assert.equal(L.cardMeta(todo, todo.items[0], now), '2 things left in this list.');

  const books = list('C', 'once', [item('a', { done: true }), item('b')], { showProgress: true });
  assert.equal(L.cardMeta(books, books.items[1], now), '1 of 2 checked off so far.');

  const fresh = list('O', 'endless', [item('guitar')]);
  assert.equal(L.cardMeta(fresh, fresh.items[0], now), 'You have not logged this one yet.');

  const logged = list('O', 'endless', [item('guitar', { count: 1, lastDone: new Date(2026, 7, 3).getTime() })]);
  assert.equal(L.cardMeta(logged, logged.items[0], now), 'Done 1 time · last yesterday');
});

// --------------------------------------------------------- starter lists

test('every starter list is valid enough to save and pick from', () => {
  assert.ok(L.STARTER_LISTS.length >= 4, 'the picker needs a real choice');
  const names = new Set();
  for (const spec of L.STARTER_LISTS) {
    assert.ok(spec.name && spec.name.trim(), 'a starter list has no name');
    assert.equal(names.has(spec.name), false, 'duplicate starter name: ' + spec.name);
    names.add(spec.name);
    assert.ok(Object.prototype.hasOwnProperty.call(L.KIND_LABEL, spec.kind), spec.name + ' has kind ' + spec.kind);
    assert.ok(L.COLORS.includes(spec.color), spec.name + ' has colour ' + spec.color);
    assert.ok(Array.isArray(spec.items), spec.name + ' has no items array');
    for (const text of spec.items) assert.ok(text.trim(), spec.name + ' has a blank suggestion');
  }
});

test('the starter set covers both kinds and both display styles', () => {
  const kinds = new Set(L.STARTER_LISTS.map((s) => s.kind));
  assert.deepEqual([...kinds].sort(), ['endless', 'once']);
  assert.ok(L.STARTER_LISTS.some((s) => s.keepDone), 'one should keep a record');
  assert.ok(L.STARTER_LISTS.some((s) => s.kind === 'once' && !s.keepDone), 'one should sweep finished things away');
  assert.ok(L.STARTER_LISTS.some((s) => s.showProgress), 'one should read as progress');
});

test('listFromStarter builds a real, independent list', () => {
  const spec = L.STARTER_LISTS.find((s) => s.items.length);
  const a = L.listFromStarter(spec);
  const b = L.listFromStarter(spec);
  assert.equal(a.name, spec.name);
  assert.equal(a.kind, spec.kind);
  assert.deepEqual(a.items.map((i) => i.text), spec.items);
  assert.notEqual(a.id, b.id, 'two copies must not share an id');
  assert.notEqual(a.items[0].id, b.items[0].id, 'two copies must not share item ids');
  a.items[0].done = true;
  assert.equal(spec.items.includes(a.items[0]), false, 'the template must not be mutable through its copies');
});

test('a starter list survives the save/load round-trip unchanged', () => {
  const lists = L.STARTER_LISTS.map(L.listFromStarter);
  const s = Object.assign(L.emptyState(), { lists });
  assert.deepEqual(L.migrate(JSON.parse(JSON.stringify(s))), s);
});

// ------------------------------------------------- done and count in step

test('checking something off counts as one completion', () => {
  const it = item('read it');
  L.setDone(it, true, 1000);
  assert.equal(it.done, true);
  assert.equal(it.count, 1, 'an ongoing view must not read zero for a checked item');
  assert.equal(it.lastDone, 1000);
});

test('a checked item shows one session once the list becomes ongoing', () => {
  const l = list('Books', 'once', [item('Piranesi')]);
  L.setDone(l.items[0], true, 1000);
  l.kind = 'endless';
  assert.equal(L.cardMeta(l, l.items[0], 1000), 'Done 1 time · last today');
  assert.equal(L.listSummary(l), '1 thing · 1 session logged');
});

test('unchecking withdraws the completion the check implied', () => {
  const it = item('read it');
  L.setDone(it, true, 1000);
  L.setDone(it, false, 2000);
  assert.equal(it.done, false);
  assert.equal(it.count, 0, 'the implied session must go with the check');
  assert.equal(it.lastDone, 0);
});

test('unchecking never destroys a tally built from real sessions', () => {
  const it = item('guitar');
  for (let i = 0; i < 10; i++) L.logSession(it, 1000 + i);
  L.setDone(it, false, 3000);
  assert.equal(it.done, false);
  assert.equal(it.count, 10, 'ten logged sessions must survive an uncheck');
});

test('logging a session also marks it finished for the check views', () => {
  const it = item('guitar');
  L.logSession(it, 1000);
  assert.equal(it.count, 1);
  assert.equal(it.done, true, 'switching to a check view must show it checked');
  assert.equal(it.doneAt, 1000);
});

test('the full journey: check, switch to ongoing, log up to ten, switch back', () => {
  const l = list('Practice', 'once', [item('guitar')]);
  const it = l.items[0];

  L.setDone(it, true, 1000);
  assert.equal(L.pickableCount(l), 0, 'checked, so out of the pool');

  l.kind = 'endless';
  assert.equal(it.count, 1, 'the check reads as one session');
  assert.equal(L.pickableCount(l), 1, 'ongoing items are always pickable');

  for (let i = 2; i <= 10; i++) L.logSession(it, 1000 + i);
  assert.equal(it.count, 10);

  l.kind = 'once';
  assert.equal(it.done, true, 'ten sessions means it has certainly been done');
  assert.equal(L.pickableCount(l), 0);

  l.kind = 'endless';
  assert.equal(it.count, 10, 'the tally must come back intact');
  assert.equal(L.cardMeta(l, it, 1010).startsWith('Done 10 times'), true);
});

test('a never-touched item stays at zero under every kind', () => {
  const l = list('Fresh', 'once', [item('untouched')]);
  for (const kind of ['once', 'endless']) {
    l.kind = kind;
    assert.equal(L.pickableCount(l), 1, 'must stay pickable as ' + kind);
  }
  assert.equal(l.items[0].count, 0);
  assert.equal(l.items[0].done, false);
});

// ----------------------------------------------------------- kind changes

test('switching a list to ongoing returns its checked items to the pool', () => {
  const l = list('Books', 'once', [item('read it', { done: true, doneAt: 123 }), item('unread')]);
  assert.equal(L.pickableCount(l), 1);
  l.kind = 'endless';
  assert.equal(L.pickableCount(l), 2, 'an ongoing list has no unpickable items');
});

test('switching back from ongoing restores the checks exactly', () => {
  const l = list('Books', 'once', [item('read it', { done: true, doneAt: 123 }), item('unread')]);
  l.kind = 'endless';
  l.kind = 'once';
  assert.equal(L.pickableCount(l), 1, 'the check must survive the round trip');
  assert.equal(l.items[0].doneAt, 123, 'when it was done must survive too');
});

test('session counts survive a switch away from ongoing and back', () => {
  const l = list('Keep', 'endless', [item('guitar', { count: 7, lastDone: 999 })]);
  l.kind = 'once';
  assert.equal(l.items[0].count, 7);
  l.kind = 'endless';
  assert.equal(L.cardMeta(l, l.items[0], 999).startsWith('Done 7 times'), true);
});

test('a list reads correctly under each kind without touching its items', () => {
  const l = list('Mixed', 'once', [item('a', { done: true, count: 2 }), item('b')]);
  const snapshot = JSON.stringify(l.items);
  const summaries = {};

  summaries.left = L.listSummary(l);
  l.showProgress = true;
  summaries.progress = L.listSummary(l);
  l.kind = 'endless';
  summaries.ongoing = L.listSummary(l);

  assert.equal(JSON.stringify(l.items), snapshot, 'reading a list must never mutate it');
  assert.deepEqual(summaries, {
    left: '1 thing left',
    progress: '1 of 2 done',
    ongoing: '2 things · 2 sessions logged',
  });
});

// -------------------------------------------------------------- subtasks

const withSubs = (it, ...texts) => {
  it.subs = texts.map((t) => L.newSub(t));
  return it;
};

test('migrate coerces subtasks and drops the unusable ones', () => {
  const out = L.migrate({
    lists: [{
      name: 'X', kind: 'once',
      items: [{
        text: 'Sort the pile',
        subs: [
          { id: 's1', text: 'Clothes away', done: 'yes' },
          { text: '   ' },
          null,
          'not an object',
          { text: 42 },
        ],
      }],
    }],
  });
  const subs = out.lists[0].items[0].subs;
  assert.equal(subs.length, 2, 'blank, null and non-object steps must be dropped');
  assert.deepEqual(subs[0], { id: 's1', text: 'Clothes away', done: true });
  assert.equal(subs[1].text, '42');
  assert.ok(subs[1].id, 'a step without an id must be given one');
});

test('a payload with no subtasks at all still loads', () => {
  const out = L.migrate({ schema: 2, lists: [{ name: 'X', kind: 'once', items: [{ text: 'Thing' }] }] });
  assert.deepEqual(out.lists[0].items[0].subs, [], 'a missing subs field is an empty list, not undefined');
});

test('subtasks never enter the pool — only the thing that owns them', () => {
  const l = list('House', 'once', [withSubs(item('Sort the pile'), 'Clothes away', 'Hoover')]);
  const drawn = L.pool(stateWith([l]));
  assert.equal(drawn.length, 1);
  assert.equal(drawn[0].item.text, 'Sort the pile');
});

test('checking the last subtask finishes the thing', () => {
  const l = list('House', 'once', [withSubs(item('Sort the pile'), 'a', 'b')]);
  const it = l.items[0];

  it.subs[0].done = true;
  assert.equal(L.syncFromSubs(l, it, 1000), false, 'a part-done thing is not finished');
  assert.equal(it.done, false);

  it.subs[1].done = true;
  assert.equal(L.syncFromSubs(l, it, 2000), true);
  assert.equal(it.done, true);
  assert.equal(it.doneAt, 2000);
  assert.equal(it.count, 1, 'finishing it counts as one completion, same as a check');
});

test('reopening one subtask reopens the thing and leaves its siblings alone', () => {
  const l = list('House', 'once', [withSubs(item('Sort the pile'), 'a', 'b')]);
  const it = l.items[0];
  L.setSubsDone(it, true);
  L.syncFromSubs(l, it, 2000);

  it.subs[0].done = false;
  assert.equal(L.syncFromSubs(l, it, 3000), false);
  assert.equal(it.done, false, 'an unfinished step means an unfinished thing');
  assert.equal(it.subs[1].done, true, 'the other steps must not be swept along with it');
  assert.equal(L.pickableCount(l), 1, 'and it is back in the pool');
});

test('checking the thing itself settles all of its subtasks', () => {
  const l = list('House', 'once', [withSubs(item('Sort the pile'), 'a', 'b')]);
  const it = l.items[0];
  L.setDoneWithSubs(it, true, 1000);
  assert.deepEqual(it.subs.map((s) => s.done), [true, true]);

  L.setDoneWithSubs(it, false, 2000);
  assert.deepEqual(it.subs.map((s) => s.done), [false, false]);
  assert.equal(it.done, false);
});

test('an ongoing thing logs a session when its steps are done, then clears them', () => {
  const l = list('Creative', 'endless', [withSubs(item('Practise'), 'scales', 'the piece')]);
  const it = l.items[0];
  L.setSubsDone(it, true);

  assert.equal(L.syncFromSubs(l, it, 5000), true);
  assert.equal(it.count, 1);
  assert.equal(it.lastDone, 5000);
  assert.deepEqual(it.subs.map((s) => s.done), [false, false], 'the steps reset for the next time round');

  L.setSubsDone(it, true);
  L.syncFromSubs(l, it, 6000);
  assert.equal(it.count, 2, 'and it can be run through again');
});

test('a thing with no subtasks is never touched by the subtask rule', () => {
  const l = list('House', 'once', ['Wash up']);
  const it = l.items[0];
  assert.equal(L.syncFromSubs(l, it, 1000), false);
  assert.equal(it.done, false, 'no steps must not read as "every step done"');
  assert.equal(L.allSubsDone(it), false);
});

test('subsDone counts what is checked', () => {
  const it = withSubs(item('Thing'), 'a', 'b', 'c');
  assert.equal(L.subsDone(it), 0);
  it.subs[1].done = true;
  assert.equal(L.subsDone(it), 1);
  L.setSubsDone(it, true);
  assert.equal(L.subsDone(it), 3);
  assert.equal(L.allSubsDone(it), true);
});

test('subtasks survive a backup round-trip', () => {
  const s = stateWith([list('House', 'once', [withSubs(item('Sort the pile'), 'a', 'b')])]);
  s.lists[0].items[0].subs[0].done = true;
  assert.deepEqual(L.migrate(JSON.parse(JSON.stringify(s))), s);
});

// ------------------------------------------------------- moving things

test('nesting an item files it under another as a step', () => {
  const l = list('House', 'once', ['Sort the pile', 'Hoover']);
  const [pile, hoover] = l.items;

  assert.equal(L.nestItem(l, hoover, pile), true);
  assert.deepEqual(l.items.map((i) => i.text), ['Sort the pile'], 'it leaves the list');
  assert.deepEqual(pile.subs.map((s) => s.text), ['Hoover']);
  assert.equal(pile.subs[0].id, hoover.id, 'a thing keeps its identity across the move');
  assert.equal(L.pool(stateWith([l])).length, 1, 'and it is no longer picked on its own');
});

test('a checked item nested keeps reading as checked', () => {
  const l = list('House', 'once', [item('Sort the pile'), item('Hoover', { done: true, count: 1 })]);
  L.nestItem(l, l.items[1], l.items[0]);
  assert.equal(l.items[0].subs[0].done, true);
});

test('nesting flattens the steps the moved thing already had', () => {
  // One level is all the picker and the card can show, so its steps come along
  // beside it rather than underneath.
  const l = list('House', 'once', ['Sort the pile', 'Tidy the desk']);
  const [pile, desk] = l.items;
  desk.subs = [L.newSub('Bin the paper'), L.newSub('Coil the cables')];

  L.nestItem(l, desk, pile);
  assert.deepEqual(pile.subs.map((s) => s.text), ['Tidy the desk', 'Bin the paper', 'Coil the cables']);
  assert.deepEqual(desk.subs, [], 'nothing may be left behind on the moved thing');
});

test('an item cannot be nested under itself or under something not in the list', () => {
  const l = list('House', 'once', ['Sort the pile', 'Hoover']);
  const stranger = item('Elsewhere');
  assert.equal(L.nestItem(l, l.items[0], l.items[0]), false);
  assert.equal(L.nestItem(l, l.items[0], stranger), false);
  assert.equal(l.items.length, 2, 'a refused move must change nothing');
});

test('a step can be handed to a different owner', () => {
  const l = list('House', 'once', ['Sort the pile', 'Tidy the desk']);
  const [pile, desk] = l.items;
  pile.subs = [L.newSub('Bin the paper')];

  assert.equal(L.moveSub(l, pile, pile.subs[0], desk), true);
  assert.deepEqual(pile.subs, []);
  assert.deepEqual(desk.subs.map((s) => s.text), ['Bin the paper']);
  assert.equal(L.moveSub(l, desk, desk.subs[0], desk), false, 'moving it onto its own owner is not a move');
});

test('a step promoted stands on its own, right after what it came from', () => {
  const l = list('House', 'once', ['Sort the pile', 'Wash up']);
  const pile = l.items[0];
  pile.subs = [L.newSub('Hoover')];

  assert.equal(L.promoteSub(l, pile, pile.subs[0], 5000).text, 'Hoover', 'it hands back what it made');
  assert.deepEqual(l.items.map((i) => i.text), ['Sort the pile', 'Hoover', 'Wash up']);
  assert.deepEqual(pile.subs, []);
  assert.deepEqual(l.items[1].subs, [], 'it arrives as an ordinary item');
  assert.equal(L.pool(stateWith([l])).length, 3, 'and joins the pool');
});

test('promoting a checked step makes a checked item, tally and all', () => {
  const l = list('House', 'once', ['Sort the pile']);
  const pile = l.items[0];
  pile.subs = [Object.assign(L.newSub('Hoover'), { done: true })];

  L.promoteSub(l, pile, pile.subs[0], 5000);
  const moved = l.items[1];
  assert.equal(moved.done, true);
  assert.equal(moved.count, 1, 'being checked off is one completion, however it got there');
  assert.equal(moved.doneAt, 5000);
});

test('a nested step round-trips back out unchanged', () => {
  const l = list('House', 'once', ['Sort the pile', 'Hoover']);
  const [pile, hoover] = l.items;

  L.nestItem(l, hoover, pile);
  L.promoteSub(l, pile, pile.subs[0]);
  assert.deepEqual(l.items.map((i) => i.text), ['Sort the pile', 'Hoover']);
  assert.equal(l.items[1].id, hoover.id, 'the id survives the round trip');
  assert.deepEqual(pile.subs, []);
});

test('nesting the last unfinished thing under a done one reopens it', () => {
  const l = list('House', 'once', [item('Sort the pile', { done: true, count: 1 }), item('Hoover')]);
  const [pile, hoover] = l.items;

  L.nestItem(l, hoover, pile);
  L.syncFromSubs(l, pile, 9000);
  assert.equal(pile.done, false, 'an unfinished step means an unfinished thing');
  assert.equal(L.pickableCount(l), 1);
});

test('a thing can be moved before or after another', () => {
  const l = list('House', 'once', ['a', 'b', 'c', 'd']);
  const [a, b, c] = l.items;

  assert.equal(L.moveItemBeside(l, a, c, true), true);
  assert.deepEqual(l.items.map((i) => i.text), ['b', 'c', 'a', 'd']);

  assert.equal(L.moveItemBeside(l, a, b, false), true);
  assert.deepEqual(l.items.map((i) => i.text), ['a', 'b', 'c', 'd'], 'and straight back again');
});

test('moving a thing next to itself, or next to a stranger, does nothing', () => {
  const l = list('House', 'once', ['a', 'b']);
  const stranger = item('elsewhere');
  assert.equal(L.moveItemBeside(l, l.items[0], l.items[0], true), false);
  assert.equal(L.moveItemBeside(l, l.items[0], stranger, true), false);
  assert.deepEqual(l.items.map((i) => i.text), ['a', 'b']);
});

test('reordering reaches past what is on screen', () => {
  // The screen splits a list into open and done piles, so a move is expressed
  // against a neighbour: the array order and the on-screen order are not equal.
  const l = list('House', 'once', [item('a'), item('b', { done: true }), item('c')]);
  L.moveItemBeside(l, l.items[2], l.items[0], false);
  assert.deepEqual(l.items.map((i) => i.text), ['c', 'a', 'b'], 'the done one in between is no obstacle');
});

test('a step can be reordered within its own thing', () => {
  const l = list('House', 'once', ['Sort the pile']);
  const pile = l.items[0];
  pile.subs = [L.newSub('one'), L.newSub('two'), L.newSub('three')];

  assert.equal(L.moveSubBeside(pile, pile.subs[2], pile, pile.subs[0], false), true);
  assert.deepEqual(pile.subs.map((s) => s.text), ['three', 'one', 'two']);
});

test('a step can be dropped in at a chosen place under a different thing', () => {
  const l = list('House', 'once', ['Sort the pile', 'Tidy the desk']);
  const [pile, desk] = l.items;
  pile.subs = [L.newSub('hoover')];
  desk.subs = [L.newSub('papers'), L.newSub('cables')];

  assert.equal(L.moveSubBeside(pile, pile.subs[0], desk, desk.subs[1], false), true);
  assert.deepEqual(pile.subs, []);
  assert.deepEqual(desk.subs.map((s) => s.text), ['papers', 'hoover', 'cables']);
});

test('a step cannot be moved next to itself', () => {
  const l = list('House', 'once', ['Sort the pile']);
  const pile = l.items[0];
  pile.subs = [L.newSub('one'), L.newSub('two')];
  assert.equal(L.moveSubBeside(pile, pile.subs[0], pile, pile.subs[0], true), false);
  assert.deepEqual(pile.subs.map((s) => s.text), ['one', 'two']);
});

test('a thing nested at a place lands there, steps and all', () => {
  const l = list('House', 'once', ['Sort the pile', 'Tidy the desk']);
  const [pile, desk] = l.items;
  pile.subs = [L.newSub('one'), L.newSub('two')];
  desk.subs = [L.newSub('papers')];

  assert.equal(L.nestItem(l, desk, pile, 1), true);
  assert.deepEqual(pile.subs.map((s) => s.text), ['one', 'Tidy the desk', 'papers', 'two']);
});

test('an out-of-range nesting index is clamped, not obeyed', () => {
  const l = list('House', 'once', ['Sort the pile', 'Hoover']);
  L.nestItem(l, l.items[1], l.items[0], 99);
  assert.deepEqual(l.items[0].subs.map((s) => s.text), ['Hoover']);
});

test('reordering never changes what is pickable', () => {
  const l = list('House', 'once', ['a', 'b', 'c']);
  const before = L.pickableCount(l);
  L.moveItemBeside(l, l.items[0], l.items[2], true);
  assert.equal(L.pickableCount(l), before);
  assert.deepEqual(l.items.map((i) => i.done), [false, false, false]);
});

test('an ongoing list reorders exactly like any other', () => {
  const l = list('Practice', 'endless', [item('guitar', { count: 4 }), item('spanish'), item('drawing')]);
  L.moveItemBeside(l, l.items[2], l.items[0], false);
  assert.deepEqual(l.items.map((i) => i.text), ['drawing', 'guitar', 'spanish']);
  assert.equal(l.items[1].count, 4, 'a tally must not care where its thing sits');
});

// ------------------------------------------------------------------ shape

test('emptyState is a valid state that round-trips through migrate', () => {
  const s = L.emptyState();
  assert.deepEqual(L.migrate(JSON.parse(JSON.stringify(s))), s);
});

test('a full state survives a JSON backup round-trip unchanged', () => {
  const s = stateWith(
    [list('A', 'once', ['a1']), list('B', 'endless', [item('b1', { count: 2, lastDone: 1700000000000 })])],
    ['l-A'],
    ['i1']
  );
  assert.deepEqual(L.migrate(JSON.parse(JSON.stringify(s))), s);
});

test('newItem and newList start in a clean, pickable state', () => {
  const it = L.newItem('Something');
  assert.deepEqual(
    { done: it.done, doneAt: it.doneAt, count: it.count, lastDone: it.lastDone },
    { done: false, doneAt: 0, count: 0, lastDone: 0 }
  );
  assert.ok(it.id);
  const l = L.newList('Name', 'once', 'sky');
  assert.deepEqual(l.items, []);
  assert.notEqual(L.newList('a', 'once', 'sky').id, L.newList('a', 'once', 'sky').id, 'ids must be unique');
});
