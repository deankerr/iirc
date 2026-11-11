/**
 * Reading a theme's text, through a port: the browser's adapter reads it in a Worker of its
 * own, apart from the page, so a parser that is slow on some text never stalls the page,
 * and ending the Worker ends the read. A test gives its own.
 *
 * @packageDocumentation
 */
import { Palette, ThemeName } from "@iirc/api";
import type { Parsed } from "@iirc/frontend/commands";
import type { Imported } from "@iirc/frontend/theme-import";
import { Context, Effect, Predicate, Schema } from "effect";

/** The host's side of reading a theme. */
export interface ThemeReaderPort {
  /** What the text reads as, or why it does not. Interrupting it ends the read. */
  readonly read: (text: string) => Effect.Effect<Parsed<Imported>>;
}

/** What the Worker answers: the core's `importTheme`, as plain data. */
const Answer = Schema.Union([
  Schema.TaggedStruct("Parsed", {
    value: Schema.Struct({
      format: Schema.Literals([
        "base16",
        "base24",
        "iTerm2",
        "Alacritty",
        "Kitty",
        "Ghostty",
        "Windows Terminal",
      ]),
      name: Schema.UndefinedOr(ThemeName),
      palette: Palette,
    }),
  }),
  Schema.TaggedStruct("Invalid", { message: Schema.String }),
]);

const decodeAnswer = Schema.decodeUnknownOption(Answer);

/** Why a theme could not be read: no Worker could start, or the one that did failed. */
const unreadable: Parsed<Imported> = {
  _tag: "Invalid",
  message: "Theme files cannot be read in this browser, so nothing was imported.",
};

/** What the reader needs of a Worker: to send it text, hear its answer, and end it. */
export interface ReaderWorker {
  readonly addEventListener: (
    type: "message" | "error" | "messageerror",
    listener: (event: Event) => void
  ) => void;
  readonly postMessage: (text: string) => void;
  readonly terminate: () => void;
}

/**
 * A Worker, started, or none when it cannot be, as where there is no `Worker` or the
 * browser refuses one with a `SecurityError`.
 * @param start - Starts a Worker.
 * @returns The Worker, or none.
 */
const started = (start: () => ReaderWorker): ReaderWorker | undefined => {
  try {
    return start();
  } catch {
    return undefined;
  }
};

/**
 * A reader that reads each text in a fresh Worker from `start`, and terminates it once it
 * answers, fails, or the read is interrupted. A Worker that cannot start, that fails, or
 * whose answer cannot be received or parsed gives `unreadable`, in words, never a defect,
 * so the dialog never waits on it.
 * @param start - Starts a Worker.
 * @returns The reader.
 */
export const workerThemeReader = (start: () => ReaderWorker): ThemeReaderPort => ({
  read: (text) =>
    Effect.callback<Parsed<Imported>>((resume) => {
      const worker = started(start);

      if (worker === undefined) {
        resume(Effect.succeed(unreadable));

        return Effect.void;
      }

      const answer = (read: Parsed<Imported>) => {
        resume(Effect.succeed(read));
        worker.terminate();
      };

      worker.addEventListener("message", (event) => {
        const decoded = decodeAnswer(Predicate.hasProperty(event, "data") ? event.data : undefined);

        answer(decoded._tag === "Some" ? decoded.value : unreadable);
      });

      worker.addEventListener("error", () => {
        answer(unreadable);
      });

      worker.addEventListener("messageerror", () => {
        answer(unreadable);
      });

      // A Worker's messages have no origin to name.
      // oxlint-disable-next-line unicorn/require-post-message-target-origin
      worker.postMessage(text);

      return Effect.sync(() => {
        worker.terminate();
      });
    }),
});

/**
 * The browser's reader: a fresh module Worker for each text, built by Vite from
 * `import-worker.ts` into a script of the page's own origin, which the Content Security
 * Policy's `script-src 'self'` allows, as `worker-src` falls back to it.
 */
const browserThemeReader = workerThemeReader(() => {
  const worker = new Worker(new URL("import-worker.ts", import.meta.url), {
    name: "theme-import",
    type: "module",
  });

  return {
    addEventListener: (type, listener) => {
      worker.addEventListener(type, listener);
    },
    postMessage: (text) => {
      // A Worker's messages have no origin to name.
      // oxlint-disable-next-line unicorn/require-post-message-target-origin
      worker.postMessage(text);
    },
    terminate: () => {
      worker.terminate();
    },
  };
});

/** The host's reader of themes: the browser's Worker, unless a test gives its own. */
export class ThemeReader extends Context.Reference<ThemeReaderPort>("@iirc/web/ThemeReader", {
  defaultValue: () => browserThemeReader,
}) {}
