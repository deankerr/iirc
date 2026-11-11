/**
 * The Worker a theme is read in, apart from the page, so text that a parser reads slowly
 * can never stall it: it reads each text it is sent with the core's `importTheme` and
 * sends back what it read, or why not, as plain data.
 *
 * @packageDocumentation
 */
import type { Parsed } from "@iirc/frontend/commands";
import { importTheme } from "@iirc/frontend/theme-import";
import type { Imported } from "@iirc/frontend/theme-import";
import { Schema } from "effect";

/** What a dedicated Worker's global scope offers here: messages in and out. */
interface WorkerScope {
  readonly addEventListener: (
    type: "message",
    listener: (event: MessageEvent<unknown>) => void
  ) => void;
  readonly postMessage: (message: Parsed<Imported>) => void;
}

// SAFETY: this module runs only as a dedicated Worker's script, whose global scope has these.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion, anti-slop/no-chained-type-assertions -- a Worker's scope, which the DOM's types do not describe.
const scope = globalThis as unknown as WorkerScope;

const decodeText = Schema.decodeUnknownOption(Schema.String);

scope.addEventListener("message", (event) => {
  const text = decodeText(event.data);

  if (text._tag === "Some") {
    // A Worker's messages have no origin to name.
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    scope.postMessage(importTheme(text.value));
  }
});
