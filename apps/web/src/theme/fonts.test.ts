import { readFileSync } from "node:fs";

import { fontNames } from "@iirc/api";
import { describe, expect, it } from "vitest";

import { fontStack } from "./fonts.ts";

// Vitest hands a stylesheet to a test as nothing, even with `?raw`, so it is read as a file.
const fontFaces = readFileSync(new URL("fonts.css", import.meta.url), "utf-8");

/** Each family `fonts.css` declares, with the weights and styles of its faces. */
const declared = new Map<string, Set<string>>();

for (const face of fontFaces.matchAll(/@font-face \{(?<body>[^}]*)\}/gu)) {
  const body = face.groups?.body ?? "";
  const family = /font-family: "(?<name>[^"]+)"/u.exec(body)?.groups?.name ?? "";
  const style = /font-style: (?<style>\w+)/u.exec(body)?.groups?.style ?? "";
  const weight = /font-weight: (?<weight>[\d ]+);/u.exec(body)?.groups?.weight ?? "";
  const faces = declared.get(family) ?? new Set();

  faces.add(`${weight} ${style}`);
  declared.set(family, faces);
}

describe("the fonts", () => {
  it("draw each font named ahead of the device's own, and the device's alone for system", () => {
    expect(fontNames.map(fontStack)).toStrictEqual([
      "var(--font-device)",
      '"JetBrains Mono Variable", var(--font-device)',
      '"IBM Plex Mono", var(--font-device)',
      '"Source Code Pro Variable", var(--font-device)',
      '"Commit Mono", var(--font-device)',
      '"Atkinson Hyperlegible Mono Variable", var(--font-device)',
    ]);
  });

  it("each have a regular, a bold, and both italic, declared once per range, in WOFF2 alone, swapped in as they load", () => {
    const faces = Object.fromEntries(
      [...declared].map(([family, styles]) => [family, [...styles].toSorted()])
    );

    expect({
      display: fontFaces
        .match(/font-display: (?<display>\w+)/gu)
        ?.every((one) => one.endsWith("swap")),
      faces,
      sources: fontFaces
        .match(/src: [^;]+;/gu)
        ?.every((one) =>
          /^src: url\("[^"]+\.woff2"\)\s+format\("woff2(?:-variations)?"\);$/u.test(one)
        ),
    }).toStrictEqual({
      display: true,
      faces: {
        "Atkinson Hyperlegible Mono Variable": ["200 800 italic", "200 800 normal"],
        "Commit Mono": ["400 italic", "400 normal", "700 italic", "700 normal"],
        "IBM Plex Mono": ["400 italic", "400 normal", "700 italic", "700 normal"],
        "JetBrains Mono Variable": ["100 800 italic", "100 800 normal"],
        "Source Code Pro Variable": ["200 900 italic", "200 900 normal"],
      },
      sources: true,
    });
  });
});
