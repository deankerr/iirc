import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { Schema } from "effect";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../../..");

/** One probe file: where it goes, and the lines the fence must refuse or allow. */
interface Probe {
  readonly file: string;
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
    file: "packages/protocol/src/fence-probe.ts",
    refused: [
      'import { Client } from "@iirc/client";',
      'import { Knowledge } from "@iirc/client/known";',
      'import { Effect } from "effect";',
      "export const now = Date.now();",
      "export const random = Math.random();",
    ],
  },
  {
    allowed: ['import { Schema } from "effect";', 'import { Line } from "@iirc/protocol/line";'],
    file: "packages/client/src/fence-probe.ts",
    refused: [
      'import { scripted } from "@iirc/client/testing";',
      'import { readFileSync } from "node:fs";',
      'import { Clock } from "effect";',
      'import * as ClockModule from "effect/Clock";',
      'import { Journal } from "@iirc/runtime/journal";',
      "export const viaGlobal = globalThis.fetch;",
      "export const alias = self;",
      "export const unsafeNow = DateTime.nowUnsafe();",
    ],
  },
  {
    allowed: [
      'import { Effect, Stream } from "effect";',
      'import { Input } from "@iirc/client";',
      'import { Line } from "@iirc/protocol/line";',
    ],
    file: "packages/runtime/src/fence-probe.ts",
    refused: [
      'import { Clock } from "effect";',
      'import * as ClockModule from "effect/Clock";',
      'import { TestClock } from "effect/testing";',
      'import { scripted } from "@iirc/client/testing";',
      'import { makeMemoryVault } from "@iirc/runtime/testing";',
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
    ],
    file: "packages/runtime/src/testing/fence-probe.ts",
    refused: ['import { readFileSync } from "node:fs";', "export const now = Date.now();"],
  },
];

// Writes the probes, lints them with the repository's configuration, and always removes them.
const lint = (): readonly Diagnostic[] => {
  try {
    for (const probe of probes) {
      writeFileSync(
        path.join(root, probe.file),
        `${[...(probe.allowed ?? []), ...probe.refused].join("\n")}\n`
      );
    }

    const linted = spawnSync("bunx", ["oxlint", "--format", "json", ...probes.map((p) => p.file)], {
      cwd: root,
      encoding: "utf-8",
    });

    const report = Schema.decodeSync(Report)(linted.stdout);

    return report.diagnostics.filter((d) => d.code.includes("no-restricted-"));
  } finally {
    for (const probe of probes) {
      rmSync(path.join(root, probe.file), { force: true });
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

describe.each(probes)("the fence around $file", (probe) => {
  const lines = [...(probe.allowed ?? []), ...probe.refused];
  const caught = linesFenced(probe.file);

  it.each(probe.refused)("refuses %s", (line) => {
    expect(caught.has(lines.indexOf(line) + 1)).toBeTruthy();
  });

  it.each(probe.allowed ?? [])("allows %s", (line) => {
    expect(caught.has(lines.indexOf(line) + 1)).toBeFalsy();
  });
});
