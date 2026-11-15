import { knownKinds } from "./kind.ts";
import type { Family, Kind } from "./kind.ts";

/** The most code points a safe name may have, extension included. */
export const maxNameLength = 64;

// An extension longer than this is not one, and is replaced, so the stem always has room.
const maxExtensionLength = 16;

const recognisedExtensions: ReadonlySet<string> = new Set(
  knownKinds.flatMap((kind) => kind.extensions)
);

const neutralStems: Readonly<Record<Family, string>> = {
  audio: "audio",
  file: "file",
  image: "image",
  text: "file",
  video: "video",
};

const codePoints = (text: string): string[] => text.split(/(?:)/u);

const length = (text: string): number => codePoints(text).length;

const trimDashesAndDots = (text: string): string => text.replaceAll(/^[-.]+|[-.]+$/gu, "");

const clean = (given: string): string =>
  given
    .normalize("NFC")
    .replaceAll(/[^\p{L}\p{N}\p{M}._-]/gu, "-")
    .replaceAll(/-{2,}/gu, "-");

// The extension to put on the name: the given one when it already names the bytes, else the bytes' own.
const extensionFor = (given: string | undefined, kind: Kind): string => {
  const wanted = given?.toLowerCase();

  if (wanted === undefined || wanted === "" || length(wanted) > maxExtensionLength) {
    return kind.extension;
  }

  if (kind.extensions.length > 0) {
    return kind.extensions.includes(wanted) ? wanted : kind.extension;
  }

  return recognisedExtensions.has(wanted) ? kind.extension : wanted;
};

/**
 * A name that is safe to put in a link and a header, whatever the Owner called the file.
 * @param given - The name the Owner gave, if any.
 * @param kind - What the bytes are, which decides the extension.
 * @returns A name of at most `maxNameLength` code points whose extension matches the bytes.
 */
export const safeName = (given: string | undefined, kind: Kind): string => {
  const cleaned = clean(given ?? "").replaceAll(/[-.]+$/gu, "");
  const last = cleaned.lastIndexOf(".");
  // Only letters and digits after the last dot make an extension, so in `../../etc/passwd`
  // the dots are part of the path, not an extension, and the name keeps `etc-passwd`.
  const dot = last !== -1 && /^[\p{L}\p{N}\p{M}]+$/u.test(cleaned.slice(last + 1)) ? last : -1;
  const stem = trimDashesAndDots(dot === -1 ? cleaned : cleaned.slice(0, dot));
  const givenExtension = dot === -1 ? undefined : cleaned.slice(dot + 1);

  const extension = extensionFor(givenExtension, kind);
  const room = maxNameLength - 1 - length(extension);
  const cut = trimDashesAndDots(codePoints(stem).slice(0, room).join(""));

  return `${cut === "" ? neutralStems[kind.family] : cut}.${extension}`;
};
