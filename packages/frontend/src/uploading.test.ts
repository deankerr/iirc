import { TimelineId, Upload } from "@iirc/api";
import { Schema } from "effect";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { CommandContext } from "./commands.ts";
import { commandStarted, draftOf, initialComposers, reduceComposers, submit } from "./composer.ts";
import type { Composers, Place } from "./composer.ts";
import {
  anchorAdded,
  anchorAfter,
  caretAfter,
  checking,
  failureOf,
  failureText,
  followed,
  heldBack,
  heldNoteIn,
  initialUploading,
  insertLink,
  noteIn,
  offNote,
  pendingIn,
  reduceUploading,
  relinkedAt,
  renamed,
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

/**
 * An Upload as the Daemon answers it, its id made from a key, with a link and a name.
 * @param key - The key, of letters Crockford's base32 holds.
 * @param link - Its link, or `null` without a public URL.
 * @param name - Its name.
 * @returns The Upload.
 */
const uploadOf = (key: string, link: string | null, name = `${key}.png`) =>
  Schema.decodeSync(Upload)({
    at: 1_700_000_000_000,
    hash: "0".repeat(64),
    id: key.replaceAll(/[ilou]/gu, "x").padEnd(16, "0"),
    link,
    name,
    safeName: name,
    said: [],
    size: 10,
    type: "image/png",
  });

const keep = (
  state: { readonly uploading: Uploading; readonly composers: Composers },
  key: string,
  link: string | null = `https://f.test/${key}`
) => {
  const kept = uploaded(state.uploading, state.composers, key, uploadOf(key, link));

  return { composers: kept.composers, uploading: kept.state };
};

const textOf = (state: { readonly composers: Composers }) => draftOf(state.composers, place).text;

describe("where an anchor goes as the draft is edited", () => {
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

  it("follows the edit the Owner made where text repeats, not the first it could be", () => {
    // Between the words of "hi hi", the first "hi " selected and deleted.
    expect(anchorAfter(3, "hi hi", "hi", { caret: 0, from: 0 })).toBe(0);
  });

  it("stays before text typed at it, with the selection known", () => {
    expect(anchorAfter(3, "hi hi", "hi hhi", { caret: 4, from: 3 })).toBe(3);
  });

  it("moves back with a Backspace before it", () => {
    // Between the two `a`s, the first deleted: the texts alone would say the second.
    expect(anchorAfter(1, "aa", "a", { caret: 0, from: 1 })).toBe(0);
  });

  it("stays with a forward delete after it", () => {
    expect(anchorAfter(1, "aa", "a", { caret: 1, from: 1 })).toBe(1);
  });

  it("goes to the end of what replaced a selection across it", () => {
    // "bb b" selected across the anchor and replaced by "X".
    expect(anchorAfter(3, "abb bbc", "aXc", { caret: 2, from: 1 })).toBe(2);
  });

  it("finds the edit from the texts when the selection does not explain it", () => {
    // An undo, which the selection before says nothing of.
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

  it("puts nothing in when no public URL gives a link, and notes that uploads are off", () => {
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
});

/**
 * A draft with files added at one place in it and kept, each with its link.
 * @param text - The draft.
 * @param anchor - Where the files were added.
 * @param keys - The files' keys.
 * @returns What is pending, and the composers.
 */
const kept = (text: string, anchor: number, ...keys: readonly string[]) => {
  let state = {
    composers: typed(initialComposers, text),
    uploading: addedAt(anchor, ...keys.map((key) => file(key))),
  };

  for (const key of keys) {
    state = keep(state, key);
  }

  return state;
};

/**
 * Where a file stands.
 * @param uploading - What is pending.
 * @param key - The file's key.
 * @returns Its stage.
 */
const stageOf = (uploading: Uploading, key: string) =>
  uploading.pending.find((one) => one.key === key)?.stage;

/**
 * A kept file renamed, as the Daemon answered, with a new link.
 * @param state - What is pending, and the composers.
 * @param key - The file's key.
 * @param link - The new link.
 * @returns Both, after, and what was relinked.
 */
const rename = (
  state: { readonly uploading: Uploading; readonly composers: Composers },
  key: string,
  link: string | null
) => {
  const after = renamed(
    fold(state.uploading, { _tag: "Renaming", key }),
    state.composers,
    key,
    uploadOf(key, link, "renamed.png")
  );

  return { composers: after.composers, relinked: after.relinked, uploading: after.state };
};

describe("a file kept", () => {
  it("stays listed under its composer, holding nothing back, until its draft is sent", () => {
    const state = kept("look", 4, "a");

    const other = keep(
      {
        composers: typed(state.composers, "there", elsewhere),
        uploading: fold(state.uploading, ...arrived(5, [file("b")], on, elsewhere)),
      },
      "b"
    );

    const sent = fold(other.uploading, { _tag: "Sent", place });

    expect({
      held: heldBack(state.uploading, state.composers, place, []),
      kept: pendingIn(state.uploading, place).map((one) => one.stage._tag),
      sent: pendingIn(sent, place),
      text: textOf(state),
      untouched: pendingIn(sent, elsewhere).map((one) => one.key),
    }).toStrictEqual({
      held: undefined,
      kept: ["Kept"],
      sent: [],
      text: "look https://f.test/a",
      untouched: ["b"],
    });
  });

  it("is let go of once dismissed", () => {
    expect(fold(kept("", 0, "a").uploading, { _tag: "Dropped", key: "a" }).pending).toStrictEqual(
      []
    );
  });

  it("puts its new link in the draft in place of the old, wherever it now sits", () => {
    const state = edited(kept("look", 4, "a"), "oh look https://f.test/a now!");
    const after = rename(state, "a", "https://f.test/a2/renamed.png");
    const stage = stageOf(after.uploading, "a");

    expect({
      link: stage?._tag === "Kept" ? stage.link : undefined,
      name: stage?._tag === "Kept" ? stage.upload.name : undefined,
      renaming: stage?._tag === "Kept" ? stage.renaming : undefined,
      text: textOf(after),
    }).toStrictEqual({
      link: "https://f.test/a2/renamed.png",
      name: "renamed.png",
      renaming: false,
      text: "oh look https://f.test/a2/renamed.png now!",
    });
  });

  it("moves an anchor after the old link by the change in its length, and leaves one before it", () => {
    const state = kept("one two", 4, "a");

    const pending = fold(
      state.uploading,
      ...arrived(0, [file("early")], on, place),
      ...arrived(state.composers.drafts.get(place)?.text.length ?? 0, [file("late")], on, place)
    );

    const after = keep(
      keep(rename({ ...state, uploading: pending }, "a", "https://f.test/a/longer.png"), "late"),
      "early"
    );

    expect(textOf(after)).toBe(
      "https://f.test/early one https://f.test/a/longer.png two https://f.test/late"
    );
  });

  it("says where a caret goes: on by the change in length after the link, to its end within it", () => {
    const relink = { from: 3, starts: [2, 8], to: 5 };

    expect([0, 2, 3, 5, 6, 8, 9, 11, 12].map((at) => relinkedAt(at, relink))).toStrictEqual([
      0, 2, 7, 7, 8, 10, 15, 15, 16,
    ]);
  });

  it("replaces nothing once the Owner edited the link away, but takes the new name", () => {
    const state = edited(kept("look", 4, "a"), "look at this");
    const after = rename(state, "a", "https://f.test/a/renamed.png");
    const stage = stageOf(after.uploading, "a");

    expect({
      name: stage?._tag === "Kept" ? stage.upload.name : undefined,
      relinked: after.relinked,
      text: textOf(after),
    }).toStrictEqual({ name: "renamed.png", relinked: undefined, text: "look at this" });
  });

  it("keeps the link with no public URL to make a new one", () => {
    const after = rename(kept("look", 4, "a"), "a", null);

    expect(textOf(after)).toBe("look https://f.test/a");
  });

  it("says why a rename failed, and lets go of it as it is tried again", () => {
    const failed = fold(
      kept("", 0, "a").uploading,
      { _tag: "Renaming", key: "a" },
      { _tag: "RenameFailed", failure: { _tag: "JournalFailed" }, key: "a" }
    );

    const again = fold(failed, { _tag: "Renaming", key: "a" });

    expect(
      [stageOf(failed, "a"), stageOf(again, "a")].map((stage) =>
        stage?._tag === "Kept" ? { failure: stage.failure, renaming: stage.renaming } : stage
      )
    ).toStrictEqual([
      { failure: { _tag: "JournalFailed" }, renaming: false },
      { failure: undefined, renaming: true },
    ]);
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

  it("follows the draft while uploads are asked about, edits and all", () => {
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

  it("follows a draft carried to its conversation while uploads are asked about", () => {
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

    expect(
      draftOf(uploaded(answered, carried, "a", uploadOf("a", "L")).composers, elsewhere).text
    ).toBe("hi L");
  });

  it("sends nothing of a file cancelled while uploads are asked about", () => {
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

  it("checks a file until the daemon says whether uploads are on", () => {
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
      words: ["cat.mp4 is 126 MB, over the 105 MB limit.", undefined],
    });
  });

  it("adds nothing while uploads are off, and notes the options to set", () => {
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

  it("lets the note go once files are added while uploads are on", () => {
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

  it("notes that uploads are off when the daemon says so as a file is sent, and lets the file go", () => {
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

  it("fails each file, sending none, when the daemon did not say whether uploads are on", () => {
    const state = fold(initialUploading, ...arrived(0, [file("a")], { _tag: "NoAnswer" }, place));

    expect({
      sending: [...sending(state)],
      words: state.pending.map((one) => failureText({ ...one, failure: failureOf(one) })),
    }).toStrictEqual({
      sending: [],
      words: ["The daemon did not answer, so a.png was not sent."],
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

    expect([
      heldBack(one, composers, place, []),
      heldBack(two, composers, place, []),
    ]).toStrictEqual([
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
      heldBack(failed, composers, place, []),
      heldBack(addedAt(4, file("a")), composers, elsewhere, []),
    ]).toStrictEqual([undefined, undefined]);
  });

  it("holds nothing back for a draft typing a password's value, so it is let go of", () => {
    const credential = typed(initialComposers, "/set store.s3.secretAccessKey hunter2");

    expect(heldBack(addedAt(0, file("a")), credential, place, [])).toBeUndefined();
  });
});

describe("what a composer says of a send held back", () => {
  const composers = typed(initialComposers, "look");
  const held: UploadingEvent = { _tag: "HeldBack", place };

  it("says nothing until a send was held back", () => {
    expect(heldNoteIn(addedAt(4, file("a")), composers, place, [])).toBeUndefined();
  });

  it("names only the files still waiting, as each is kept, fails, or is cancelled", () => {
    const state = fold(addedAt(4, file("a"), file("b"), file("c")), held);
    const kept = uploaded(state, composers, "a", uploadOf("a", "https://f.test/a.png"));

    const failed = fold(kept.state, {
      _tag: "Failed",
      failure: { _tag: "StoreUnavailable" },
      key: "b",
    });

    expect([
      heldNoteIn(kept.state, kept.composers, place, []),
      heldNoteIn(failed, kept.composers, place, []),
    ]).toStrictEqual([
      "Wait for b.png and c.png to finish uploading, or cancel them.",
      "Wait for c.png to finish uploading, or cancel it.",
    ]);
  });

  it.each([
    [
      "kept",
      (state: Uploading) =>
        uploaded(state, composers, "a", uploadOf("a", "https://f.test/a.png")).state,
    ],
    [
      "failed",
      (state: Uploading) =>
        fold(state, { _tag: "Failed", failure: { _tag: "StoreUnavailable" }, key: "a" }),
    ],
    ["cancelled", (state: Uploading) => fold(state, { _tag: "Dropped", key: "a" })],
  ])("lets go of it once the last file is %s, and no file added later brings it back", (_, end) => {
    const done = end(fold(addedAt(4, file("a")), held));
    const later = fold(done, ...arrived(0, [file("b")], on));

    expect(heldNoteIn(later, composers, place, [])).toBeUndefined();
  });

  it("stays with a draft carried to its conversation while its file uploads", () => {
    const draft: Place = "draft libera peer";
    const before = typed(initialComposers, "hi", draft);

    const atDraft = fold(initialUploading, ...arrived(2, [file("a")], on, draft), {
      _tag: "HeldBack",
      place: draft,
    });

    const after = reduceComposers(before, { _tag: "Carried", from: draft, to: elsewhere });
    const carried = followed(atDraft, before, after);

    expect([heldNoteIn(carried, after, elsewhere, []), carried.held.has(draft)]).toStrictEqual([
      "Wait for a.png to finish uploading, or cancel it.",
      false,
    ]);
  });

  it("is of one composer, and goes with a dismissed note", () => {
    const state = fold(addedAt(4, file("a")), held, { _tag: "HeldBack", place: elsewhere });
    const dismissed = fold(state, { _tag: "NoteDismissed", place });

    expect([
      heldNoteIn(state, composers, elsewhere, []),
      heldNoteIn(dismissed, composers, place, []),
    ]).toStrictEqual([undefined, undefined]);
  });
});

describe("the note while uploads are off", () => {
  it("names one option", () => {
    expect(offNote(["uploads.publicUrl"])).toBe("Uploads are off until uploads.publicUrl is set.");
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

  it("says the limit the daemon read past", () => {
    expect(
      failureText({ ...named, failure: { _tag: "OverLimit", before: false, maxSize: mib } })
    ).toBe("cat.png is over the 1.0 MB limit, so it was not kept.");
  });

  it("says the store could not be reached", () => {
    expect(failureText({ ...named, failure: { _tag: "StoreUnavailable" } })).toBe(
      "The storage that keeps uploads could not be reached, so cat.png was not kept."
    );
  });

  it("says the store is full, and how much uploads may hold in all", () => {
    expect(failureText({ ...named, failure: { _tag: "StoreFull", maxTotal: 2 * mib } })).toBe(
      "Storage is full: uploads can total 2.1 MB, so cat.png was not kept."
    );
  });

  it("says the history could not be written", () => {
    expect(failureText({ ...named, failure: { _tag: "JournalFailed" } })).toBe(
      "The daemon could not write its history, so cat.png was not kept."
    );
  });

  it("says whether a file sent with no answer was kept is unknown", () => {
    expect(failureText({ ...named, failure: { _tag: "NoAnswer", sent: true } })).toBe(
      "The daemon did not answer, so it's unknown whether cat.png was kept."
    );
  });

  it("says an answer that could not be read", () => {
    expect(failureText({ ...named, failure: { _tag: "Unexpected" } })).toBe(
      "The daemon sent a reply this device could not read, so it's unknown whether cat.png was kept."
    );
  });

  it("says nothing of a file still being sent", () => {
    expect(failureText({ ...named, failure: undefined })).toBeUndefined();
  });
});

const context: CommandContext = {
  aliases: [],
  behind: false,
  draft: undefined,
  focus: undefined,
  head: undefined,
  named: [],
  open: undefined,
  panes: 1,
  session: false,
  shown: [],
  timelines: [],
  unread: [],
  unreadClosed: [],
};

/**
 * A draft with a file uploading at its second space, and a command started over it.
 * @param command - The command.
 * @returns The composers and what is pending.
 */
const over = (command = "/go ") => {
  const before = {
    composers: typed(initialComposers, "look  please"),
    uploading: addedAt(5, file("a")),
  };

  const composers = commandStarted(before.composers, place, command);

  return { composers, uploading: followed(before.uploading, before.composers, composers) };
};

describe("a draft set aside while its files upload", () => {
  it("holds a command back for none of its files, and the draft again once it is back", () => {
    const { composers, uploading } = over();
    const back = reduceComposers(composers, { _tag: "Restored", timeline: place });

    expect({
      back: heldBack(uploading, back, place, []),
      command: heldBack(uploading, composers, place, []),
    }).toStrictEqual({
      back: "Wait for a.png to finish uploading, or cancel it.",
      command: undefined,
    });
  });

  it("puts a link that finishes while the command shows in the draft, never in the command, and keeps the anchors against the draft", () => {
    const state = over();
    const edited_ = edited(state, "/go #x");
    const kept = keep(edited_, "a");
    const back = reduceComposers(kept.composers, { _tag: "Restored", timeline: place });
    const ran = submit(commandStarted(kept.composers, place, "/sidebar"), place, context);

    expect({
      anchor: pendingIn(kept.uploading, place)[0]?.anchor,
      back: draftOf(back, place).text,
      command: draftOf(kept.composers, place).text,
      ran: draftOf(ran.state, place).text,
      sent: ran.intents,
    }).toStrictEqual({
      anchor: 5,
      back: "look https://f.test/a please",
      command: "/go #x",
      ran: "look https://f.test/a please",
      sent: [{ _tag: "ShowSidebar", shown: undefined }],
    });
    expect(draftOf(state.composers, place).aside?.text).toBe("look  please");
  });

  it("puts a file added while the command shows at the end of the draft, never at the command's caret", () => {
    const { composers } = over("/go ");

    expect({
      aside: anchorAdded(composers, place, 2, "/go "),
      draft: anchorAdded(typed(initialComposers, "look  please"), place, 2, "look  please"),
    }).toStrictEqual({ aside: "look  please".length, draft: 2 });
  });
});
