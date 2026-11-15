import { describe, expect, it } from "vitest";

import { detectKind } from "./kind.ts";
import type { Kind } from "./kind.ts";
import { maxNameLength, safeName } from "./names.ts";

const png: Kind = detectKind(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
const jpeg: Kind = detectKind(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]));
const text: Kind = detectKind(new TextEncoder().encode("hello"));
const unknown: Kind = detectKind(Uint8Array.from([0x50, 0x4b, 3, 4]));

const mp4: Kind = detectKind(
  Uint8Array.from([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0])
);

const ogg: Kind = detectKind(new TextEncoder().encode("OggS"));

const codePoints = (text: string) => text.split(/(?:)/u).length;

describe(safeName, () => {
  it("normalises to NFC", () => {
    expect(safeName("cafe\u0301.txt", text)).toBe("caf\u00E9.txt");
  });

  it("keeps letters and digits of any script", () => {
    expect(safeName("Привет-мир_2.txt", text)).toBe("Привет-мир_2.txt");
    expect(safeName("日本語1.txt", text)).toBe("日本語1.txt");
  });

  it("keeps combining marks that NFC cannot compose", () => {
    expect(safeName("क्षि.txt", text)).toBe("क्षि.txt");
  });

  it("turns whitespace and punctuation into dashes", () => {
    expect(safeName('my "best" photo: v2?.txt', text)).toBe("my-best-photo-v2.txt");
  });

  it("turns control characters and emoji into dashes", () => {
    expect(safeName("a\u0000b\u202Ec\u{1F600}d.txt", text)).toBe("a-b-c-d.txt");
  });

  it("collapses runs of dashes", () => {
    expect(safeName("a   ---   b.txt", text)).toBe("a-b.txt");
  });

  it("trims dashes and dots from both ends of the stem", () => {
    expect(safeName("--.. notes ..--.txt", text)).toBe("notes.txt");
  });

  it("fixes the extension to match the bytes", () => {
    expect(safeName("photo.jpg", png)).toBe("photo.png");
  });

  it("keeps an extension that already names the bytes, lower-cased", () => {
    expect(safeName("notes.md", text)).toBe("notes.md");
    expect(safeName("Photo.JPEG", jpeg)).toBe("Photo.jpeg");
    expect(safeName("clip.M4V", mp4)).toBe("clip.m4v");
  });

  it("adds the extension when there is none", () => {
    expect(safeName("cat", png)).toBe("cat.png");
  });

  it("splits at the last dot only", () => {
    expect(safeName("archive.tar.gz", text)).toBe("archive.tar.txt");
    expect(safeName("v1.2.notes.txt", text)).toBe("v1.2.notes.txt");
  });

  it("keeps the given extension for unknown bytes", () => {
    expect(safeName("archive.zip", unknown)).toBe("archive.zip");
    expect(safeName("Archive.ZIP", unknown)).toBe("Archive.zip");
  });

  it("replaces a recognised extension on unknown bytes with bin", () => {
    expect(safeName("cat.png", unknown)).toBe("cat.bin");
    expect(safeName("notes.txt", unknown)).toBe("notes.bin");
  });

  it("adds bin to unknown bytes with no extension", () => {
    expect(safeName("blob", unknown)).toBe("blob.bin");
  });

  it("caps the name at maxNameLength code points", () => {
    const name = safeName(`${"Ж".repeat(300)}.png`, png);
    expect(codePoints(name)).toBe(maxNameLength);
    expect(name.endsWith(".png")).toBeTruthy();
  });

  it("caps a name with no extension, counting the one it adds", () => {
    const name = safeName("я".repeat(300), text);
    expect(codePoints(name)).toBe(maxNameLength);
    expect(name.endsWith(".txt")).toBeTruthy();
  });

  it("never splits a surrogate pair when shortening", () => {
    const name = safeName(`${"𝒜".repeat(100)}.txt`, text);
    expect(codePoints(name)).toBe(maxNameLength);
    expect(name).toBe(`${"𝒜".repeat(60)}.txt`);
  });

  it("trims dashes from the stem again after cutting", () => {
    const stem = `${"a".repeat(59)}-bbb`;
    expect(safeName(`${stem}.txt`, text)).toBe(`${"a".repeat(59)}.txt`);
  });

  it("keeps the extension when it is nearly as long as the cap", () => {
    const extension = "q".repeat(15);
    const name = safeName(`${"n".repeat(80)}.${extension}`, unknown);
    expect(codePoints(name)).toBe(maxNameLength);
    expect(name.endsWith(`.${extension}`)).toBeTruthy();
  });

  it("replaces an extension longer than the cap allows", () => {
    const name = safeName(`doc.${"x".repeat(200)}`, unknown);
    expect(name).toBe("doc.bin");
  });

  it("names a file with no name by its family", () => {
    expect(safeName(undefined, png)).toBe("image.png");
    expect(safeName("", mp4)).toBe("video.mp4");
    expect(safeName(undefined, ogg)).toBe("audio.ogg");
    expect(safeName(undefined, unknown)).toBe("file.bin");
    expect(safeName(undefined, text)).toBe("file.txt");
  });

  it("names a file whose name cleans to nothing by its family", () => {
    expect(safeName("\u{1F600}\u{1F389}", png)).toBe("image.png");
    expect(safeName("  /// ", text)).toBe("file.txt");
    expect(safeName("...", unknown)).toBe("file.bin");
  });

  it("gives a stem that cleans to nothing the neutral stem when it had an extension", () => {
    expect(safeName(".png", png)).toBe("image.png");
    expect(safeName("\u{1F600}.jpg", jpeg)).toBe("image.jpg");
  });

  it("flattens path-like names", () => {
    expect(safeName("../../etc/passwd", text)).toBe("etc-passwd.txt");
    expect(safeName("C:\\Users\\me\\a.txt", text)).toBe("C-Users-me-a.txt");
  });

  it("never starts with a dot, so nothing is hidden", () => {
    expect(safeName(".hidden.txt", text)).toBe("hidden.txt");
  });

  it("does not dedupe: the same name gives the same name", () => {
    expect(safeName("same.png", png)).toBe(safeName("same.png", png));
  });

  it("never gives a date, a time or pasted", () => {
    expect(safeName(undefined, png)).not.toMatch(/pasted|\d/u);
  });
});
