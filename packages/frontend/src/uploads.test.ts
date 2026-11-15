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
  it("holds the first page newest first, with where the next begins and how far it was read", () => {
    const state = after({
      _tag: "Paged",
      after: undefined,
      page: { next: c.id, through: 7, uploads: [e, d, c] },
    });

    expect({ ids: ids(state), next: state.next, through: state.through }).toStrictEqual({
      ids: ["e", "d", "c"],
      next: c.id,
      through: 7,
    });
  });

  it("puts a later page after those held, keeping how far the first was read, and holds nothing twice", () => {
    const state = after(
      { _tag: "Paged", after: undefined, page: { next: c.id, through: 7, uploads: [e, d, c] } },
      { _tag: "Paged", after: c.id, page: { next: null, through: 9, uploads: [c, b, a] } }
    );

    expect({ ids: ids(state), next: state.next, through: state.through }).toStrictEqual({
      ids: ["e", "d", "c", "b", "a"],
      next: null,
      through: 7,
    });
  });

  it("folds a page read twice, or the first page read again, once", () => {
    const first = {
      _tag: "Paged",
      after: undefined,
      page: { next: d.id, through: 5, uploads: [e, d] },
    } as const;

    const second = {
      _tag: "Paged",
      after: d.id,
      page: { next: b.id, through: 5, uploads: [c, b] },
    } as const;

    const state = after(first, second, second, first);

    expect({ ids: ids(state), next: state.next, through: state.through }).toStrictEqual({
      ids: ["e", "d", "c", "b"],
      next: b.id,
      through: 5,
    });
  });

  it("puts a new Upload from the stream first, one held in its place, and follows from the latest", () => {
    const renamed = upload("d", "renamed.png");

    const state = after(
      { _tag: "Paged", after: undefined, page: { next: null, through: 3, uploads: [d, c] } },
      { _tag: "Changed", sequence: 4, upload: e },
      { _tag: "Changed", sequence: 6, upload: renamed }
    );

    expect({
      ids: ids(state),
      shown: state.uploads.map(shownName),
      through: state.through,
    }).toStrictEqual({
      ids: ["e", "d", "c"],
      shown: ["e.png", "renamed.png", "c.png"],
      through: 6,
    });
  });

  it("passes over a Change no later than the last folded in", () => {
    const folded = after(
      { _tag: "Paged", after: undefined, page: { next: null, through: 5, uploads: [d, c] } },
      { _tag: "Changed", sequence: 6, upload: e }
    );

    const old = reduceUploads(folded, { _tag: "Changed", sequence: 5, upload: a });

    expect(reduceUploads(old, { _tag: "Changed", sequence: 6, upload: b })).toStrictEqual(folded);
  });

  it("folds no Change before the first page, which says how far to follow", () => {
    expect(after({ _tag: "Changed", sequence: 4, upload: e })).toStrictEqual(initialUploads);
  });

  it("forgets everything, how far it was folded too", () => {
    expect(
      after(
        { _tag: "Paged", after: undefined, page: { next: null, through: 2, uploads: [a] } },
        { _tag: "Changed", sequence: 3, upload: b },
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
