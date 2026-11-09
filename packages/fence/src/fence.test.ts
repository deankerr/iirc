import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { Schema } from "effect";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../../..");

/**
 * One probe file: the directory it goes in, and the lines the fence must refuse or allow.
 * A directory that does not exist is made for the run. `{run}` in it names the run, so
 * a directory one run makes holds only that run's probes. `name` starts the file's name, so
 * a probe can be linted under a rule for one file, such as `known.ts`'s.
 */
interface Probe {
  readonly directory: string;
  readonly name?: string;
  readonly refused: readonly string[];
  readonly allowed?: readonly string[];
}

/** What oxlint reports with `--format json`, as far as these tests read it. */
const Report = Schema.fromJsonString(
  Schema.Struct({
    diagnostics: Schema.Array(
      Schema.Struct({
        code: Schema.String,
        filename: Schema.String,
        labels: Schema.Array(Schema.Struct({ span: Schema.Struct({ line: Schema.Int }) })),
      })
    ),
  })
);

type Diagnostic = (typeof Report.Type)["diagnostics"][number];

const probes: readonly Probe[] = [
  {
    allowed: ['import { DateTime as Time, Schema } from "effect";'],
    directory: "packages/protocol/src",
    refused: [
      'import { Client } from "@iirc/client";',
      'import { Knowledge } from "@iirc/client/known";',
      'import { Effect } from "effect";',
      'import { nowUnsafe } from "effect/DateTime";',
      'export { Journal } from "../../runtime/src/journal.ts";',
      'import { Input } from "@iirc/client/src/input.ts";',
      'export { TestClock } from "effect/testing";',
      "export const now = Date.now();",
      "export const formatted = new Intl.DateTimeFormat().format();",
      "export const instant = Temporal.Now;",
      'console.log("hello");',
      'import { Console } from "effect";',
      "export const random = Math.random();",
      "export const aliased = Time.nowUnsafe();",
      "export const { isPastUnsafe } = Time;",
    ],
  },
  {
    allowed: ['import { Schema } from "effect";', 'import { Line } from "@iirc/protocol/line";'],
    directory: "packages/client/src",
    refused: [
      'import { scripted } from "@iirc/client/testing";',
      'export { scripted } from "./testing";',
      'import { readFileSync } from "node:fs";',
      'import { Clock } from "effect";',
      'import * as ClockModule from "effect/Clock";',
      'import * as DateTimeModule from "effect/DateTime";',
      'import { Journal } from "@iirc/runtime/journal";',
      'import { Journal as Relative } from "../../runtime/src/journal.ts";',
      'export { TestClock } from "effect/testing";',
      "export const viaGlobal = globalThis.fetch;",
      "export const alias = self;",
      "export const unsafeNow = DateTime.nowUnsafe();",
      "export const zone = DateTimeModule.zoneMakeLocal();",
    ],
  },
  {
    allowed: [
      'import { Effect, Stream } from "effect";',
      'import { Effect as Fx } from "effect";',
      'import { Input } from "@iirc/client";',
      'import { Line } from "@iirc/protocol/line";',
      'import { Journal } from "./journal.ts";',
    ],
    directory: "packages/runtime/src",
    refused: [
      'import { Clock } from "effect";',
      'import * as ClockModule from "effect/Clock";',
      'import { nowUnsafe } from "effect/DateTime";',
      'import { TestClock } from "effect/testing";',
      'import { scripted } from "@iirc/client/testing";',
      'import { makeMemoryVault } from "@iirc/runtime/testing";',
      'export { makeMemoryTransport } from "./testing";',
      'export { makeMemoryJournal } from "./testing/memory-journal.ts";',
      'import { Client } from "../../client/src/client.ts";',
      'import { DateTime } from "effect";',
      'import * as DateTimeModule from "effect/DateTime";',
      "export const clockRead = Effect.clockWith;",
      'import { clockWith } from "effect/Effect";',
      "export const aliasedClock = Fx.clockWith;",
      'console.log("hello");',
      "export const formatted = new Intl.DateTimeFormat().format();",
      'import { serve } from "bun";',
      'import { Socket } from "effect/unstable/socket";',
      'import { BunSocket } from "@effect/platform-bun";',
      'import { Timeline } from "@iirc/views";',
      "export const viaGlobal = globalThis.Date.now();",
      "export const request = fetch;",
      "export const bytes = crypto;",
      "export const random = Math.random();",
      "export const unsafeNow = DateTime.nowUnsafe();",
    ],
  },
  {
    allowed: [
      'import { Clock } from "effect";',
      'import { TestClock } from "effect/testing";',
      'import { scripted } from "@iirc/client/testing";',
      'import { Journal } from "../journal.ts";',
    ],
    directory: "packages/runtime/src/testing",
    refused: [
      'import { readFileSync } from "node:fs";',
      'import { scripted as relative } from "../../../client/src/testing/scripted.ts";',
      'import { nowUnsafe } from "effect/DateTime";',
      "export const now = Date.now();",
    ],
  },
  {
    allowed: ['import { Instant } from "./ids.ts";'],
    directory: "packages/client/src",
    name: "known-fence-probe",
    refused: [
      'import { Input } from "./input.ts";',
      'export { scripted } from "./testing/scripted.ts";',
      'export { scripted as kit } from "@iirc/client/testing";',
      'export { TestClock } from "effect/testing";',
      'import { Line } from "@iirc/protocol/line";',
      'export { Schema } from "effect";',
    ],
  },
  {
    // A file deeper inside a package may still reach its siblings by a relative path.
    allowed: ['import { Journal } from "../../journal.ts";'],
    directory: "packages/runtime/src/fence-deep-{run}/inner",
    refused: [
      'import { Client } from "../../../../client/src/client.ts";',
      'export { makeMemoryJournal } from "../../testing/memory-journal.ts";',
      'export { makeMemoryVault } from "../../testing";',
    ],
  },
];

const linesOf = (probe: Probe) => [...(probe.allowed ?? []), ...probe.refused];

// Each run names its probes for itself and creates them exclusively, so it never
// overwrites a file, and removes only the files it created.
const run = `${process.pid}-${Date.now()}`;

const directoryOf = (probe: Probe) => probe.directory.replace("{run}", run);

const files = probes.map((probe, index) =>
  path.join(directoryOf(probe), `${probe.name ?? "fence-probe"}-${run}-${index}.ts`)
);

const lint = (): readonly Diagnostic[] => {
  const created: string[] = [];
  const made: string[] = [];

  try {
    for (const [index, probe] of probes.entries()) {
      const file = files[index] ?? "";
      const directory = mkdirSync(path.join(root, directoryOf(probe)), { recursive: true });

      if (directory !== undefined) {
        made.push(directory);
      }

      writeFileSync(path.join(root, file), `${linesOf(probe).join("\n")}\n`, { flag: "wx" });
      created.push(file);
    }

    const linted = spawnSync("bunx", ["oxlint", "--format", "json", ...files], {
      cwd: root,
      encoding: "utf-8",
    });

    return Schema.decodeSync(Report)(linted.stdout).diagnostics.filter((d) =>
      d.code.includes("no-restricted-")
    );
  } finally {
    for (const file of created) {
      rmSync(path.join(root, file));
    }

    // Only this run made these, and only its own probes were in them.
    for (const directory of made.toReversed()) {
      rmSync(directory, { recursive: true });
    }
  }
};

const fenced = lint();

const linesFenced = (file: string) =>
  new Set(
    fenced
      .filter((d) => d.filename === file)
      .flatMap((d) => d.labels.map((label) => label.span.line))
  );

describe.each(probes.map((probe, index) => ({ ...probe, file: files[index] ?? "" })))(
  "the fence around $directory",
  (probe) => {
    const lines = linesOf(probe);
    const caught = linesFenced(probe.file);

    it.each(probe.refused)("refuses %s", (line) => {
      expect(caught.has(lines.indexOf(line) + 1)).toBeTruthy();
    });

    it.each(probe.allowed ?? [])("allows %s", (line) => {
      expect(caught.has(lines.indexOf(line) + 1)).toBeFalsy();
    });
  }
);
