import { Upload } from "@iirc/api";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  editFailureText,
  initialUploadEdits,
  initialUploads,
  linkOf,
  nameOf,
  reduceUploadEdits,
  reduceUploads,
  shownName,
  sizeText,
  thumbnailed,
} from "./uploads.ts";
import type { UploadEdits, UploadEditsEvent, Uploads, UploadsEvent } from "./uploads.ts";

/**
 * An Upload, by a letter that makes its id.
 * @param letter - The letter.
 * @param name - The name it was given, if any.
 * @param at - When it was uploaded.
 * @returns The Upload.
 */
const upload = (letter: string, name?: string, at = 1_700_000_000_000) => {
  const given = {
    at,
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

/**
 * An Upload as it is once deleted.
 * @param one - The Upload.
 * @returns It, deleted.
 */
const deleted = (one: typeof a) =>
  Schema.decodeSync(Upload)({
    ...Schema.encodeSync(Upload)(one),
    deleted: { at: 1_700_000_000_500, why: "owner" },
    link: null,
  });

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

  it("drops an Upload a Change says was deleted, and never holds a deleted one it did not", () => {
    const state = after(
      { _tag: "Paged", after: undefined, page: { next: null, through: 3, uploads: [d, c] } },
      { _tag: "Changed", sequence: 4, upload: deleted(d) },
      { _tag: "Changed", sequence: 5, upload: deleted(e) }
    );

    expect({ ids: ids(state), through: state.through }).toStrictEqual({ ids: ["c"], through: 5 });
  });

  it("passes over a Change of an Upload older than those held while a page not yet read holds it", () => {
    const old = upload("a", "renamed.png", 1_600_000_000_000);
    const newer = upload("f", undefined, 1_800_000_000_000);

    const state = after(
      { _tag: "Paged", after: undefined, page: { next: c.id, through: 3, uploads: [d, c] } },
      { _tag: "Changed", sequence: 4, upload: old },
      { _tag: "Changed", sequence: 5, upload: newer }
    );

    expect({ ids: ids(state), through: state.through }).toStrictEqual({
      ids: ["f", "d", "c"],
      through: 5,
    });
  });

  it("takes the Daemon's answer to a rename in place, and to a delete by dropping it, ahead of its Change", () => {
    const renamed = upload("d", "renamed.png");
    const gone = deleted(c);

    const state = after(
      { _tag: "Paged", after: undefined, page: { next: null, through: 3, uploads: [d, c] } },
      { _tag: "Answered", upload: renamed },
      { _tag: "Answered", upload: gone },
      // One not held, as one another device deleted, is left alone.
      { _tag: "Answered", upload: e }
    );

    expect({
      shown: state.uploads.map(shownName),
      through: state.through,
    }).toStrictEqual({ shown: ["renamed.png"], through: 3 });
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

const edits = (...events: readonly UploadEditsEvent[]): UploadEdits => {
  let state = initialUploadEdits;

  for (const event of events) {
    state = reduceUploadEdits(state, event);
  }

  return state;
};

describe("renaming and deleting from the list", () => {
  it("asks before deleting, and asks nothing once let go", () => {
    expect({
      asked: edits({ _tag: "AskedToDelete", id: a.id }).asking,
      closed: edits({ _tag: "AskedToDelete", id: a.id }, { _tag: "Closed" }).asking,
    }).toStrictEqual({ asked: a.id, closed: undefined });
  });

  it("closes the question as the delete is sent, and holds what each Upload is waiting on", () => {
    const state = edits(
      { _tag: "AskedToDelete", id: a.id },
      { _tag: "Sent", id: a.id, of: "Delete" },
      { _tag: "Sent", id: b.id, of: "Rename" }
    );

    expect({ asking: state.asking, doing: [...state.doing] }).toStrictEqual({
      asking: undefined,
      doing: [
        [a.id, { _tag: "Waiting", of: "Delete" }],
        [b.id, { _tag: "Waiting", of: "Rename" }],
      ],
    });
  });

  it("lets go of an Upload done, and keeps why one failed until it is tried again", () => {
    const failed = edits(
      { _tag: "Sent", id: a.id, of: "Rename" },
      { _tag: "Sent", id: b.id, of: "Delete" },
      { _tag: "Answered", failure: { _tag: "JournalFailed" }, id: a.id },
      { _tag: "Answered", failure: undefined, id: b.id }
    );

    expect({
      again: [...reduceUploadEdits(failed, { _tag: "Sent", id: a.id, of: "Rename" }).doing],
      failed: [...failed.doing],
    }).toStrictEqual({
      again: [[a.id, { _tag: "Waiting", of: "Rename" }]],
      failed: [[a.id, { _tag: "Failed", failure: { _tag: "JournalFailed" }, of: "Rename" }]],
    });
  });

  it("forgets everything on signing out", () => {
    expect(
      edits(
        { _tag: "AskedToDelete", id: a.id },
        { _tag: "Sent", id: b.id, of: "Rename" },
        {
          _tag: "Forgotten",
        }
      )
    ).toStrictEqual(initialUploadEdits);
  });
});

describe("a name typed for an Upload", () => {
  it("is the text as typed, of 1 to 1024 code units", () => {
    expect([nameOf("cat.png"), nameOf(" spaced "), nameOf("x".repeat(1024))]).toStrictEqual([
      "cat.png",
      " spaced ",
      "x".repeat(1024),
    ]);
  });

  it("is none when empty or too long", () => {
    expect([nameOf(""), nameOf("x".repeat(1025))]).toStrictEqual([undefined, undefined]);
  });
});

describe("why a rename or a delete did not go as asked, in words", () => {
  it("says the Daemon no longer has it", () => {
    expect(editFailureText({ _tag: "UnknownUpload" }, "cat.png", "Delete")).toBe(
      "The Daemon no longer has cat.png, so it was not deleted."
    );
  });

  it("says the Journal could not be written", () => {
    expect(editFailureText({ _tag: "JournalFailed" }, "cat.png", "Rename")).toBe(
      "The Daemon could not write its Journal, so cat.png was not renamed."
    );
  });

  it("says whether it was done is unknown without an answer, or one it could not read", () => {
    expect([
      editFailureText({ _tag: "NoAnswer" }, "cat.png", "Rename"),
      editFailureText({ _tag: "Unexpected" }, "cat.png", "Delete"),
    ]).toStrictEqual([
      "The Daemon did not answer, so whether cat.png was renamed is unknown.",
      "The Daemon answered in a way the Frontend could not read, so whether cat.png was deleted is unknown.",
    ]);
  });
});
