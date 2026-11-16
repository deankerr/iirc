/**
 * Colour as numbers: sRGB hex read and written, OKLab and OKLCH for changing a colour as the
 * eye sees it, and WCAG 2's contrast ratio for whether text can be read. Everything here is
 * arithmetic on plain numbers, the same on every run.
 *
 * @packageDocumentation
 */
import type { Colour } from "@iirc/api/ui";

/** A colour's red, green, and blue in sRGB, each from 0 to 1. */
export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/** A colour in OKLCH: its lightness from 0 to 1, its chroma, and its hue in degrees. */
export interface Lch {
  readonly l: number;
  readonly c: number;
  readonly h: number;
}

/** A colour in OKLab: its lightness, and its two opponent axes. */
interface Lab {
  readonly l: number;
  readonly a: number;
  readonly b: number;
}

const shortHex = /^#?(?<r>[0-9a-f])(?<g>[0-9a-f])(?<b>[0-9a-f])$/iu;
const longHex = /^#?(?<rgb>[0-9a-f]{6})$/iu;

/**
 * A colour from hex text: `#rrggbb` or `#rgb`, the `#` optional, in any case.
 * @param text - The text.
 * @returns The colour, or none when the text is not one.
 */
export const parseHex = (text: string): Colour | undefined => {
  const short = shortHex.exec(text)?.groups;

  if (short !== undefined) {
    const { b = "", g = "", r = "" } = short;

    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }

  const long = longHex.exec(text)?.groups?.rgb;

  return long === undefined ? undefined : `#${long.toLowerCase()}`;
};

const unit = (value: number) => Math.min(1, Math.max(0, value));

const roundedByte = (value: number) => Math.round(unit(value) * 255);

const byte = (value: number) => roundedByte(value).toString(16).padStart(2, "0");

/**
 * A colour as hex, each channel kept within sRGB and rounded to a byte.
 * @param rgb - The colour.
 * @returns Its hex.
 */
export const hexOf = (rgb: Rgb): Colour => `#${byte(rgb.r)}${byte(rgb.g)}${byte(rgb.b)}`;

/**
 * A colour's channels, from its hex.
 * @param colour - The colour.
 * @returns Its channels, each from 0 to 1.
 */
export const rgbOf = (colour: Colour): Rgb => {
  const channel = (at: number) => Number.parseInt(colour.slice(at, at + 2), 16) / 255;

  return { b: channel(5), g: channel(3), r: channel(1) };
};

/**
 * One channel from sRGB's curve to linear light.
 * @param value - The channel.
 * @returns It in linear light.
 */
const linear = (value: number) =>
  value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;

/**
 * One channel from linear light to sRGB's curve.
 * @param value - The channel, in linear light.
 * @returns It on sRGB's curve.
 */
const encoded = (value: number) =>
  value <= 0.0031308
    ? value * 12.92
    : 1.055 * Math.sign(value) * Math.abs(value) ** (1 / 2.4) - 0.055;

/**
 * Display P3's channels as sRGB's, which may fall outside sRGB, for a palette given in P3.
 * @param rgb - The colour in Display P3.
 * @returns It in sRGB, unclamped.
 */
export const fromDisplayP3 = (rgb: Rgb): Rgb => {
  const r = linear(rgb.r);
  const g = linear(rgb.g);
  const b = linear(rgb.b);

  return {
    b: encoded(-0.0105483 * r - 0.0457461 * g + 1.0562944 * b),
    g: encoded(-0.0420569 * r + 1.0420569 * g),
    r: encoded(1.2249402 * r - 0.2249402 * g),
  };
};

/** Each byte's channel in linear light, worked out once, since a hex colour has only 256. */
const linearOfByte = Array.from({ length: 256 }, (_, value) => linear(value / 255));

const byteAt = (colour: Colour, at: number) => Number.parseInt(colour.slice(at, at + 2), 16);

/**
 * The relative luminance of a colour's bytes, as WCAG 2 defines it.
 * @param r - Its red byte.
 * @param g - Its green byte.
 * @param b - Its blue byte.
 * @returns Its luminance, from 0 to 1.
 */
const luminanceOfBytes = (r: number, g: number, b: number): number =>
  0.2126 * (linearOfByte[r] ?? 0) +
  0.7152 * (linearOfByte[g] ?? 0) +
  0.0722 * (linearOfByte[b] ?? 0);

/**
 * A colour's relative luminance, as WCAG 2 defines it.
 * @param colour - The colour.
 * @returns Its luminance, from 0 to 1.
 */
const luminance = (colour: Colour): number =>
  luminanceOfBytes(byteAt(colour, 1), byteAt(colour, 3), byteAt(colour, 5));

/**
 * The contrast ratio of two luminances: from 1, the same, to 21, black on white.
 * @param first - One luminance.
 * @param second - The other.
 * @returns The ratio.
 */
const ratio = (first: number, second: number) =>
  (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);

/**
 * The contrast ratio of two colours, as WCAG 2 defines it: from 1, the same, to 21, black
 * on white, whichever is lighter.
 * @param one - One colour.
 * @param other - The other.
 * @returns The ratio.
 */
export const contrast = (one: Colour, other: Colour): number =>
  ratio(luminance(one), luminance(other));

/**
 * A colour in OKLab, from sRGB, by Björn Ottosson's matrices.
 * @param rgb - The colour.
 * @returns It in OKLab.
 */
const labOf = (rgb: Rgb): Lab => {
  const r = linear(rgb.r);
  const g = linear(rgb.g);
  const b = linear(rgb.b);

  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);

  return {
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
  };
};

/**
 * A colour in linear sRGB, from OKLab, which may fall outside sRGB.
 * @param lab - The colour.
 * @returns Its linear channels.
 */
const linearOfLab = (lab: Lab): Rgb => {
  const l = (lab.l + 0.3963377774 * lab.a + 0.2158037573 * lab.b) ** 3;
  const m = (lab.l - 0.1055613458 * lab.a - 0.0638541728 * lab.b) ** 3;
  const s = (lab.l - 0.0894841775 * lab.a - 1.291485548 * lab.b) ** 3;

  return {
    b: -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
    g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    r: 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
  };
};

/**
 * A colour in OKLCH.
 * @param colour - The colour.
 * @returns Its lightness, chroma, and hue.
 */
export const lchOf = (colour: Colour): Lch => {
  const { a, b, l } = labOf(rgbOf(colour));
  const hue = (Math.atan2(b, a) * 180) / Math.PI;

  return { c: Math.hypot(a, b), h: hue < 0 ? hue + 360 : hue, l };
};

const labOfLch = (lch: Lch): Lab => ({
  a: lch.c * Math.cos((lch.h * Math.PI) / 180),
  b: lch.c * Math.sin((lch.h * Math.PI) / 180),
  l: lch.l,
});

/** How far outside 0 to 1 a linear channel may fall and still count as inside sRGB. */
const gamutSlack = 1e-4;

const channelInGamut = (one: number) => one >= -gamutSlack && one <= 1 + gamutSlack;

const inGamut = (rgb: Rgb) =>
  channelInGamut(rgb.r) && channelInGamut(rgb.g) && channelInGamut(rgb.b);

/**
 * A colour from OKLCH, kept within sRGB by lowering its chroma, never its lightness or hue,
 * as CSS Color 4 maps a colour into gamut.
 * @param lch - The colour.
 * @returns Its channels on sRGB's curve, not yet kept within 0 to 1 or rounded to bytes.
 */
const mappedOfLch = (lch: Lch): Rgb => {
  const l = unit(lch.l);
  const whole = linearOfLab(labOfLch({ c: lch.c, h: lch.h, l }));

  if (inGamut(whole)) {
    return { b: encoded(whole.b), g: encoded(whole.g), r: encoded(whole.r) };
  }

  let low = 0;
  let high = lch.c;

  for (let step = 0; step < 24; step += 1) {
    const middle = (low + high) / 2;

    if (inGamut(linearOfLab(labOfLch({ c: middle, h: lch.h, l })))) {
      low = middle;
    } else {
      high = middle;
    }
  }

  const kept = linearOfLab(labOfLch({ c: low, h: lch.h, l }));

  return { b: encoded(kept.b), g: encoded(kept.g), r: encoded(kept.r) };
};

/**
 * A colour from OKLCH, kept within sRGB by lowering its chroma, never its lightness or hue,
 * as CSS Color 4 maps a colour into gamut.
 * @param lch - The colour.
 * @returns Its hex.
 */
export const fromLch = (lch: Lch): Colour => hexOf(mappedOfLch(lch));

/**
 * The luminance of a colour from OKLCH once it is hex, without writing and reading the hex.
 * @param lch - The colour.
 * @returns The luminance of `fromLch(lch)`.
 */
const luminanceOfLch = (lch: Lch): number => {
  const { b, g, r } = mappedOfLch(lch);

  return luminanceOfBytes(roundedByte(r), roundedByte(g), roundedByte(b));
};

/**
 * Two colours mixed in OKLab, as the eye would blend them.
 * @param from - The colour at `0`.
 * @param to - The colour at `1`.
 * @param amount - How far towards `to`, from 0 to 1.
 * @returns The mix.
 */
export const mix = (from: Colour, to: Colour, amount: number): Colour => {
  const one = labOf(rgbOf(from));
  const other = labOf(rgbOf(to));
  const at = (left: number, right: number) => left + (right - left) * amount;
  const rgb = linearOfLab({ a: at(one.a, other.a), b: at(one.b, other.b), l: at(one.l, other.l) });

  return hexOf({ b: encoded(rgb.b), g: encoded(rgb.g), r: encoded(rgb.r) });
};

const white: Colour = "#ffffff";
const black: Colour = "#000000";

/**
 * The least contrast a luminance has against any of some others.
 * @param own - The luminance.
 * @param grounds - The others, each a background's.
 * @returns The least ratio.
 */
const leastRatio = (own: number, grounds: readonly number[]) => {
  let least = Number.POSITIVE_INFINITY;

  for (const ground of grounds) {
    least = Math.min(least, ratio(own, ground));
  }

  return least;
};

/**
 * A colour made readable on its backgrounds: itself, when it has at least `floor`
 * contrast with each, or else the least change of its OKLCH lightness that gives it, its
 * hue and chroma kept as far as sRGB allows, away from the first background towards
 * whichever of white and black stands further from it. Where even that cannot reach the
 * floor, it is the one of white and black that stands furthest from every background.
 * @param colour - The colour.
 * @param backgrounds - What it is drawn on, the first the one it moves away from.
 * @param floor - The least contrast ratio it must have with each.
 * @returns The readable colour.
 */
export const readable = (colour: Colour, backgrounds: readonly Colour[], floor: number): Colour => {
  const [ground] = backgrounds;
  const grounds = backgrounds.map(luminance);

  if (ground === undefined || leastRatio(luminance(colour), grounds) >= floor) {
    return colour;
  }

  const lighter = contrast(white, ground) >= contrast(black, ground);
  const own = lchOf(colour);
  const groundLightness = lchOf(ground).l;
  const at = (l: number) => leastRatio(luminanceOfLch({ c: own.c, h: own.h, l }), grounds);

  // Searching only beyond the background's lightness, contrast only grows as it goes.
  let near = lighter ? Math.max(own.l, groundLightness) : Math.min(own.l, groundLightness);
  let far = lighter ? 1 : 0;

  if (at(far) < floor) {
    const extremes = [white, black].toSorted(
      (one, other) => leastRatio(luminance(other), grounds) - leastRatio(luminance(one), grounds)
    );

    return extremes[0] ?? white;
  }

  for (let step = 0; step < 32; step += 1) {
    const middle = (near + far) / 2;

    if (at(middle) >= floor) {
      far = middle;
    } else {
      near = middle;
    }
  }

  return fromLch({ ...own, l: far });
};
