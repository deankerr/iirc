/**
 * The theme, as atoms: the one in effect on this device, drawn by the core from its
 * palette, or one previewed, while the palette highlights a theme or the import dialog
 * reads one, in a Worker through the `ThemeReader` port, one text at a time and for at most
 * a second; the text's size and font, or a font the palette highlights; drawing them as CSS
 * custom properties on the document's root; choosing a theme, and importing and removing
 * themes for every device, each made from the options read.
 *
 * @packageDocumentation
 */
import { Themes, fontNames } from "@iirc/api";
import type { FontShown, Palette, ThemeName, UiInForce } from "@iirc/api";
import type { Parsed } from "@iirc/frontend/commands";
import type { Json } from "@iirc/frontend/options";
import {
  cssVariables,
  drawn,
  editThemes,
  listedThemes,
  paletteNamed,
  parseThemeName,
  usable,
} from "@iirc/frontend/theme";
import type { ThemesEdit } from "@iirc/frontend/theme";
import { importLimit, nameFrom } from "@iirc/frontend/theme-import";
import type { Imported } from "@iirc/frontend/theme-import";
import { Effect, Option, Schema } from "effect";
import { Atom } from "effect/reactivity";
import type { AtomRegistry } from "effect/reactivity";

import { DaemonClient } from "../app/daemon-client.ts";
import { runtime } from "../app/runtime.ts";
import { optionsState, signedOut } from "../options/atoms.ts";
import type { Outcome } from "../options/atoms.ts";
import { changeUi, uiFailed, uiInEffect, uiRead } from "../options/ui.ts";
import { paletteHighlight, paletteState } from "../palette/state.ts";
import { signedIn } from "../sign-in/atoms.ts";
import { fontStack } from "./fonts.ts";
import { ThemeReader } from "./reader.ts";

/** The media query whose match says the device prefers dark. */
const darkQuery = "(prefers-color-scheme: dark)";

/** Whether the device prefers dark, as `watchTheme` keeps it. */
const prefersDark = Atom.make(true).pipe(Atom.keepAlive);

/**
 * What the import dialog holds: whether it is open, the text pasted or read from a file,
 * the file's name, and the name the Owner typed, none until they type one.
 */
export interface ImportDraft {
  readonly open: boolean;
  readonly text: string;
  readonly fileName: string | undefined;
  readonly name: string | undefined;
  /** Why the last save did not happen, in words. */
  readonly notice: string | undefined;
}

const closedDraft: ImportDraft = {
  fileName: undefined,
  name: undefined,
  notice: undefined,
  open: false,
  text: "",
};

/** The import dialog's draft. */
export const importDraft = Atom.make(closedDraft).pipe(Atom.keepAlive);

/** How long a theme's text may take to read before its Worker is ended and it is refused. */
const readLimit = "1 second";

/** Why text that took longer than `readLimit` to read was not imported, in words. */
export const tooLong =
  "This took too long to read, so it was not imported. A terminal theme reads at once.";

/** The last text the reader was given, and what it read it as, none while it reads. */
const lastRead = Atom.make<
  { readonly text: string; readonly read: Parsed<Imported> | undefined } | undefined
>(undefined).pipe(Atom.keepAlive);

/**
 * Reads the import dialog's text with the host's reader, in its Worker, one text at a time:
 * a newer text interrupts the read before it, which ends its Worker, and a read that takes
 * longer than `readLimit` is ended too and refused in words.
 */
const readImport = runtime
  .fn((text: string, get) =>
    Effect.gen(function* () {
      const { registry } = get;

      registry.set(lastRead, { read: undefined, text });

      if (text.trim() === "") {
        return;
      }

      const reader = yield* ThemeReader;
      const read = yield* reader.read(text).pipe(Effect.timeoutOption(readLimit));

      registry.set(lastRead, {
        read: Option.getOrElse(read, (): Parsed<Imported> => ({
          _tag: "Invalid",
          message: tooLong,
        })),
        text,
      });
    })
  )
  .pipe(Atom.keepAlive);

/**
 * The theme the import dialog's text reads as, or why it does not, once the reader has
 * answered for the text it holds now, and none while it reads or holds no text.
 */
export const importRead = Atom.make((get) => {
  const { text } = get(importDraft);
  const last = get(lastRead);

  return last?.text === text ? last.read : undefined;
});

/**
 * The name the import dialog offers: the one typed, else the theme's own, else the file's.
 * @param draft - The draft.
 * @param read - What its text reads as.
 * @returns The name.
 */
export const offeredName = (draft: ImportDraft, read: Imported | undefined): string =>
  draft.name ??
  read?.name ??
  (draft.fileName === undefined ? undefined : nameFrom(draft.fileName.replace(/\.[^.]*$/u, ""))) ??
  "";

/**
 * The theme previewed, while there is one: the one the import dialog reads, or the one the
 * open palette highlights.
 */
const previewed = Atom.make((get): Palette | undefined => {
  const draft = get(importDraft);
  const read = get(importRead);

  if (draft.open) {
    return read?._tag === "Parsed" ? read.value.palette : undefined;
  }

  const highlighted = get(paletteHighlight);

  if (!get(paletteState).open || highlighted?.startsWith("theme:") !== true) {
    return undefined;
  }

  const ui = get(uiInEffect);

  return paletteNamed(highlighted.slice("theme:".length), ui.themes, get(prefersDark));
});

/** The theme in effect on this device, or the one previewed, drawn by the core. */
export const drawnTheme = Atom.make((get) => {
  const ui = get(uiInEffect);
  const palette = get(previewed) ?? paletteNamed(ui.theme, ui.themes, get(prefersDark));

  return drawn(palette, ui.colours);
});

/** Each font, by the key of its entry in the palette. */
const fontKeys: ReadonlyMap<string, FontShown> = new Map(
  fontNames.map((font) => [`font:${font}`, font])
);

/**
 * The text's size and font in effect on this device, as the root's custom properties: the
 * font the open palette highlights, while it highlights one, else the one in effect.
 */
const drawnType = Atom.make((get): readonly (readonly [string, string])[] => {
  const ui = get(uiInEffect);
  const highlighted = get(paletteState).open ? get(paletteHighlight) : undefined;
  const font = (highlighted === undefined ? undefined : fontKeys.get(highlighted)) ?? ui.font;

  return [
    ["--font-size", `${ui.size}px`],
    ["--font-mono", fontStack(font)],
  ];
});

/** Every theme there is, and the name of the one in effect here, for the palette to list. */
export const themesListed = Atom.make((get) => {
  const ui = get(uiInEffect);

  return { theme: ui.theme, themes: listedThemes(ui.themes) };
});

/**
 * The shared options: the ones this page holds, or read now when it holds none.
 * @param registry - The registry.
 * @returns The options in force.
 */
const sharedNow = (registry: AtomRegistry.AtomRegistry) =>
  Effect.gen(function* () {
    const held = registry.get(optionsState).ui;

    if (held !== undefined) {
      return held;
    }

    const client = yield* DaemonClient;
    const read: UiInForce = yield* client.ui.read();

    uiRead(registry, read);

    return read;
  });

/**
 * Draws in a theme, for every device or this one, once it names a theme there is: one
 * built in, or one imported, as this device has them.
 * @param registry - The registry.
 * @param name - The theme's name.
 * @param device - Whether for this device alone.
 * @returns What it came to.
 */
export const chooseTheme = (
  registry: AtomRegistry.AtomRegistry,
  name: ThemeName,
  device: boolean
) =>
  Effect.gen(function* () {
    yield* sharedNow(registry);

    const found = usable(name, registry.get(uiInEffect).themes);

    if (found._tag === "Invalid") {
      const refused: Outcome = { _tag: "NotDone", message: found.message };

      return refused;
    }

    return yield* changeUi(registry, { device, option: "theme", value: found.value });
  }).pipe(Effect.catch((error) => Effect.succeed(uiFailed(error._tag))));

const themesJson = Schema.encodeSync(Schema.toCodecJson(Themes));

/** A conflict: the shared options were not the ones the edit was made from. */
const conflict = { _tag: "Conflict" } as const;

/**
 * One try at an edit of the themes imported: the options read, the edit applied to their
 * themes, and the themes sent whole, made from the sequence read.
 * @param registry - The registry.
 * @param edit - The edit.
 * @returns What it came to, or a conflict to try again.
 */
const tryEdit = (registry: AtomRegistry.AtomRegistry, edit: ThemesEdit) =>
  Effect.gen(function* () {
    const client = yield* DaemonClient;
    const read = yield* client.ui.read();

    uiRead(registry, read);

    const themes = editThemes(read.options.themes, edit);

    if (themes._tag === "Invalid") {
      const refused: Outcome = { _tag: "NotDone", message: themes.message };

      return refused;
    }

    const value: Json = themesJson(themes.value);

    yield* client.ui.set({
      params: { option: "themes" },
      payload: { value },
      query: { ifSequence: read.sequence },
    });

    uiRead(registry, yield* client.ui.read());

    const done: Outcome = { _tag: "Done" };

    return done;
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed(error._tag === "UiChanged" ? conflict : uiFailed(error._tag))
    )
  );

/**
 * Imports or removes a theme for every device: made from the options read, and made once
 * more from those read again after a conflict, since an edit is a pure function of the
 * themes, so another device's import in between is kept.
 * @param registry - The registry.
 * @param edit - The edit.
 * @returns What it came to.
 */
export const changeThemes = (registry: AtomRegistry.AtomRegistry, edit: ThemesEdit) =>
  Effect.gen(function* () {
    const first = yield* tryEdit(registry, edit);

    if (first._tag !== "Conflict") {
      return first;
    }

    const second = yield* tryEdit(registry, edit);

    return second._tag === "Conflict" ? uiFailed("UiChanged") : second;
  });

/**
 * Changes what the import dialog holds, and reads its text again when that changed.
 * @param registry - The registry.
 * @param change - The change.
 */
const applyImport = (registry: AtomRegistry.AtomRegistry, change: Partial<ImportDraft>) => {
  registry.set(importDraft, { ...registry.get(importDraft), notice: undefined, ...change });

  if (change.text !== undefined) {
    registry.set(readImport, change.text);
  }
};

/** A file the Owner chose: its name, its size in bytes, and a way to read its text. */
export interface ChosenFile {
  readonly name: string;
  readonly size: number;
  readonly text: () => Promise<string>;
}

/**
 * Reads a file the Owner chose into the import dialog, refusing one over 256 KB unread.
 * One file is read at a time, and only the latest applies: another choice interrupts the
 * read before it, and so do typing, closing the dialog, and its unmounting, so a file that
 * finishes reading late never replaces newer text nor starts a read in a closed dialog.
 */
export const chooseFile = runtime
  .fn((file: ChosenFile, get) =>
    Effect.gen(function* () {
      const { registry } = get;

      if (file.size > importLimit) {
        applyImport(registry, {
          fileName: file.name,
          notice: `${file.name} is longer than 256 KB, which no terminal theme is.`,
          text: "",
        });

        return;
      }

      const text = yield* Effect.tryPromise(file.text).pipe(Effect.option);

      if (registry.get(importDraft).open) {
        applyImport(
          registry,
          Option.isSome(text)
            ? { fileName: file.name, text: text.value }
            : { fileName: file.name, notice: `${file.name} could not be read.`, text: "" }
        );
      }
    })
  )
  .pipe(Atom.keepAlive);

/**
 * Opens the import dialog, empty, or closes it, letting go of what it held, which stops
 * its preview, and interrupting a file's read and a theme's read in flight, which ends its
 * Worker.
 * @param registry - The registry.
 * @param open - Whether to open it.
 */
export const showImport = (registry: AtomRegistry.AtomRegistry, open: boolean) => {
  registry.set(chooseFile, Atom.Interrupt);
  registry.set(importDraft, { ...closedDraft, open });
  registry.set(readImport, "");
};

/** Changes what the import dialog holds, as the Owner types, which lets go of a file's read. */
export const editImport = Atom.fnSync((change: Partial<ImportDraft>, get) => {
  get.registry.set(chooseFile, Atom.Interrupt);
  applyImport(get.registry, change);
}).pipe(Atom.keepAlive);

/** Closes the import dialog, saving nothing. */
export const cancelImport = Atom.fnSync((_: undefined, get) => {
  showImport(get.registry, false);
}).pipe(Atom.keepAlive);

/**
 * Saves the theme the import dialog reads under the name it offers, for every device, and
 * closes it, or says in it why not.
 */
export const saveImport = runtime
  .fn((_: undefined, get) =>
    Effect.gen(function* () {
      const { registry } = get;
      const draft = registry.get(importDraft);
      const read = registry.get(importRead);
      const name = offeredName(draft, read?._tag === "Parsed" ? read.value : undefined);

      const say = (notice: string) => {
        registry.set(importDraft, { ...registry.get(importDraft), notice });
      };

      if (read?._tag !== "Parsed") {
        say(read?.message ?? "Paste a theme, or choose its file, and wait for it to be read.");

        return;
      }

      const parsed = parseThemeName(name);

      if (parsed._tag === "Invalid") {
        say(parsed.message);

        return;
      }

      const outcome = yield* changeThemes(registry, {
        _tag: "Add",
        theme: { name: parsed.value, palette: read.value.palette },
      });

      if (outcome._tag === "NotDone") {
        say(outcome.message);
      } else {
        showImport(registry, false);
      }

      if (outcome._tag === "SignedOut") {
        signedOut(registry);
      }
    })
  )
  .pipe(Atom.keepAlive);

/**
 * Draws the page in the theme in effect, or the one previewed: every colour the core
 * derived as a custom property on the root's style, which a Content Security Policy that
 * refuses inline styles allows, since it is set through the CSSOM, the root's
 * `color-scheme` as the theme is light or dark, and `data-theme` as the name in effect. The
 * text's size and font are custom properties there too. Whether the device prefers dark is
 * followed, for `system`.
 * @param registry - The registry.
 * @returns How to stop.
 */
export const watchTheme = (registry: AtomRegistry.AtomRegistry): (() => void) => {
  const root = document.documentElement;
  const query = window.matchMedia(darkQuery);

  const preferred = () => {
    registry.set(prefersDark, query.matches);
  };

  const draw = () => {
    const theme = registry.get(drawnTheme);

    for (const [name, value] of cssVariables(theme)) {
      root.style.setProperty(name, value);
    }

    root.style.colorScheme = theme.scheme;
    root.dataset.theme = registry.get(uiInEffect).theme;
  };

  const drawType = () => {
    for (const [name, value] of registry.get(drawnType)) {
      root.style.setProperty(name, value);
    }
  };

  preferred();
  query.addEventListener("change", preferred);
  draw();
  drawType();

  const stopTheme = registry.subscribe(drawnTheme, draw);
  const stopType = registry.subscribe(drawnType, drawType);

  // Signing out closes an import, ending its reads, so its preview never reaches the sign-in.
  const stopImport = registry.subscribe(signedIn, (yes) => {
    if (!yes && registry.get(importDraft).open) {
      showImport(registry, false);
    }
  });

  const stopName = registry.subscribe(uiInEffect, draw);

  return () => {
    query.removeEventListener("change", preferred);
    stopTheme();
    stopType();
    stopName();
    stopImport();
  };
};
