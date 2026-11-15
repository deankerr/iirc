import { TimelineId } from "@iirc/api";
import { Schema } from "effect";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { draftOf, initialComposers, reduceComposers } from "./composer.ts";
import type { Composers, Place } from "./composer.ts";
import {
  anchorAfter,
  caretAfter,
  checking,
  editOf,
  failureOf,
  failureText,
  followed,
  heldBack,
  initialUploading,
  insertLink,
  noteIn,
  offNote,
  pendingIn,
  reduceUploading,
  sending,
  uploaded,
} from "./uploading.ts";
import type { AddedFile, Readiness, Uploading, UploadingEvent } from "./uploading.ts";

const place: Place = Schema.decodeSync(TimelineId)("00000000000002-00000000-00000000");
const elsewhere: Place = Schema.decodeSync(TimelineId)("00000000000003-00000000-00000000");

const mib = 1024 * 1024;

const file = (key: string, size = 10, name = `${key}.png`): AddedFile => ({
  key,
  name,
  size,
  type: "image/png",
});

const fold = (state: Uploading, ...events: readonly UploadingEvent[]) => {
  let folded = state;

  for (const event of events) {
    folded = reduceUploading(folded, event);
  }

  return folded;
};

const typed = (composers: Composers, text: string, at: Place = place) =>
  reduceComposers(composers, { _tag: "Edited", text, timeline: at });

/**
 * Files added to a composer with its caret at `anchor`, and what the Daemon said of whether
 * Uploads are on.
 * @param anchor - Where the caret was.
 * @param files - The files.
 * @param readiness - What the Daemon said.
 * @param at - The composer's place.
 * @returns The events.
 */
const arrived = (
  anchor: number,
  files: readonly AddedFile[],
  readiness: Readiness,
  at: Place = place
): readonly UploadingEvent[] => [
  { _tag: "Added", anchor, files, place: at },
  { _tag: "Checked", keys: files.map((one) => one.key), readiness },
];

const on: Readiness = { _tag: "On", maxSize: 100 * mib };

/**
 * Files added to the composer at `place` with its caret at `anchor`, while Uploads are on.
 * @param anchor - Where the caret was.
 * @param files - The files.
 * @returns What is pending.
 */
const addedAt = (anchor: number, ...files: readonly AddedFile[]) =>
  fold(initialUploading, ...arrived(anchor, files, on));

/**
 * Edits a draft with its files pending, as the composer does: the text changes, and each
 * anchor follows it.
 * @param state - What is pending, and the composers.
 * @param text - The text after.
 * @returns Both, after.
 */
const edited = (
  state: { readonly uploading: Uploading; readonly composers: Composers },
  text: string
) => {
  const composers = typed(state.composers, text);

  return { composers, uploading: followed(state.uploading, state.composers, composers) };
};

const keep = (
  state: { readonly uploading: Uploading; readonly composers: Composers },
  key: string,
  link: string | null = `https://f.test/${key}`
) => {
  const kept = uploaded(state.uploading, state.composers, key, link);

  return { composers: kept.composers, uploading: kept.state };
};

const textOf = (state: { readonly composers: Composers }) => draftOf(state.composers, place).text;

describe("where an anchor goes as the draft is edited", () => {
  it("stays where an edit is wholly after it", () => {
    expect(anchorAfter(2, "hi there", "hi there, you")).toBe(2);
  });

  it("moves by the change in length when an edit is wholly before it", () => {
    expect(anchorAfter(6, "hello world", "hey world")).toBe(4);
  });

  it("goes to the end of the replacement when an edit spans it", () => {
    expect(anchorAfter(3, "abcdef", "aXYZf")).toBe(4);
  });

  it("stays before text typed exactly at it, so the text goes after the link", () => {
    expect(anchorAfter(0, "", "a caption")).toBe(0);
    expect(anchorAfter(3, "hi ", "hi there")).toBe(3);
  });

  it("is clamped to the text when the draft is cleared", () => {
    expect(anchorAfter(5, "hello", "")).toBe(0);
  });

  it("follows the edit the Owner made where text repeats, not the first it could be", () => {
    // Between the words of "hi hi", the first "hi " selected and deleted.
    expect(anchorAfter(3, "hi hi", "hi", { caret: 0, from: 0 })).toBe(0);
  });

  it("stays before text typed at it, with the selection known", () => {
    expect(anchorAfter(3, "hi hi", "hi hhi", { caret: 4, from: 3 })).toBe(3);
  });

  it("moves back with a Backspace before it", () => {
    expect(editOf("aa", "a", { caret: 0, from: 1 })).toStrictEqual({
      newEnd: 0,
      oldEnd: 1,
      start: 0,
    });
    expect(anchorAfter(2, "aa", "a", { caret: 0, from: 1 })).toBe(1);
  });

  it("stays with a forward delete after it", () => {
    expect(editOf("aa", "a", { caret: 1, from: 1 })).toStrictEqual({
      newEnd: 1,
      oldEnd: 2,
      start: 1,
    });
    expect(anchorAfter(1, "aa", "a", { caret: 1, from: 1 })).toBe(1);
  });

  it("goes to the end of what replaced a selection across it", () => {
    // "bb b" selected across the anchor and replaced by "X".
    expect(anchorAfter(3, "abb bbc", "aXc", { caret: 2, from: 1 })).toBe(2);
  });

  it("finds the edit from the texts when the selection does not explain it", () => {
    // An undo, which the selection before says nothing of.
    expect(editOf("hello world", "hey world", { caret: 0, from: 11 })).toStrictEqual(
      editOf("hello world", "hey world")
    );
    expect(anchorAfter(6, "hello world", "hey world", { caret: 0, from: 11 })).toBe(4);
  });

  it("stays within the text, whatever the edit", () => {
    let within = true;

    fc.assert(
      fc.property(fc.string(), fc.string(), fc.nat(), (before, after, at) => {
        const anchor = anchorAfter(at % (before.length + 1), before, after);

        within &&= anchor >= 0 && anchor <= after.length;
      })
    );

    expect(within).toBeTruthy();
  });
});

describe("putting a link into the draft", () => {
  it("adds a space on whichever side touches a character", () => {
    expect(insertLink("look", 4, "L").text).toBe("look L");
    expect(insertLink("caption", 0, "L").text).toBe("L caption");
    expect(insertLink("ab", 1, "L")).toStrictEqual({ at: 1, length: 3, text: "a L b" });
  });

  it("adds no space beside whitespace or the ends", () => {
    expect(insertLink("", 0, "L").text).toBe("L");
    expect(insertLink("a  b", 2, "L").text).toBe("a L b");
  });

  it("moves a caret at or after it past the link, and leaves one before it", () => {
    const insertion = insertLink("ab", 1, "L");

    expect([
      caretAfter(0, insertion),
      caretAfter(1, insertion),
      caretAfter(2, insertion),
    ]).toStrictEqual([0, 4, 5]);
  });

  it("goes where the caret was when the file was added, whatever was typed meanwhile", () => {
    const start = {
      composers: typed(initialComposers, "see  please"),
      uploading: addedAt(4, file("a")),
    };

    const after = keep(edited(edited(start, "Do see  please"), "Do see  please!"), "a");

    expect(textOf(after)).toBe("Do see https://f.test/a please!");
  });

  it("leads a caption typed after a screenshot was pasted", () => {
    const start = { composers: initialComposers, uploading: addedAt(0, file("a")) };

    expect(textOf(keep(edited(start, "a cat"), "a"))).toBe("https://f.test/a a cat");
  });

  it("lands several files added at one caret in the order added, whatever order they finish in", () => {
    const start = {
      composers: typed(initialComposers, "x"),
      uploading: addedAt(1, file("a"), file("b"), file("c")),
    };

    const after = keep(keep(keep(start, "b"), "c"), "a");

    expect(textOf(after)).toBe("x https://f.test/a https://f.test/b https://f.test/c");
  });

  it("moves an anchor after the link on past it, and leaves one before it", () => {
    const composers = typed(initialComposers, "one two");

    const uploading = fold(
      addedAt(7, file("late")),
      ...arrived(0, [file("early")], { _tag: "On", maxSize: 100 }, place),
      ...arrived(3, [file("middle")], { _tag: "On", maxSize: 100 }, place)
    );

    const after = keep(keep(keep({ composers, uploading }, "middle"), "late"), "early");

    expect(textOf(after)).toBe(
      "https://f.test/early one https://f.test/middle two https://f.test/late"
    );
  });

  it("puts nothing in when no public URL gives a link, and notes that Uploads are off", () => {
    const after = keep(
      { composers: typed(initialComposers, "hi"), uploading: addedAt(2, file("a")) },
      "a",
      null
    );

    expect({
      note: noteIn(after.uploading, place),
      pending: after.uploading.pending,
      text: textOf(after),
    }).toStrictEqual({ note: ["uploads.publicUrl"], pending: [], text: "hi" });
  });

  it("puts nothing in for a file cancelled before it was kept", () => {
    const start = { composers: initialComposers, uploading: addedAt(0, file("a")) };
    const cancelled = { ...start, uploading: fold(start.uploading, { _tag: "Dropped", key: "a" }) };

    expect(textOf(keep(cancelled, "a"))).toBe("");
  });

  it("follows a draft that came to show its Timeline", () => {
    const draft: Place = "draft libera peer";
    const composers = typed(initialComposers, "hi", draft);

    const uploading = fold(
      initialUploading,
      ...arrived(2, [file("a")], { _tag: "On", maxSize: 100 }, draft)
    );

    const carried = reduceComposers(composers, { _tag: "Carried", from: draft, to: elsewhere });
    const kept = uploaded(followed(uploading, composers, carried), carried, "a", "L");

    expect(draftOf(kept.composers, elsewhere).text).toBe("hi L");
  });
});

describe("adding files", () => {
  it("holds each file at once, checking, its place in the draft fixed as it is added", () => {
    const state = fold(
      initialUploading,
      { _tag: "Added", anchor: 0, files: [file("a")], place },
      { _tag: "Added", anchor: 0, files: [file("b")], place },
      // The second answer arrives first.
      { _tag: "Checked", keys: ["b"], readiness: on },
      { _tag: "Checked", keys: ["a"], readiness: on }
    );

    const start = { composers: initialComposers, uploading: state };

    expect(textOf(keep(keep(start, "b"), "a"))).toBe("https://f.test/a https://f.test/b");
  });

  it("follows the draft while Uploads are asked about, edits and all", () => {
    const composers = typed(initialComposers, "abcdef");

    const uploading = fold(initialUploading, {
      _tag: "Added",
      anchor: 3,
      files: [file("a")],
      place,
    });

    const during = edited(edited({ composers, uploading }, "Xabcdef"), "XabcdefY");

    const after = keep(
      {
        ...during,
        uploading: fold(during.uploading, { _tag: "Checked", keys: ["a"], readiness: on }),
      },
      "a"
    );

    expect(textOf(after)).toBe("Xabc https://f.test/a defY");
  });

  it("follows a draft carried to its Timeline while Uploads are asked about", () => {
    const draft: Place = "draft libera peer";
    const composers = typed(initialComposers, "hi", draft);

    const uploading = fold(initialUploading, {
      _tag: "Added",
      anchor: 2,
      files: [file("a")],
      place: draft,
    });

    const carried = reduceComposers(composers, { _tag: "Carried", from: draft, to: elsewhere });

    const answered = fold(followed(uploading, composers, carried), {
      _tag: "Checked",
      keys: ["a"],
      readiness: on,
    });

    expect(draftOf(uploaded(answered, carried, "a", "L").composers, elsewhere).text).toBe("hi L");
  });

  it("sends nothing of a file cancelled while Uploads are asked about", () => {
    const state = fold(
      initialUploading,
      { _tag: "Added", anchor: 0, files: [file("a")], place },
      { _tag: "Dropped", key: "a" },
      { _tag: "Checked", keys: ["a"], readiness: on }
    );

    expect({ pending: state.pending, sending: [...sending(state)] }).toStrictEqual({
      pending: [],
      sending: [],
    });
  });

  it("checks a file until the Daemon says whether Uploads are on", () => {
    const state = fold(initialUploading, {
      _tag: "Added",
      anchor: 0,
      files: [file("a")],
      place,
    });

    expect({ checking: [...checking(state)], sending: [...sending(state)] }).toStrictEqual({
      checking: ["a"],
      sending: [],
    });
  });

  it("refuses a file over maxSize before it is sent, saying the limit", () => {
    const state = fold(
      initialUploading,
      ...arrived(
        0,
        [file("big", 120 * mib, "cat.mp4"), file("small")],
        { _tag: "On", maxSize: 100 * mib },
        place
      )
    );

    expect({
      sending: [...sending(state)],
      words: pendingIn(state, place).map((one) => failureText({ ...one, failure: failureOf(one) })),
    }).toStrictEqual({
      sending: ["small"],
      words: ["cat.mp4 is 120 MiB, over the 100 MiB limit.", undefined],
    });
  });

  it("adds nothing while Uploads are off, and notes the options to set", () => {
    const state = fold(
      initialUploading,
      ...arrived(
        0,
        [file("a")],
        { _tag: "Off", maxSize: 100, missing: ["store.s3.bucket", "uploads.publicUrl"] },
        place
      )
    );

    expect({ note: noteIn(state, place), pending: state.pending }).toStrictEqual({
      note: ["store.s3.bucket", "uploads.publicUrl"],
      pending: [],
    });
  });

  it("lets the note go once files are added while Uploads are on", () => {
    const state = fold(
      initialUploading,
      ...arrived(
        0,
        [file("a")],
        { _tag: "Off", maxSize: 100, missing: ["uploads.publicUrl"] },
        place
      ),
      ...arrived(0, [file("b")], { _tag: "On", maxSize: 100 }, place)
    );

    expect(noteIn(state, place)).toBeUndefined();
  });

  it("notes that Uploads are off when the Daemon says so as a file is sent, and lets the file go", () => {
    const state = fold(addedAt(0, file("a")), {
      _tag: "Off",
      key: "a",
      missing: ["store.s3.bucket"],
    });

    expect({ note: noteIn(state, place), pending: state.pending }).toStrictEqual({
      note: ["store.s3.bucket"],
      pending: [],
    });
  });

  it("fails each file, sending none, when the Daemon did not say whether Uploads are on", () => {
    const state = fold(initialUploading, ...arrived(0, [file("a")], { _tag: "NoAnswer" }, place));

    expect({
      sending: [...sending(state)],
      words: state.pending.map((one) => failureText({ ...one, failure: failureOf(one) })),
    }).toStrictEqual({
      sending: [],
      words: ["The Daemon did not answer, so a.png was not sent."],
    });
  });

  it("keeps how much of a file was sent, as the browser says", () => {
    const state = fold(addedAt(0, file("a", 100)), {
      _tag: "Progressed",
      key: "a",
      loaded: 40,
      total: 100,
    });

    expect(state.pending[0]?.stage).toStrictEqual({
      _tag: "Sending",
      progress: { loaded: 40, total: 100 },
    });
  });
});

describe("sending a draft while its files upload", () => {
  const composers = typed(initialComposers, "look");

  it("holds the draft back while a file is checked or sent, saying which", () => {
    const one = fold(initialUploading, {
      _tag: "Added",
      anchor: 4,
      files: [file("cat")],
      place,
    });

    const two = fold(addedAt(4, file("a")), {
      _tag: "Added",
      anchor: 4,
      files: [file("b")],
      place,
    });

    expect([heldBack(one, composers, place), heldBack(two, composers, place)]).toStrictEqual([
      "Wait for cat.png to finish uploading, or cancel it.",
      "Wait for a.png and b.png to finish uploading, or cancel them.",
    ]);
  });

  it("holds nothing back for a failed file, or for another composer's", () => {
    const failed = fold(addedAt(4, file("a")), {
      _tag: "Failed",
      failure: { _tag: "StoreUnavailable" },
      key: "a",
    });

    expect([
      heldBack(failed, composers, place),
      heldBack(addedAt(4, file("a")), composers, elsewhere),
    ]).toStrictEqual([undefined, undefined]);
  });

  it("holds nothing back for a draft typing a Credential's value, so it is let go of", () => {
    const credential = typed(initialComposers, "/set store.s3.secretAccessKey hunter2");

    expect(heldBack(addedAt(0, file("a")), credential, place)).toBeUndefined();
  });
});

describe("the note while Uploads are off", () => {
  it("names one option", () => {
    expect(offNote(["uploads.publicUrl"])).toBe("Uploads are off until uploads.publicUrl is set.");
  });

  it("names two options joined by and", () => {
    expect(offNote(["store.s3.bucket", "uploads.publicUrl"])).toBe(
      "Uploads are off until store.s3.bucket and uploads.publicUrl are set."
    );
  });

  it("names more options as a list", () => {
    expect(offNote(["store.s3.bucket", "store.s3.accessKeyId", "uploads.publicUrl"])).toBe(
      "Uploads are off until store.s3.bucket, store.s3.accessKeyId, and uploads.publicUrl are set."
    );
  });

  it("says only that they are off with no option named", () => {
    expect(offNote([])).toBe("Uploads are off.");
  });
});

describe("why a file was not kept, in words", () => {
  const named = { name: "cat.png", size: 10 };

  it("says the limit the Daemon read past", () => {
    expect(
      failureText({ ...named, failure: { _tag: "OverLimit", before: false, maxSize: mib } })
    ).toBe("cat.png is over the 1.0 MiB limit, so it was not kept.");
  });

  it("says the store could not be reached", () => {
    expect(failureText({ ...named, failure: { _tag: "StoreUnavailable" } })).toBe(
      "The store that keeps Uploads could not be reached, so cat.png was not kept."
    );
  });

  it("says the Journal could not be written", () => {
    expect(failureText({ ...named, failure: { _tag: "JournalFailed" } })).toBe(
      "The Daemon could not write its Journal, so cat.png was not kept."
    );
  });

  it("says whether a file sent with no answer was kept is unknown", () => {
    expect(failureText({ ...named, failure: { _tag: "NoAnswer", sent: true } })).toBe(
      "The Daemon did not answer, so whether cat.png was kept is unknown."
    );
  });

  it("says an answer that could not be read", () => {
    expect(failureText({ ...named, failure: { _tag: "Unexpected" } })).toBe(
      "The Daemon answered in a way the Frontend could not read, so whether cat.png was kept is unknown."
    );
  });

  it("says nothing of a file still being sent", () => {
    expect(failureText({ ...named, failure: undefined })).toBeUndefined();
  });
});
