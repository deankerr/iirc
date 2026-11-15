import { Upload } from "@iirc/api";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  initialUploads,
  linkOf,
  reduceUploads,
  shownName,
  sizeText,
  thumbnailed,
} from "./uploads.ts";
import type { Uploads, UploadsEvent } from "./uploads.ts";

/**
 * An Upload, by a letter that makes its id.
 * @param letter - The letter.
 * @param name - The name it was given, if any.
 * @returns The Upload.
 */
const upload = (letter: string, name?: string) => {
  const given = {
    at: 1_700_000_000_000,
    hash: "0".repeat(64),
    id: letter.repeat(16),
    link: null,
    safeName: `${letter}.png`,
    size: 10,
    type: "image/png",
  };

  return Schema.decodeSync(Upload)(name === undefined ? given : { ...given, name });
};

const [a, b, c, d, e] = ["a", "b", "c", "d", "e"].map((letter) => upload(letter));

if (a === undefined || b === undefined || c === undefined || d === undefined || e === undefined) {
  throw new Error("no Uploads");
}

const after = (...events: readonly UploadsEvent[]): Uploads => {
  let state = initialUploads;

  for (const event of events) {
    state = reduceUploads(state, event);
  }

  return state;
};

const ids = (state: Uploads) => state.uploads.map((one) => one.id[0]);

describe("the Uploads held", () => {
  it("holds the first page newest first, with where the next begins", () => {
    const state = after({
      _tag: "Paged",
      after: undefined,
      page: { next: c.id, uploads: [e, d, c] },
    });

    expect({ ids: ids(state), next: state.next }).toStrictEqual({
      ids: ["e", "d", "c"],
      next: c.id,
    });
  });

  it("puts a later page after those held, and holds nothing twice", () => {
    const state = after(
      { _tag: "Paged", after: undefined, page: { next: c.id, uploads: [e, d, c] } },
      { _tag: "Paged", after: c.id, page: { next: null, uploads: [c, b, a] } }
    );

    expect({ ids: ids(state), next: state.next }).toStrictEqual({
      ids: ["e", "d", "c", "b", "a"],
      next: null,
    });
  });

  it("moves where the next page begins once for a page read twice", () => {
    const first = {
      _tag: "Paged",
      after: undefined,
      page: { next: d.id, uploads: [e, d] },
    } as const;

    const second = { _tag: "Paged", after: d.id, page: { next: b.id, uploads: [c, b] } } as const;
    const state = after(first, second, second);

    expect({ ids: ids(state), next: state.next }).toStrictEqual({
      ids: ["e", "d", "c", "b"],
      next: b.id,
    });
  });

  it("keeps where the next page begins when the first page is read again, with what is new above", () => {
    const state = after(
      { _tag: "Paged", after: undefined, page: { next: c.id, uploads: [d, c] } },
      { _tag: "Paged", after: c.id, page: { next: b.id, uploads: [b] } },
      { _tag: "Paged", after: undefined, page: { next: d.id, uploads: [e, d] } }
    );

    expect({ ids: ids(state), next: state.next }).toStrictEqual({
      ids: ["e", "d", "c", "b"],
      next: b.id,
    });
  });

  it("puts a new Upload from the stream first, and one held in its place", () => {
    const renamed = upload("d", "renamed.png");

    const state = after(
      { _tag: "Paged", after: undefined, page: { next: null, uploads: [d, c] } },
      { _tag: "Changed", upload: e },
      { _tag: "Changed", upload: renamed }
    );

    expect({ ids: ids(state), shown: state.uploads.map(shownName) }).toStrictEqual({
      ids: ["e", "d", "c"],
      shown: ["e.png", "renamed.png", "c.png"],
    });
  });

  it("holds an Upload the stream gave before the first page once, where the page puts it", () => {
    const state = after(
      { _tag: "Changed", upload: e },
      { _tag: "Paged", after: undefined, page: { next: c.id, uploads: [e, d, c] } }
    );

    expect({ ids: ids(state), next: state.next }).toStrictEqual({
      ids: ["e", "d", "c"],
      next: c.id,
    });
  });

  it("forgets everything", () => {
    expect(
      after(
        { _tag: "Paged", after: undefined, page: { next: null, uploads: [a] } },
        { _tag: "Forgotten" }
      )
    ).toStrictEqual(initialUploads);
  });
});

describe("an Upload's link", () => {
  it("joins the public URL in force, the id, and the safe name", () => {
    expect(linkOf("https://files.example.com/u", a)).toBe(
      "https://files.example.com/u/aaaaaaaaaaaaaaaa/a.png"
    );
  });

  it("is none while no public URL is set", () => {
    expect(linkOf(undefined, a)).toBeUndefined();
  });
});

describe("an Upload's name", () => {
  it("is the one given, else the safe name", () => {
    expect([shownName(upload("a", "Cat picture.PNG")), shownName(a)]).toStrictEqual([
      "Cat picture.PNG",
      "a.png",
    ]);
  });
});

describe("a thumbnail", () => {
  it("is drawn for the image types a browser draws, and no other", () => {
    expect(
      [
        "image/png",
        "image/jpeg",
        "image/gif",
        "image/webp",
        "image/avif",
        "IMAGE/PNG",
        "image/svg+xml",
        "image/tiff",
        "video/mp4",
        "application/octet-stream",
      ].map(thumbnailed)
    ).toStrictEqual([true, true, true, true, true, true, false, false, false, false]);
  });
});

describe("a size", () => {
  it("is in binary units, one decimal under 10 and whole past that", () => {
    expect(
      [0, 1023, 1024, 1536, 10_240, 1_258_291, 104_857_600, 1_048_575, 5 * 1024 ** 4, 2 ** 60].map(
        sizeText
      )
    ).toStrictEqual([
      "0 B",
      "1023 B",
      "1.0 KiB",
      "1.5 KiB",
      "10 KiB",
      "1.2 MiB",
      "100 MiB",
      "1.0 MiB",
      "5.0 TiB",
      "1024 PiB",
    ]);
  });
});
