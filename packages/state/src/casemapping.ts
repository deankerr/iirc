/**
 * How a Network compares nicks and Channel names (KNOW-3). `rfc8265` comes from
 * `UTF8MAPPING=rfc8265`, which Ergo sends beside `CASEMAPPING=ascii` in its `precis` mode.
 * Anything unrecognised is `ascii`, which splits names rather than merging them.
 */
export type Casemapping = "ascii" | "rfc1459" | "rfc1459-strict" | "rfc8265";

const upper = /[A-Z]/gu;

// Anything past ASCII, which only `rfc8265` folds, and which `toLowerCase` must not touch
// under the other mappings.
const beyondAscii = /[\u{80}-\u{10FFFF}]/u;

const rfc1459Extras = /[[\]\\~]/gu;

const strictExtras = /[[\]\\]/gu;

const extraLower: ReadonlyMap<string, string> = new Map([
  ["[", "{"],
  ["\\", "|"],
  ["]", "}"],
  ["~", "^"],
]);

const lowerLetter = (letter: string) => letter.toLowerCase();

const lowerExtra = (character: string) => extraLower.get(character) ?? character;

const asciiLower = (name: string) =>
  beyondAscii.test(name) ? name.replaceAll(upper, lowerLetter) : name.toLowerCase();

// RFC 8265's width mapping takes fullwidth and halfwidth forms to their decompositions,
// which are NFKC of each. They all sit in the Halfwidth and Fullwidth Forms block, but for
// the ideographic space.
const widths = /[　！-￮]/gu;

const widthMapped = (character: string) => character.normalize("NFKC");

// `toLowerCase` takes a capital sigma at the end of a word to the final form. RFC 8265's
// case mapping does not, and nor does Ergo, so it is mapped to the medial form first.
const capitalSigma = /Σ/gu;

const foldedOnce = (name: string) =>
  name.replaceAll(widths, widthMapped).replaceAll(capitalSigma, "σ").toLowerCase().normalize("NFC");

// Each pass is idempotent in part only, so RFC 8265 applies it until the name stops
// changing, which Ergo gives four tries.
const rfc8265Fold = (name: string) => {
  if (!beyondAscii.test(name)) {
    return name.toLowerCase();
  }

  let folded = name;

  for (let pass = 0; pass < 4; pass += 1) {
    const next = foldedOnce(folded);

    if (next === folded) {
      return next;
    }

    folded = next;
  }

  return folded;
};

/**
 * The form a name is compared in under a mapping (KNOW-3). `ascii` lower-cases `A` to `Z`,
 * and `rfc1459` also takes `[]\~` to `{}|^`, which `rfc1459-strict` does but for `~`.
 * `rfc8265` is RFC 8265's UsernameCaseMapped mapping as JavaScript allows: width mapping,
 * Unicode lower-casing with no final sigma, then NFC, repeated until stable. Unlike Ergo, it
 * rejects nothing, so a name Ergo would refuse still has a form.
 * @param casemapping - The mapping in force.
 * @param name - A nick or Channel name, as spelled anywhere.
 * @returns What every spelling of it shares.
 */
export const casefold = (casemapping: Casemapping, name: string): string => {
  switch (casemapping) {
    case "ascii": {
      return asciiLower(name);
    }

    case "rfc1459": {
      return asciiLower(name).replaceAll(rfc1459Extras, lowerExtra);
    }

    case "rfc1459-strict": {
      return asciiLower(name).replaceAll(strictExtras, lowerExtra);
    }

    case "rfc8265": {
      return rfc8265Fold(name);
    }

    default: {
      return casemapping satisfies never;
    }
  }
};

/**
 * Whether two names, already folded under `ascii`, could be one name under a mapping. A
 * host that keys by the `ascii` form, as `channelKey` does, needs to compare again only
 * when this holds.
 * @param casemapping - The mapping in force.
 * @param asciiFolded - A name folded under `ascii`.
 * @returns Whether folding it under `casemapping` could change it further.
 */
export const mayFoldFurther = (casemapping: Casemapping, asciiFolded: string): boolean => {
  switch (casemapping) {
    case "ascii": {
      return false;
    }

    case "rfc1459":
    case "rfc1459-strict": {
      return /[[\]\\~{}|^]/u.test(asciiFolded);
    }

    case "rfc8265": {
      return beyondAscii.test(asciiFolded);
    }

    default: {
      return casemapping satisfies never;
    }
  }
};
