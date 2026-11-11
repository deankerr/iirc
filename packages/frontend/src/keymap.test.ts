import { NetworkId, TimelineId } from "@iirc/api";
import { Schema } from "effect";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { CommandContext } from "./commands.ts";
import {
  chordOf,
  chordsFor,
  defaultBindings,
  defaultKeymap,
  formatChord,
  keyNamed,
  keymapOf,
  parseChord,
  parseWhen,
  resolve,
  showChord,
} from "./keymap.ts";
import type { Chord, KeyContext, KeyEvent, KeyName, Platform } from "./keymap.ts";

const network = Schema.decodeSync(NetworkId)("libera");
const timelineId = Schema.decodeSync(TimelineId);
const own = timelineId("00000000000001-00000000-00000000");
const channel = timelineId("00000000000002-00000000-00000000");
const direct = timelineId("00000000000003-00000000-00000000");

const inChannel: CommandContext = {
  behind: false,
  draft: undefined,
  focus: {
    detached: false,
    key: "#iirc",
    kind: "Channel",
    name: "#iirc",
    network,
    timeline: channel,
  },
  head: undefined,
  open: channel,
  panes: 1,
  session: true,
  shown: [],
  timelines: [own, channel, direct],
  unread: [],
};

const at = (
  more: Partial<Omit<KeyContext, "command">> = {},
  command: CommandContext = inChannel
): KeyContext => ({ command, editing: false, palette: false, platform: "Other", ...more });

const press = (key: string, code: string, held: Partial<KeyEvent> = {}): KeyEvent => ({
  alt: false,
  altGraph: false,
  code,
  ctrl: false,
  key,
  meta: false,
  shift: false,
  ...held,
});

const valueOf = <A>(read: { _tag: "Parsed"; value: A } | { _tag: "Invalid"; message: string }) => {
  if (read._tag === "Invalid") {
    throw new Error(read.message);
  }

  return read.value;
};

const key = (name: string): KeyName => {
  const found = keyNamed(name);

  if (found === undefined) {
    throw new Error(`no key ${name}`);
  }

  return found;
};

const keyName: fc.Arbitrary<KeyName> = fc
  .oneof(
    fc.constantFrom(
      "arrowdown",
      "arrowup",
      "enter",
      "escape",
      "space",
      "plus",
      "tab",
      "f12",
      ",",
      "/",
      "k",
      "p",
      "1",
      "é",
      "ß"
    ),
    fc.string({ maxLength: 1, minLength: 1, unit: "grapheme-ascii" })
  )
  .map((text) => keyNamed(text))
  .filter((name): name is KeyName => name !== undefined);

const chord: fc.Arbitrary<Chord> = fc.record({
  alt: fc.boolean(),
  ctrl: fc.boolean(),
  key: keyName,
  meta: fc.boolean(),
  mod: fc.boolean(),
  shift: fc.boolean(),
});

const shown = (text: string, platform: Platform) => showChord(valueOf(parseChord(text)), platform);

const chordText = (event: KeyEvent, platform: Platform) => {
  const found = chordOf(event, platform);

  return found === undefined ? undefined : formatChord(found);
};

describe("chords", () => {
  it("parse from text in any ASCII case, with aliases, and say why text is not one", () => {
    const failures = ["", "mod+", "mod+shift+mod+k", "hyper+k", "mod+k+k", "mod+ "].map((text) => {
      const read = parseChord(text);

      return read._tag === "Invalid";
    });

    expect({
      alias: formatChord(valueOf(parseChord("Cmd+Option+Up"))),
      failures,
      mod: valueOf(parseChord("Mod+Shift+P")),
      plus: formatChord(valueOf(parseChord("ctrl+plus"))),
    }).toStrictEqual({
      alias: "meta+alt+arrowup",
      failures: [true, true, true, true, true, true],
      mod: { alt: false, ctrl: false, key: "p", meta: false, mod: true, shift: true },
      plus: "ctrl+plus",
    });
  });

  it("read back as the same chord, for any chord, and format what they parse the same way again", () => {
    fc.assert(
      fc.property(chord, (one) => {
        const text = formatChord(one);
        const again = valueOf(parseChord(text));

        expect(again).toStrictEqual({ ...one });
        expect(formatChord(again)).toBe(text);
      })
    );
  });

  it("show as each platform writes them", () => {
    expect({
      mac: ["mod+shift+p", "alt+arrowdown", "mod+,", "ctrl+k"].map((text) => shown(text, "Mac")),
      other: ["mod+shift+p", "alt+arrowdown", "mod+,", "meta+k"].map((text) =>
        shown(text, "Other")
      ),
    }).toStrictEqual({
      mac: ["⇧⌘P", "⌥↓", "⌘,", "⌃K"],
      other: ["Ctrl+Shift+P", "Alt+↓", "Ctrl+,", "Meta+K"],
    });
  });

  it("come from key events, Mod being Cmd on a Mac and Ctrl elsewhere", () => {
    const text = chordText;

    expect({
      arrow: text(press("ArrowDown", "ArrowDown", { alt: true }), "Other"),
      // A layout's own letter wins without Alt: AZERTY's A is where QWERTY's Q is.
      azerty: text(press("a", "KeyQ", { ctrl: true }), "Other"),
      comma: text(press(",", "Comma", { ctrl: true }), "Other"),
      // An input method holds the key.
      composing: text(press("Process", "KeyA"), "Other"),
      // A dead key with Option is still its physical letter.
      dead: text(press("Dead", "KeyE", { alt: true }), "Mac"),
      lone: text(press("Shift", "ShiftLeft", { shift: true }), "Other"),
      macCmd: text(press("k", "KeyK", { meta: true }), "Mac"),
      macCtrl: text(press("k", "KeyK", { ctrl: true }), "Mac"),
      // Option on a Mac types another character, so the letter is the physical key's.
      macOption: text(press("˚", "KeyK", { alt: true }), "Mac"),
      shifted: text(press("P", "KeyP", { ctrl: true, shift: true }), "Other"),
      space: text(press(" ", "Space"), "Other"),
    }).toStrictEqual({
      arrow: "alt+arrowdown",
      azerty: "mod+a",
      comma: "mod+,",
      composing: undefined,
      dead: "alt+e",
      lone: undefined,
      macCmd: "mod+k",
      macCtrl: "ctrl+k",
      macOption: "alt+k",
      shifted: "mod+shift+p",
      space: "space",
    });
  });
});

describe("the keymap", () => {
  it("parses every default binding", () => {
    expect(defaultKeymap).toHaveLength(defaultBindings.length);
  });

  it("drops a binding that does not parse or names no command, keeping the rest", () => {
    const keymap = keymapOf([
      { command: "timeline.next", keys: "alt+n" },
      { command: "timeline.next", keys: "alt+" },
      { command: "no.such.command", keys: "alt+m" },
      { command: "timeline.next", keys: "alt+o", when: "editing || palette" },
      { command: "timeline.previous", keys: "alt+p", when: "!editing" },
    ]);

    expect(keymap.map((binding) => formatChord(binding.keys))).toStrictEqual(["alt+n", "alt+p"]);
  });

  it("reads a when of context keys, each perhaps negated, joined by &&", () => {
    expect({
      empty: valueOf(parseWhen("  ")),
      two: valueOf(parseWhen("!editing && palette")),
      unknown: parseWhen("focused")._tag,
    }).toStrictEqual({
      empty: [],
      two: [
        { is: false, key: "editing" },
        { is: true, key: "palette" },
      ],
      unknown: "Invalid",
    });
  });

  it("resolves Mod+K and Mod+Shift+P to opening the palette, while typing too, but not while it is open", () => {
    const k = press("k", "KeyK", { ctrl: true });
    const p = press("P", "KeyP", { ctrl: true, shift: true });
    const opened = [{ _tag: "OpenPalette" }];

    expect({
      k: resolve(defaultKeymap, at(), k),
      mac: resolve(defaultKeymap, at({ platform: "Mac" }), press("k", "KeyK", { meta: true })),
      macCtrl: resolve(defaultKeymap, at({ platform: "Mac" }), k),
      open: resolve(defaultKeymap, at({ palette: true }), k),
      p: resolve(defaultKeymap, at(), p),
      typing: resolve(defaultKeymap, at({ editing: true }), k),
    }).toStrictEqual({
      k: opened,
      mac: opened,
      macCtrl: undefined,
      open: undefined,
      p: opened,
      typing: opened,
    });
  });

  it("jumps to the Timeline calling most with Alt+A, Option+A on a Mac, while typing too", () => {
    const calling: CommandContext = {
      ...inChannel,
      unread: [
        { level: "Message", mark: undefined, timeline: own },
        { level: "Direct", mark: undefined, timeline: direct },
      ],
    };

    expect({
      mac: resolve(
        defaultKeymap,
        at({ editing: true, platform: "Mac" }, calling),
        press("\u00E5", "KeyA", { alt: true })
      ),
      none: resolve(defaultKeymap, at({}, inChannel), press("a", "KeyA", { alt: true })),
      other: resolve(
        defaultKeymap,
        at({ editing: true }, calling),
        press("a", "KeyA", { alt: true })
      ),
    }).toStrictEqual({
      mac: [{ _tag: "Open", timeline: direct }],
      // Nothing calls: the key is still the binding's, so Option+A types nothing.
      none: [],
      other: [{ _tag: "Open", timeline: direct }],
    });
  });

  it("shows or hides the members with Alt+M, Option+M on a Mac, while typing too", () => {
    const turned = [{ _tag: "ShowMembers", shown: undefined }];

    expect({
      mac: resolve(
        defaultKeymap,
        at({ editing: true, platform: "Mac" }),
        press("\u00B5", "KeyM", { alt: true })
      ),
      open: resolve(defaultKeymap, at({ palette: true }), press("m", "KeyM", { alt: true })),
      other: resolve(defaultKeymap, at({ editing: true }), press("m", "KeyM", { alt: true })),
    }).toStrictEqual({ mac: turned, open: undefined, other: turned });
  });

  it("moves to the next and previous Timeline in the sidebar's order, wrapping, while typing too", () => {
    const down = press("ArrowDown", "ArrowDown", { alt: true });
    const up = press("ArrowUp", "ArrowUp", { alt: true });
    const atEnd: CommandContext = { ...inChannel, open: direct };
    const none: CommandContext = { ...inChannel, focus: undefined, open: undefined };

    expect({
      // Only one: nothing to do, but the key is still the binding's.
      alone: resolve(defaultKeymap, at({}, { ...inChannel, timelines: [channel] }), down),
      down: resolve(defaultKeymap, at({ editing: true }), down),
      downNone: resolve(defaultKeymap, at({}, none), down),
      // No Timelines: the key goes through, swallowed by nothing.
      empty: resolve(defaultKeymap, at({}, { ...none, timelines: [] }), down),
      up: resolve(defaultKeymap, at(), up),
      upNone: resolve(defaultKeymap, at({}, none), up),
      wraps: resolve(defaultKeymap, at({}, atEnd), down),
    }).toStrictEqual({
      alone: [],
      down: [{ _tag: "Open", timeline: direct }],
      downNone: [{ _tag: "Open", timeline: own }],
      empty: undefined,
      up: [{ _tag: "Open", timeline: own }],
      upNone: [{ _tag: "Open", timeline: direct }],
      wraps: [{ _tag: "Open", timeline: own }],
    });
  });

  it("does not fire a binding meant for outside a field while typing in one, so the key is typed", () => {
    const i = press("i", "KeyI");

    expect({
      outside: resolve(defaultKeymap, at(), i),
      typing: resolve(defaultKeymap, at({ editing: true }), i),
      unbound: resolve(defaultKeymap, at(), press("j", "KeyJ")),
      withMod: resolve(defaultKeymap, at(), press("i", "KeyI", { ctrl: true })),
    }).toStrictEqual({
      outside: [{ _tag: "FocusComposer", text: undefined }],
      typing: undefined,
      unbound: undefined,
      withMod: undefined,
    });
  });

  it("opens the options with Mod+,", () => {
    expect(resolve(defaultKeymap, at(), press(",", "Comma", { ctrl: true }))).toStrictEqual([
      { _tag: "OpenOptions", filter: "" },
    ]);
  });

  it("shows the search with Mod+Shift+F, while typing too, leaving Mod+F to the browser's find", () => {
    const shown = [{ _tag: "Search", query: undefined }];

    expect({
      find: resolve(defaultKeymap, at(), press("f", "KeyF", { ctrl: true })),
      mac: resolve(
        defaultKeymap,
        at({ platform: "Mac" }),
        press("F", "KeyF", { meta: true, shift: true })
      ),
      open: resolve(
        defaultKeymap,
        at({ palette: true }),
        press("F", "KeyF", { ctrl: true, shift: true })
      ),
      typing: resolve(
        defaultKeymap,
        at({ editing: true }),
        press("F", "KeyF", { ctrl: true, shift: true })
      ),
    }).toStrictEqual({ find: undefined, mac: shown, open: undefined, typing: shown });
  });

  it("respects the bound command's own conditions, and lets a later binding win", () => {
    const keymap = keymapOf([
      { args: "hello", command: "say.privmsg", keys: "alt+h" },
      { command: "timeline.next", keys: "alt+n" },
      { command: "timeline.previous", keys: "alt+n" },
    ]);

    const hello = press("h", "KeyH", { alt: true });
    const offline: CommandContext = { ...inChannel, session: false };

    expect({
      later: resolve(keymap, at(), press("n", "KeyN", { alt: true })),
      offline: resolve(keymap, at({}, offline), hello),
      online: resolve(keymap, at(), hello),
    }).toStrictEqual({
      later: [{ _tag: "Open", timeline: own }],
      offline: undefined,
      online: [
        {
          _tag: "Say",
          kind: "Privmsg",
          network,
          opens: false,
          target: "#iirc",
          text: "hello",
        },
      ],
    });
  });

  it("lists the chords bound to a command with no arguments", () => {
    expect(chordsFor(defaultKeymap, "palette.open").map(formatChord)).toStrictEqual([
      "mod+k",
      "mod+shift+p",
    ]);
    expect(chordsFor(defaultKeymap, "say.privmsg")).toStrictEqual([]);
    expect(key("Up")).toBe("arrowup");
  });
});

describe("keys from layouts other than QWERTY", () => {
  const layoutKeymap = keymapOf([
    ...defaultBindings,
    { command: "timeline.next", keys: "\u00E9", when: "!editing" },
    { command: "timeline.previous", keys: "mod+alt+q" },
    { command: "timeline.next", keys: "mod+alt+k" },
  ]);

  // AZERTY: \u00E9 is unshifted on the key QWERTY has 2 on, and Shift gives 2.
  const eAcute = press("\u00E9", "Digit2");
  // German: AltGr+Q types @. Windows reports Ctrl and Alt as well as AltGraph.
  const altGr = press("@", "KeyQ", { alt: true, altGraph: true, ctrl: true });
  // US: Ctrl+Alt+K is a chord, with no AltGraph.
  const ctrlAltK = press("k", "KeyK", { alt: true, ctrl: true });

  it("keeps the layout's own character with no modifier or Shift alone", () => {
    expect({
      eAcute: chordText(eAcute, "Other"),
      germanO: chordText(press("\u00F6", "Semicolon"), "Other"),
      shifted: chordText(press("2", "Digit2", { shift: true }), "Other"),
      withMod: chordText(press("\u00E9", "Digit2", { ctrl: true }), "Other"),
    }).toStrictEqual({
      eAcute: "\u00E9",
      germanO: "\u00F6",
      shifted: "shift+2",
      withMod: "mod+2",
    });
  });

  it("resolves a binding of the layout's character, outside a field", () => {
    expect({
      editing: resolve(layoutKeymap, at({ editing: true }), eAcute),
      outside: resolve(layoutKeymap, at(), eAcute),
    }).toStrictEqual({ editing: undefined, outside: [{ _tag: "Open", timeline: direct }] });
  });

  it("takes AltGr in a field as typing, not as a Ctrl+Alt binding, and as a chord outside one", () => {
    expect({
      editing: resolve(layoutKeymap, at({ editing: true }), altGr),
      outside: resolve(layoutKeymap, at(), altGr),
    }).toStrictEqual({
      editing: undefined,
      outside: [{ _tag: "Open", timeline: own }],
    });
  });

  it("resolves a Ctrl+Alt chord with no AltGraph in a field, as on a US layout", () => {
    expect({
      // Without AltGraph, the same Ctrl+Alt and a character are a chord.
      altGrOff: resolve(layoutKeymap, at({ editing: true }), { ...altGr, altGraph: false }),
      editing: resolve(layoutKeymap, at({ editing: true }), ctrlAltK),
    }).toStrictEqual({
      altGrOff: [{ _tag: "Open", timeline: own }],
      editing: [{ _tag: "Open", timeline: direct }],
    });
  });

  it("still moves between Timelines with Alt+arrows, in a field too", () => {
    const up = press("ArrowUp", "ArrowUp", { alt: true });

    expect([
      resolve(layoutKeymap, at({ editing: true }), up),
      resolve(layoutKeymap, at({ editing: true }), press("ArrowDown", "ArrowDown", { alt: true })),
    ]).toStrictEqual([[{ _tag: "Open", timeline: own }], [{ _tag: "Open", timeline: direct }]]);
  });
});

describe("the Panes' keys", () => {
  const twoPanes = { ...inChannel, panes: 2 };

  const change = (event: KeyEvent, context: KeyContext = at({ editing: true }, twoPanes)) =>
    resolve(defaultKeymap, context, event)?.map((intent) =>
      intent._tag === "Pane" ? intent.change._tag : intent._tag
    );

  it("splits, closes, zooms, equalizes, grows, shrinks, and moves with Alt+Shift, in a field too", () => {
    const shifted = (letter: string) =>
      press(letter.toUpperCase(), `Key${letter.toUpperCase()}`, { alt: true, shift: true });

    expect({
      close: change(shifted("w")),
      down: change(press("ArrowDown", "ArrowDown", { alt: true, shift: true })),
      equalize: change(shifted("e")),
      grow: change(shifted("g")),
      // Option+Shift+S on a Mac types another character: the physical key names it.
      mac: change(press("Í", "KeyS", { alt: true, shift: true }), {
        ...at({ editing: true, platform: "Mac" }, twoPanes),
      }),
      shrink: change(shifted("r")),
      sideBySide: change(shifted("s")),
      stacked: change(shifted("d")),
      zoom: change(shifted("z")),
    }).toStrictEqual({
      close: ["Close"],
      down: ["Move"],
      equalize: ["Equalize"],
      grow: ["Grow"],
      mac: ["Split"],
      shrink: ["Shrink"],
      sideBySide: ["Split"],
      stacked: ["Split"],
      zoom: ["Zoom"],
    });
  });

  it("lets a Pane's key through with one Pane, but splits", () => {
    const one = at({ editing: true });

    expect({
      close: change(press("W", "KeyW", { alt: true, shift: true }), one),
      left: change(press("ArrowLeft", "ArrowLeft", { alt: true, shift: true }), one),
      split: change(press("S", "KeyS", { alt: true, shift: true }), one),
    }).toStrictEqual({ close: undefined, left: undefined, split: ["Split"] });
  });
});
