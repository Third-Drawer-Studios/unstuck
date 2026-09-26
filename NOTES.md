# Where Unstuck is up to

Working notes, last updated 2026-09-18. The README covers how the app works and how to run it —
this is state and direction only.

## Status

Shipped and live at **https://jamjamdev.github.io/unstuck/**, deployed from `main` via GitHub Pages.
143 unit checks (`./test.sh`) and 105 browser checks (`./test.sh --browser`) passing.

Built so far: the picker with rerolls and swipe, two list kinds plus two independent display
switches, subtasks, starter lists, custom colours with a wheel, per-list timers, and accessibility
settings.

The latest round added a **search** above the list grid, answering "which list was that on". It
reaches list names, things and their steps, includes finished things, folds case and accents, and
groups every match under the list it is in. A match opens its list with that row outlined; the
outline is dropped by the next render rather than by a timer, so nothing has to tidy up after it.
`sw.js` is at `unstuck-v14`.

Before it, `b737e57` put a **Sort** control above the grid — as added, by name either way, or by how
many things are left — sorting a copy so the stored order still means "as added". `213efb5` made the
app's own colour a setting and turned the list's ⋯ Options control into a labelled pill in the list's
colour; `46d3b95` before that was an accessibility round. The week-of-use round (`88bf31f`..`db0ec62`)
landed drag-to-reorder alongside drag-to-nest, an escape from the standalone timer ask, a Custom
timer length, and the Ko-fi tip jar.
Git holds the detail; two lessons from it are worth keeping here:

- **A touch listener registered late is a listener that does nothing.** The nesting drag failed on a
  real phone because the non-passive `touchmove` that stops the list scrolling was registered when
  the row lifted, half a second in — but a browser fixes whether a touch may scroll as the touch
  *starts*, counting only the blocking listeners already present. Registered at startup now.
- **Neither suite can catch that class of bug.** Synthetic pointer events and CDP touch both bypass
  the scroll decision entirely, so it took a phone in a hand. Assume the same of anything else that
  depends on how a browser interprets a *gesture* rather than an event.

The repo is **public**, which it had to be — GitHub Pages will not serve a private repo on the free
plan. Only the code is public; lists live in each device's storage and never leave it.

## Next up

Headed for the Play Store. The code is not what is unfinished — the wrap, the paperwork and the
closed-test window are.

0. **Before submitting**, in this order:
   - A **privacy policy at a real URL** (GitHub Pages already serves one). Required for every app,
     ads or not, and the Data safety form needs it.
   - **Data safety form**: today the honest answer is "no data collected, no data shared", which is
     the listing's best line. One qualifier is owed: the read-aloud setting hands item text to the
     system TTS engine, which is not guaranteed on-device for every language.
   - **Closed testing** — an individual account has to run one for a fixed window before production
     opens. Check the console for the current tester count and duration; it is the requirement most
     likely to add weeks of calendar time, so look it up before planning a date.
   - Content rating questionnaire, current target API level, Play App Signing, the $25 fee.
   - Store assets: feature graphic, phone screenshots, short and full description. None exist yet.

1. **Use the new round for a week**, the same way. The widget's design still depends on what you
   actually want at a glance, and that is not answerable from a chair.

2. **Android home-screen widget.** Needs the native wrap; a PWA cannot provide one. Decisions
   already made:
   - **Capacitor, not Bubblewrap/TWA** — a widget must read the lists, and a TWA leaves them inside
     Chrome's storage where native code cannot reach.
   - `save()`/`load()` route through a storage adapter that also writes Android `SharedPreferences`.
     They are the only two functions that touch storage, so this stays contained.
   - The web app writes a **pre-shuffled queue** of upcoming picks; the widget pops from it. That
     keeps the pick algorithm in `logic.js` only, never reimplemented in Kotlin.
   - Blocked on tooling: no JDK, Android SDK or Android Studio installed. That install is the real
     cost, not the code.

3. **Play Store, then possibly App Store.** Same Capacitor project as the widget. iOS needs a Mac
   with Xcode and a paid Apple developer account.

## Known limits

- **Backgrounded timers.** Phones suspend a web app's timers, so the alarm only rings reliably while
  the app is open. The remaining time is always correct when you return, because a timer is stored
  as the moment it ends. A real pocket alarm needs the native wrap — same blocker as the widget.
- **360x640 screens.** Every field in the edit dialog is on screen at 380x700 and up; on a 360x640
  phone the Timer row needs a small scroll. Fine on anything current.
- **The captured drags are not in either suite.** Synthetic pointer events cannot hold a pointer
  capture, so swipe-to-skip, swipe-to-accept and the colour wheel drag are verified by hand against
  a real touch device. Drag-to-nest deliberately does not use pointer capture — it tracks on
  `document` instead — so that one is covered, including its edge auto-scroll.

## Settled — do not redecide without a reason

- **Theme and kind are separate axes.** "Productive" and "Creative" are list *names*; the kind only
  decides whether finishing removes something from the pool. Every theme spans both kinds.
- **Two kinds, not three.** Schema 1's `checklist` was `todo` with two display switches flipped on,
  which is exactly why the two felt identical in use.
- **Picking is uniform random.** No weights, no priorities — knobs to tune are one more thing to
  stall on.
- **Decisions belong to the list, not the moment.** The per-list default timer exists so accepting a
  pick never asks anything. Count the taps before proposing UI.
- **No voice-to-text.** Android's keyboard mic already dictates into every field, and the Web Speech
  API is Chrome-only and sends audio off-device.
- **Subtasks are parts, not things.** Only their parent is ever picked. Putting steps in the pool
  would hand you a six-step job six times as often as *wash up* — the odds distortion is the whole
  reason, and it is not fixable by weighting without reintroducing knobs.
- **Whole-list actions live in one sheet**, reached by holding a list or by the ⋯ Options pill beside
  its title. Nothing that edits a list goes near the row that adds to one: "Edit list" sat above the
  add row and got pressed by a thumb reaching to add an item. The pill is labelled and tinted because
  the bare glyph then lost to the app's gear, 8px away in the same corner — twice now, a control on
  this screen has been mistaken for its neighbour, so proximity is the thing to design against here.
- **Nesting is one level.** Steps of a moved thing arrive beside it, never underneath. A second
  level is not a data problem, it is a card problem — the picked card has room for one checklist.
- **One drag does both nesting and reordering**, split by where on the target row the finger lets
  go: the middle files in, either edge inserts. Two gestures for one finger would have been the
  worse answer. Order still means nothing to the picker on any kind of list — it is uniform random
  regardless — but it makes a long list readable, which is why it earns the gesture.
- **Free, no ads, nothing paywalled — a tip jar instead.** An ad would sit in the exact moment the
  app exists to smooth over, and would cost the "nothing leaves the device" promise (tracking SDK,
  consent prompt, privacy policy) for a few dollars a month at realistic install numbers. A paid
  timer fails differently: time-boxing is core to getting unstuck, so charging for it reads as
  "why isn't that just free". The tip unlocks nothing on purpose.
- **Sorting the grid is a view, never a rewrite.** "As added" is the only order the user controls
  directly, so a sort returns a copy and the stored array is left alone. Ties break on the name for
  the same reason a picker needs a seed: two lists with three things left must not swap places
  between renders.
- **Ads stay out, and the arithmetic is why.** At a realistic first year — a few hundred installs, a
  hundred daily actives — banner revenue lands somewhere around $2 to $15 a month. The cost is fixed
  and certain: the Data safety form changes from "collects nothing" to "collects device IDs for
  advertising", a consent flow is needed for EEA/UK, the privacy policy grows to cover an ad network,
  and the "nothing leaves the device" promise reads as marketing to anyone who sees an ad. Revisit at
  ~50,000 daily actives and not before. Cosmetics — a colour or theme pack — take money without
  paywalling a function or adding an SDK, and stay inside "nothing paywalled".
- **A search is a way of looking, not part of the data.** The query lives in `ui`, never in `state`:
  nothing about it is saved, and leaving the Lists tab ends it. A restored search would look like
  missing lists on the way back in, and a saved one would be a second thing that can go stale.
- **A colour is lifted for text, never replaced.** The wheel can produce a colour that cannot be read
  on the card, and refusing it would make the wheel feel broken. The chosen colour still paints edges
  and dots; only its text reading is raised to 4.5:1, as `--list-ink`.

## Ideas, not commitments

- A typed length in **List options → Timer** as well. The offer on the card takes one now; the
  per-list standing length is still a fixed menu.
- An in-app override for handedness, if reaching the top-left back arrow ever annoys you. The system
  back gesture already covers most of it.
