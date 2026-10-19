// Unstuck's decision core: state shape, validation, the pick algorithm, and the
// strings derived from a list. Pure — no DOM, no storage, no clock of its own —
// so index.html can stay a thin shell and tests/ can drive this directly.
// Loads as a classic script in the browser (window.UnstuckLogic) and via
// require() in Node.

var UnstuckLogic = (() => {
  'use strict';

  const SCHEMA = 3;
  const STORE_KEY = 'unstuck.v1';
  const COLORS = ['amber', 'rose', 'violet', 'sky', 'emerald', 'teal', 'orange', 'indigo'];

  /**
   * The only thing a kind decides is whether finishing takes an item out of the
   * pool. That is the whole mechanical difference, so there are two:
   *   once    — finishing removes it from the pool
   *   endless — never finished; each pick logs a session and it stays in the pool
   *
   * Everything else is presentation, and each part is its own per-list choice:
   *   keepDone     — finished things stay put as a record, or drop into a Done pile
   *   showProgress — the list reads as "2 of 12 done", or as "10 things left"
   * The picker cannot tell any of these apart; only `kind` reaches it.
   */
  const KIND_LABEL = { once: 'Check off', endless: 'Ongoing' };

  /** Schema 1 had a third kind that differed from `todo` only in presentation. */
  const LEGACY_KINDS = {
    todo: { kind: 'once', keepDone: false, showProgress: false },
    checklist: { kind: 'once', keepDone: true, showProgress: true },
  };

  const HISTORY_LIMIT = 40;
  const MAX_RECENT_AVOIDED = 5;

  /**
   * The caps the edit fields already impose, restated for payloads that arrive
   * from a file instead of a keyboard. Nothing longer or more numerous than these
   * could have been made in the app, so `migrate` clamps rather than refuses: one
   * absurd field must not cost you the rest of a backup. The counts sit far above
   * any real use — they exist so a hostile or corrupt file cannot hand the
   * renderer a million rows or a five-megabyte string.
   */
  const MAX_NAME_LENGTH = 60;
  const MAX_TEXT_LENGTH = 200;
  const MAX_LISTS = 500;
  const MAX_ITEMS_PER_LIST = 2000;
  const MAX_SUBS_PER_ITEM = 200;

  const capLength = (text, limit) => (text.length > limit ? text.slice(0, limit) : text);

  const TIMER_PRESETS = [15, 30, 45, 60];
  const MAX_TIMER_MINUTES = 24 * 60;

  const TEXT_SCALES = { normal: 1, large: 1.15, larger: 1.3 };
  const DEFAULT_ACCENT = 'amber';
  const DEFAULT_SETTINGS = {
    textScale: 'normal', contrast: 'auto', motion: 'auto', speak: false,
    accent: DEFAULT_ACCENT, listSort: 'added',
  };

  function normalizeSettings(raw) {
    const s = raw && typeof raw === 'object' ? raw : {};
    return {
      textScale: Object.prototype.hasOwnProperty.call(TEXT_SCALES, s.textScale) ? s.textScale : 'normal',
      contrast: s.contrast === 'high' || s.contrast === 'normal' ? s.contrast : 'auto',
      motion: s.motion === 'reduced' || s.motion === 'full' ? s.motion : 'auto',
      speak: Boolean(s.speak),
      // The app's own colour, held exactly like a list's: a palette name or a hex.
      accent: normalizeColor(s.accent) || DEFAULT_ACCENT,
      listSort: Object.prototype.hasOwnProperty.call(LIST_SORTS, s.listSort) ? s.listSort : 'added',
    };
  }

  function uid() {
    const c = typeof globalThis !== 'undefined' ? globalThis.crypto : null;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    return 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  function emptyState() {
    return { schema: SCHEMA, lists: [], selection: [], history: [], settings: normalizeSettings(), timer: null };
  }

  function newItem(text) {
    return { id: uid(), text, done: false, doneAt: 0, count: 0, lastDone: 0, subs: [] };
  }

  /**
   * A subtask breaks one pickable thing into its steps. It carries no tally of
   * its own: the picker never sees a subtask, so nothing about it needs to be
   * pickable, and the parent's four completion fields stay the only record.
   */
  function newSub(text) {
    return { id: uid(), text, done: false };
  }

  function newList(name, kind, color, opts) {
    const o = opts || {};
    return {
      id: uid(),
      name,
      kind,
      color,
      keepDone: Boolean(o.keepDone),
      showProgress: Boolean(o.showProgress),
      timerMinutes: normalizeTimerMinutes(o.timerMinutes),
      items: [],
    };
  }

  /** A list's standing timer length, or 0 for "this list does not get timed". */
  function normalizeTimerMinutes(value) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.min(n, MAX_TIMER_MINUTES);
  }

  /**
   * A list colour is either a palette name or a custom hex. The hex ends up in a
   * CSS custom property, so it is normalised to a strict `#rrggbb` here and
   * anything else is refused rather than passed through to the stylesheet.
   */
  function normalizeHex(value) {
    if (typeof value !== 'string') return null;
    const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
    if (!m) return null;
    const digits = m[1].toLowerCase();
    return '#' + (digits.length === 3 ? digits.replace(/./g, (c) => c + c) : digits);
  }

  /** The colour to store, or null if it is neither a palette name nor a hex. */
  function normalizeColor(value) {
    if (COLORS.includes(value)) return value;
    return normalizeHex(value);
  }

  const isCustomColor = (color) => typeof color === 'string' && color.charAt(0) === '#';

  /**
   * HSV is what a colour wheel is: hue around it, saturation out from the middle,
   * brightness on its own. Kept here rather than in the picker so the conversions
   * can be tested without a DOM.
   * h is 0-360 (wrapping), s and v are 0-1.
   */
  function hsvToHex(h, s, v) {
    const hue = ((h % 360) + 360) % 360;
    const sat = Math.min(1, Math.max(0, s));
    const val = Math.min(1, Math.max(0, v));
    const c = val * sat;
    const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
    const m = val - c;
    const sector = Math.floor(hue / 60) % 6;
    const rgb = [
      [c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x],
    ][sector];
    return '#' + rgb.map((channel) => Math.round((channel + m) * 255).toString(16).padStart(2, '0')).join('');
  }

  function hexToHsv(value) {
    const hex = normalizeHex(value);
    if (!hex) return null;
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;

    let h = 0;
    if (d !== 0) {
      if (max === r) h = 60 * (((g - b) / d) % 6);
      else if (max === g) h = 60 * ((b - r) / d + 2);
      else h = 60 * ((r - g) / d + 4);
    }
    return { h: ((h % 360) + 360) % 360, s: max === 0 ? 0 : d / max, v: max };
  }

  /** WCAG relative luminance, the input to every contrast figure below. */
  function luminance(value) {
    const hex = normalizeHex(value);
    if (!hex) return null;
    const channels = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  }

  /** WCAG contrast between two colours: 1 is invisible, 21 is black on white. */
  function contrastRatio(a, b) {
    const la = luminance(a);
    const lb = luminance(b);
    if (la === null || lb === null) return null;
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }

  /**
   * The same colour, lifted until it can be read as text on `background`.
   *
   * A list's colour is chosen on a wheel whose brightness slider reaches black,
   * and that colour is also used as text — so a legitimate choice can be
   * invisible. Hue is what the user actually picked, so it never moves:
   * brightness rises first, then saturation drops, which walks the colour
   * towards white rather than towards some other colour. Returns the original
   * when it already passes, and null if it was not a colour at all.
   */
  function readableOn(value, background, minRatio) {
    const hsv = hexToHsv(value);
    const hex = normalizeHex(value);
    if (!hsv || !hex || !normalizeHex(background)) return null;
    const target = minRatio || 4.5;
    if (contrastRatio(hex, background) >= target) return hex;

    for (let v = hsv.v; v <= 1.0001; v += 0.02) {
      const lifted = hsvToHex(hsv.h, hsv.s, Math.min(1, v));
      if (contrastRatio(lifted, background) >= target) return lifted;
    }
    for (let s = hsv.s; s >= -0.0001; s -= 0.02) {
      const washed = hsvToHex(hsv.h, Math.max(0, s), 1);
      if (contrastRatio(washed, background) >= target) return washed;
    }
    // White is the most legible thing there is; if that misses, the background is
    // the problem, and returning it unchanged would be a silent failure.
    return '#ffffff';
  }

  /** The same hue at a different strength — the ends of the pick button's gradient. */
  function shade(value, satFactor, valFactor) {
    const hsv = hexToHsv(value);
    if (!hsv) return null;
    const clamp = (n) => Math.min(1, Math.max(0, n));
    return hsvToHex(hsv.h, clamp(hsv.s * satFactor), clamp(hsv.v * valFactor));
  }

  /**
   * Text to sit on top of `value`: a near-black or near-white of the same hue,
   * whichever reads better. Staying in the hue family is why the amber accent's
   * ink is a warm brown rather than a flat black.
   */
  function inkOn(value) {
    const hsv = hexToHsv(value);
    if (!hsv) return null;
    const dark = hsvToHex(hsv.h, Math.min(1, hsv.s + 0.1), 0.14);
    const light = hsvToHex(hsv.h, 0.12, 1);
    return contrastRatio(value, dark) >= contrastRatio(value, light) ? dark : light;
  }

  /**
   * Resolves whatever shape a payload carries — current or schema 1 — into the
   * kind plus its two independent display choices. Schema 1's `checklist` was
   * both of those switched on at once, which is why it felt like a kind.
   */
  function resolveKind(kind, keepDone, showProgress) {
    const legacy = Object.prototype.hasOwnProperty.call(LEGACY_KINDS, kind) ? LEGACY_KINDS[kind] : null;
    if (legacy) return { ...legacy };
    const known = Object.prototype.hasOwnProperty.call(KIND_LABEL, kind);
    return {
      kind: known ? kind : 'once',
      keepDone: Boolean(keepDone),
      showProgress: Boolean(showProgress),
    };
  }

  /**
   * Ready-made lists, offered on a first run and from the Lists screen. Themed by
   * what they are about, with the kind that suits how that theme gets finished.
   * The ones whose contents are a matter of personal taste start empty on
   * purpose — a suggested reading list would just be someone else's.
   */
  const STARTER_LISTS = [
    {
      name: 'Around the house', kind: 'once', keepDone: false, color: 'sky',
      items: ['Wash up', 'Change the sheets', 'Take the bins out', 'Sort the pile on the chair',
        'Water the plants', 'Wipe down the kitchen'],
    },
    {
      name: 'Productive', kind: 'once', keepDone: false, color: 'amber',
      items: ['Clear the inbox', 'Pay that bill you keep forgetting', 'Book the appointment',
        'Back up your files', 'Reply to the message you have been avoiding', 'Tidy your desk'],
    },
    {
      name: 'Creative', kind: 'endless', color: 'violet',
      items: ['Sketch for fifteen minutes', 'Write two hundred words', 'Practise an instrument',
        'Photograph something ordinary', 'Make a playlist', 'Pick up something you abandoned'],
    },
    {
      name: 'Get outside', kind: 'endless', color: 'emerald',
      items: ['Walk a route you have never taken', 'Ten minutes in the sun', 'Stretch properly',
        'Go and look at some water'],
    },
    {
      name: 'Rest', kind: 'endless', color: 'teal',
      items: ['Lie down and do nothing', 'Make a proper cup of tea', 'Put on an album and just listen',
        'Have a bath', 'Go to bed early'],
    },
    {
      name: 'Learn something', kind: 'endless', color: 'indigo',
      items: ['One language lesson', 'Read a long article you saved', 'Watch a documentary',
        'Ten minutes of a tutorial'],
    },
    { name: 'Books to read', kind: 'once', keepDone: true, showProgress: true, color: 'rose', items: [] },
    { name: 'Films to watch', kind: 'once', keepDone: true, showProgress: true, color: 'orange', items: [] },
  ];

  function listFromStarter(spec) {
    const l = newList(spec.name, spec.kind, spec.color, spec);
    l.items = spec.items.map((text) => newItem(text));
    return l;
  }

  /**
   * The single gate every inbound payload passes: page load and backup import
   * both. Coerces field types, drops unusable items, clamps every field to the
   * size the edit fields allow, and throws on anything not shaped like an Unstuck
   * backup so a bad file cannot corrupt live state.
   *
   * Junk is filtered before anything is counted, so malformed entries cannot eat
   * a list's budget and push real ones out.
   */
  function migrate(data) {
    if (!data || typeof data !== 'object' || !Array.isArray(data.lists)) {
      throw new Error('Unstuck: backup is not in the expected format');
    }
    const lists = data.lists
      .filter((l) => l && typeof l === 'object')
      .slice(0, MAX_LISTS)
      .map((l) => ({
        id: typeof l.id === 'string' && l.id ? l.id : uid(),
        name: capLength(String(l.name || 'Untitled list'), MAX_NAME_LENGTH),
        ...resolveKind(l.kind, l.keepDone, l.showProgress),
        color: normalizeColor(l.color) || COLORS[0],
        timerMinutes: normalizeTimerMinutes(l.timerMinutes),
        items: Array.isArray(l.items)
          ? l.items
              .filter((it) => it && typeof it === 'object')
              .slice(0, MAX_ITEMS_PER_LIST)
              .map((it) => ({
                id: typeof it.id === 'string' && it.id ? it.id : uid(),
                text: capLength(String(it.text == null ? '' : it.text), MAX_TEXT_LENGTH),
                done: Boolean(it.done),
                doneAt: Number(it.doneAt) || 0,
                count: Number(it.count) || 0,
                lastDone: Number(it.lastDone) || 0,
                subs: Array.isArray(it.subs)
                  ? it.subs
                      .filter((s) => s && typeof s === 'object')
                      .slice(0, MAX_SUBS_PER_ITEM)
                      .map((s) => ({
                        id: typeof s.id === 'string' && s.id ? s.id : uid(),
                        text: capLength(String(s.text == null ? '' : s.text), MAX_TEXT_LENGTH),
                        done: Boolean(s.done),
                      }))
                      .filter((s) => s.text.trim() !== '')
                  : [],
              }))
              .filter((it) => it.text.trim() !== '')
          : [],
      }));

    const ids = new Set(lists.map((l) => l.id));
    return {
      schema: SCHEMA,
      lists,
      selection: Array.isArray(data.selection) ? data.selection.filter((id) => ids.has(id)) : [],
      history: Array.isArray(data.history)
        ? data.history.filter((h) => typeof h === 'string').slice(-HISTORY_LIMIT)
        : [],
      settings: normalizeSettings(data.settings),
      timer: normalizeTimer(data.timer),
    };
  }

  // -------------------------------------------------------------- the timer

  /**
   * A timer is stored as the moment it ends, not as a countdown, so it stays
   * right across a reload or a phone that suspended the tab. `pausedAt` freezes
   * it: while set, the remaining time is measured to that instant instead of now.
   */
  function startTimer(minutes, label, now) {
    const mins = normalizeTimerMinutes(minutes);
    if (!mins) return null;
    const at = now === undefined ? Date.now() : now;
    const duration = mins * 60000;
    return { duration, endsAt: at + duration, label: String(label == null ? '' : label), pausedAt: 0 };
  }

  function timerRemaining(timer, now) {
    if (!timer) return 0;
    const at = timer.pausedAt ? timer.pausedAt : (now === undefined ? Date.now() : now);
    return Math.max(0, timer.endsAt - at);
  }

  const timerFinished = (timer, now) => Boolean(timer) && timerRemaining(timer, now) === 0;

  function pauseTimer(timer, now) {
    if (!timer || timer.pausedAt) return timer;
    return { ...timer, pausedAt: now === undefined ? Date.now() : now };
  }

  function resumeTimer(timer, now) {
    if (!timer || !timer.pausedAt) return timer;
    const at = now === undefined ? Date.now() : now;
    return { ...timer, endsAt: at + (timer.endsAt - timer.pausedAt), pausedAt: 0 };
  }

  /** Adds time, restarting from now if the timer has already run out. */
  function extendTimer(timer, minutes, now) {
    if (!timer) return timer;
    const at = now === undefined ? Date.now() : now;
    const ms = normalizeTimerMinutes(minutes) * 60000;
    if (!ms) return timer;
    if (timer.pausedAt) return { ...timer, duration: timer.duration + ms, endsAt: timer.endsAt + ms };
    const base = Math.max(timer.endsAt, at);
    return { ...timer, duration: timer.duration + ms, endsAt: base + ms };
  }

  function normalizeTimer(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const duration = Number(raw.duration);
    const endsAt = Number(raw.endsAt);
    if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(endsAt)) return null;
    const pausedAt = Number(raw.pausedAt);
    return {
      duration,
      endsAt,
      // The label is an item's text, so it is held to an item's length.
      label: capLength(String(raw.label == null ? '' : raw.label), MAX_TEXT_LENGTH),
      pausedAt: Number.isFinite(pausedAt) && pausedAt > 0 ? pausedAt : 0,
    };
  }

  /** mm:ss, growing to h:mm:ss only once there is an hour to show. */
  function formatClock(ms) {
    const total = Math.ceil(Math.max(0, ms) / 1000);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return hours > 0 ? hours + ':' + pad(minutes) + ':' + pad(seconds) : minutes + ':' + pad(seconds);
  }

  /** How a timer length reads in a menu or on a list. */
  function formatMinutes(minutes) {
    if (!minutes) return 'Off';
    if (minutes < 60) return minutes + ' min';
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    const hourPart = plural(hours, 'hour', 'hours');
    return rest ? hourPart + ' ' + rest + ' min' : hourPart;
  }

  /** The same length on a chip, where the row has to fit five of them across a phone. */
  function formatMinutesShort(minutes) {
    if (!minutes) return 'Off';
    if (minutes < 60) return minutes + ' min';
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest ? hours + ' hr ' + rest : hours + ' hr';
  }

  // -------------------------------------------------------- completing things

  /**
   * `done` and `count` are two readings of one fact — how many times this has
   * been finished — so they are kept in step. Otherwise a list switched to
   * Ongoing shows a checked item at zero sessions, and switching back loses the
   * tally.
   */
  function setDone(item, done, now) {
    const at = now === undefined ? Date.now() : now;
    item.done = done;
    item.doneAt = done ? at : 0;
    if (done) {
      // Checking something off is itself one completion.
      if (item.count === 0) {
        item.count = 1;
        item.lastDone = at;
      }
    } else if (item.count === 1) {
      // Unchecking withdraws the completion the check implied — but never a real
      // tally built up from logged sessions.
      item.count = 0;
      item.lastDone = 0;
    }
  }

  function logSession(item, now) {
    const at = now === undefined ? Date.now() : now;
    item.count += 1;
    item.lastDone = at;
    // A logged session is a completion too, so the check views agree with it.
    item.done = true;
    item.doneAt = at;
  }

  const subsDone = (item) => item.subs.filter((s) => s.done).length;
  const allSubsDone = (item) => item.subs.length > 0 && item.subs.every((s) => s.done);

  function setSubsDone(item, done) {
    for (const sub of item.subs) sub.done = done;
  }

  /** Checking the thing itself settles its subtasks with it — they are its parts. */
  function setDoneWithSubs(item, done, now) {
    setDone(item, done, now);
    setSubsDone(item, done);
  }

  /**
   * The other direction: a thing is finished exactly when its steps are, so the
   * last check finishes it and reopening one step reopens it. Only the parent's
   * own state moves here — the sibling steps are left alone. An ongoing item logs
   * a session instead and its steps clear, ready for the next time round.
   * Returns true when this check was the one that finished it.
   */
  function syncFromSubs(list, item, now) {
    if (!item.subs.length) return false;
    const all = allSubsDone(item);
    if (list.kind === 'endless') {
      if (!all) return false;
      logSession(item, now);
      setSubsDone(item, false);
      return true;
    }
    if (all === item.done) return false;
    setDone(item, all, now);
    return all;
  }

  // ------------------------------------------------- moving things around

  /**
   * A subtask is the part of an item a step can hold: no tally, no timestamps.
   * The id travels with it so a thing keeps its identity across the move.
   */
  function subFromItem(item) {
    return { id: item.id, text: item.text, done: Boolean(item.done) };
  }

  /**
   * Files a whole item under another as one of its steps. Nesting is one level
   * deep by design — the picker and the card can only show that much — so steps
   * the moved item already had arrive beside it rather than underneath.
   * Returns false when the move is not a real one.
   */
  function nestItem(list, item, parent, at) {
    const from = list.items.indexOf(item);
    if (from === -1 || item === parent || !list.items.includes(parent)) return false;
    list.items.splice(from, 1);
    const moved = [subFromItem(item), ...item.subs];
    const where = at === undefined ? parent.subs.length : Math.max(0, Math.min(parent.subs.length, at));
    parent.subs.splice(where, 0, ...moved);
    item.subs = [];
    return true;
  }

  /** Hands a step to a different owner, keeping it a step. */
  function moveSub(list, from, sub, to) {
    const at = from.subs.indexOf(sub);
    if (at === -1 || from === to || !list.items.includes(to)) return false;
    from.subs.splice(at, 1);
    to.subs.push(sub);
    return true;
  }

  /**
   * Lifts a step back out to stand on its own, directly after what it came from.
   * A checked step becomes a checked item, which is one completion, so its tally
   * starts where `setDone` would have put it. Returns the new item.
   */
  function promoteSub(list, parent, sub, now) {
    const at = parent.subs.indexOf(sub);
    if (at === -1) return null;
    parent.subs.splice(at, 1);
    const item = newItem(sub.text);
    item.id = sub.id;
    if (sub.done) setDone(item, true, now);
    list.items.splice(list.items.indexOf(parent) + 1, 0, item);
    return item;
  }

  /**
   * Reordering is expressed against a neighbour rather than an index, because
   * the screen only ever shows part of a list — finished things sit in their own
   * pile — and "after that one" survives that where a position does not.
   */
  function moveItemBeside(list, item, target, after) {
    const from = list.items.indexOf(item);
    if (item === target || from === -1 || !list.items.includes(target)) return false;
    list.items.splice(from, 1);
    list.items.splice(list.items.indexOf(target) + (after ? 1 : 0), 0, item);
    return true;
  }

  /** The same for steps, within one owner or across two. */
  function moveSubBeside(from, sub, to, target, after) {
    const at = from.subs.indexOf(sub);
    if (sub === target || at === -1 || !to.subs.includes(target)) return false;
    from.subs.splice(at, 1);
    to.subs.splice(to.subs.indexOf(target) + (after ? 1 : 0), 0, sub);
    return true;
  }

  // ------------------------------------------------------------------- pool

  function listById(state, id) {
    return state.lists.find((l) => l.id === id) || null;
  }

  function isPickable(list, item) {
    return list.kind === 'endless' ? true : !item.done;
  }

  function pickableCount(list) {
    return list.items.filter((it) => isPickable(list, it)).length;
  }

  /**
   * How the lists screen is ordered. "As added" is the default and is not a sort
   * at all — it is the order they were made in, which is the only one the user
   * controls directly.
   */
  const LIST_SORTS = {
    added: 'As added',
    az: 'Name A to Z',
    za: 'Name Z to A',
    most: 'Most left first',
    fewest: 'Fewest left first',
  };

  /**
   * A sorted copy — the stored order is what "as added" means, so it is never
   * rewritten. Ties fall back to the name so the grid cannot shuffle between
   * renders when two lists have the same number left.
   */
  function sortLists(lists, mode) {
    const rows = lists.slice();
    if (!Object.prototype.hasOwnProperty.call(LIST_SORTS, mode) || mode === 'added') return rows;
    const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
    if (mode === 'az') return rows.sort(byName);
    if (mode === 'za') return rows.sort((a, b) => byName(b, a));
    const left = new Map(rows.map((l) => [l, pickableCount(l)]));
    const size = (a, b) => left.get(b) - left.get(a);
    return rows.sort(mode === 'most' ? (a, b) => size(a, b) || byName(a, b)
      : (a, b) => size(b, a) || byName(a, b));
  }

  // ----------------------------------------------------------------- search

  /**
   * Text prepared for searching, plus a map from each folded character back to
   * where it came from. Case is folded, accents are dropped and runs of
   * whitespace become one space, so "Café  au lait" is found by "cafe au". The
   * map is what lets a result highlight the matched run inside the original.
   */
  function foldForSearch(text) {
    const src = String(text == null ? '' : text);
    let out = '';
    const map = [];
    for (let i = 0; i < src.length; i++) {
      const ch = src.charAt(i);
      if (/\s/.test(ch)) {
        // Leading and repeated whitespace say nothing about what was written.
        if (out && out.charAt(out.length - 1) !== ' ') {
          out += ' ';
          map.push(i);
        }
        continue;
      }
      // Decomposing is the expensive half of this, and it runs over every list on
      // every keystroke \u2014 ASCII cannot carry a diacritic to strip, so it skips it.
      const folded = ch.charCodeAt(0) < 128
        ? ch.toLowerCase()
        : ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      for (let k = 0; k < folded.length; k++) {
        out += folded.charAt(k);
        map.push(i);
      }
    }
    if (out.charAt(out.length - 1) === ' ') {
      out = out.slice(0, -1);
      map.pop();
    }
    // One past the end, so the end of a match that runs to the end still maps.
    map.push(src.length);
    return { text: out, map };
  }

  /**
   * Where `query` sits inside `text`, as a range into the original string, or
   * null when it is not in there at all. Folding means the range can be a
   * different length from the query that found it.
   */
  function matchRange(text, query) {
    const needle = foldForSearch(query).text;
    if (!needle) return null;
    const hay = foldForSearch(text);
    const at = hay.text.indexOf(needle);
    if (at === -1) return null;
    return { start: hay.map[at], end: hay.map[at + needle.length] };
  }

  /**
   * Everything matching `query`, grouped by the list it is in — the answer to
   * "which list was that on". A list is a group when its own name matches, when
   * one of its things does, or when one of their steps does, so a thing filed
   * under another is still findable. Finished things count: a checked item is
   * still something you might be hunting for.
   */
  function searchLists(lists, query) {
    if (!foldForSearch(query).text) return [];
    const groups = [];
    for (const list of lists) {
      const hits = [];
      for (const item of list.items) {
        if (matchRange(item.text, query)) {
          hits.push({ itemId: item.id, subId: null, text: item.text, done: Boolean(item.done), parent: null });
        }
        for (const sub of item.subs) {
          if (matchRange(sub.text, query)) {
            hits.push({ itemId: item.id, subId: sub.id, text: sub.text, done: Boolean(sub.done), parent: item.text });
          }
        }
      }
      const nameMatch = Boolean(matchRange(list.name, query));
      if (nameMatch || hits.length) groups.push({ list, nameMatch, hits });
    }
    return groups;
  }

  /**
   * How many results a search actually put on the screen. A list matched by its
   * own name is one of them — it is a row you can tap, so counting only the
   * things inside would report a search that found something as finding nothing.
   */
  const countMatches = (groups) => groups.reduce((n, g) => n + g.hits.length + (g.nameMatch ? 1 : 0), 0);

  /** No selection means every list is in play. */
  function activeLists(state) {
    if (!state.selection.length) return state.lists;
    return state.lists.filter((l) => state.selection.includes(l.id));
  }

  function pool(state) {
    const out = [];
    for (const list of activeLists(state)) {
      for (const item of list.items) {
        if (isPickable(list, item)) out.push({ list, item });
      }
    }
    return out;
  }

  // ------------------------------------------------------------------- pick

  /** How many recent picks to avoid repeating, scaled to pool size. */
  function recentDepth(poolSize) {
    return Math.min(MAX_RECENT_AVOIDED, Math.max(0, Math.floor(poolSize / 2)));
  }

  /**
   * Draws one entry from `all`, preferring things not yet offered in this run of
   * rerolls and, failing that, things not in recent history. Returns null for an
   * empty pool, otherwise `{ choice, exhausted }` — `exhausted` tells the caller
   * every candidate had already been shown, so the run should start over.
   */
  function chooseFrom(all, shown, history, random) {
    if (!all.length) return null;
    const rng = random || Math.random;

    let candidates = all.filter((c) => !shown.has(c.item.id));
    const exhausted = candidates.length === 0;
    if (exhausted) candidates = all;

    // slice(-0) would return the whole history, so a zero depth is taken as none.
    const depth = recentDepth(all.length);
    const recent = depth > 0 ? history.slice(-depth) : [];
    const fresh = candidates.filter((c) => !recent.includes(c.item.id));
    if (fresh.length) candidates = fresh;

    return { choice: candidates[Math.floor(rng() * candidates.length)], exhausted };
  }

  function pushHistory(history, id) {
    const next = history.concat(id);
    return next.length > HISTORY_LIMIT ? next.slice(-HISTORY_LIMIT) : next;
  }

  // ---------------------------------------------------------------- strings

  function plural(n, one, many) {
    return n + ' ' + (n === 1 ? one : many);
  }

  function relativeDay(ts, now) {
    if (!ts) return '';
    const then = new Date(ts);
    const today = now === undefined ? new Date() : new Date(now);
    const startOf = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const days = Math.round((startOf(today) - startOf(then)) / 86400000);
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 7) return days + ' days ago';
    if (days < 14) return 'last week';
    if (days < 365) return then.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return then.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
  }

  /** Named for the day it was made where the user is; a UTC date runs a day ahead every evening in the Americas. */
  function backupFileName(now) {
    const pad = (n) => String(n).padStart(2, '0');
    return 'unstuck-backup-' + now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()) + '.json';
  }

  function listSummary(list) {
    if (!list.items.length) return 'Empty';
    if (list.kind === 'endless') {
      const sessions = list.items.reduce((n, it) => n + it.count, 0);
      return plural(list.items.length, 'thing', 'things') + ' · ' + plural(sessions, 'session', 'sessions') + ' logged';
    }
    const done = list.items.filter((it) => it.done).length;
    // Independent of where finished items go: some lists read better as progress.
    if (list.showProgress) return done + ' of ' + list.items.length + ' done';
    const left = list.items.length - done;
    return left === 0 ? 'All done' : plural(left, 'thing', 'things') + ' left';
  }

  /** The line under a picked item, explaining where it sits in its list. */
  function cardMeta(list, item, now) {
    if (list.kind === 'endless') {
      if (!item.count) return 'You have not logged this one yet.';
      return 'Done ' + plural(item.count, 'time', 'times') + ' · last ' + relativeDay(item.lastDone, now);
    }
    if (list.showProgress) {
      const done = list.items.filter((it) => it.done).length;
      return done + ' of ' + list.items.length + ' checked off so far.';
    }
    const left = list.items.filter((it) => !it.done).length;
    return plural(left, 'thing', 'things') + ' left in this list.';
  }

  return {
    SCHEMA, STORE_KEY, COLORS, KIND_LABEL, HISTORY_LIMIT, STARTER_LISTS,
    MAX_NAME_LENGTH, MAX_TEXT_LENGTH, MAX_LISTS, MAX_ITEMS_PER_LIST, MAX_SUBS_PER_ITEM,
    uid, emptyState, newItem, newSub, newList, listFromStarter, migrate, resolveKind,
    normalizeHex, normalizeColor, isCustomColor, hsvToHex, hexToHsv,
    luminance, contrastRatio, readableOn, shade, inkOn, DEFAULT_ACCENT,
    TIMER_PRESETS, TEXT_SCALES, DEFAULT_SETTINGS, normalizeSettings, normalizeTimerMinutes,
    startTimer, timerRemaining, timerFinished, pauseTimer, resumeTimer, extendTimer,
    normalizeTimer, formatClock, formatMinutes, formatMinutesShort,
    setDone, logSession, subsDone, allSubsDone, setSubsDone, setDoneWithSubs, syncFromSubs,
    subFromItem, nestItem, moveSub, promoteSub, moveItemBeside, moveSubBeside,
    listById, isPickable, pickableCount, activeLists, pool, LIST_SORTS, sortLists,
    foldForSearch, matchRange, searchLists, countMatches,
    recentDepth, chooseFrom, pushHistory,
    plural, relativeDay, backupFileName, listSummary, cardMeta,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = UnstuckLogic;
