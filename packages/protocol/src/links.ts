/**
 * The links a Message holds, and which of them may be previewed. A Frontend and the Daemon
 * both ask here, so the first three links of a Message are the same three everywhere.
 *
 * @packageDocumentation
 */
import { parseFormatting } from "./format.ts";

/** The schemes a link may have. Anything else stays text. */
export const linkSchemes = ["http", "https", "irc", "ircs"] as const;

/** One of the {@link linkSchemes}. */
export type Scheme = (typeof linkSchemes)[number];

/** A link in a Message: its address as the URL parser wrote it, and its scheme. */
export interface Link {
  readonly href: string;
  readonly scheme: Scheme;
}

/** A link found in one run of text, with where it is and how it was written. */
export interface LinkInRun extends Link {
  /** Where the link starts in the run. */
  readonly index: number;
  /** The link as written in the run, which is not always its `href`. */
  readonly text: string;
}

/** A link a Frontend or the Daemon may fetch a preview of: only `http` and `https`. */
export interface Previewable extends Link {
  readonly scheme: "http" | "https";
}

/** How many links of a Message may be previewed: its first three distinct `http` or `https` links. */
export const previewLimit = 3;

// The URL parser's protocol, colon included, for each scheme we allow.
const schemeOfProtocol: ReadonlyMap<string, Scheme> = new Map(
  linkSchemes.map((scheme) => [`${scheme}:`, scheme])
);

// A link starts at a scheme we allow and runs to whitespace, a control, a bidirectional
// formatting character, or a character a URL never holds unescaped.
const linkPattern =
  // oxlint-disable-next-line no-control-regex -- control characters end a link, so the pattern names them
  /\b(?:https?|ircs?):\/\/[^\s<>"`{}|\\^\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069]+/giu;

const trailing = new Set([".", ",", ";", ":", "!", "?", "'", '"', "*"]);

const closers: ReadonlyMap<string, string> = new Map([
  [")", "("],
  ["]", "["],
  ["}", "{"],
]);

const openers: ReadonlySet<string> = new Set(closers.values());

/**
 * A link candidate without the punctuation that ends a sentence around it: trailing stops
 * and quotes, and a closing bracket the link did not open.
 * @param candidate - What the pattern matched.
 * @returns The link's text.
 */
const trimmed = (candidate: string): string => {
  // Each bracket counted once, and the counts kept as the end moves, so hostile text of
  // many brackets is trimmed in one pass.
  const counts = new Map<string, number>();

  for (const character of candidate) {
    if (closers.has(character) || openers.has(character)) {
      counts.set(character, (counts.get(character) ?? 0) + 1);
    }
  }

  let end = candidate.length;

  for (;;) {
    const last = candidate.charAt(end - 1);
    const opener = closers.get(last);

    const unbalanced = opener !== undefined && (counts.get(opener) ?? 0) < (counts.get(last) ?? 0);

    if (end > 0 && (trailing.has(last) || unbalanced)) {
      if (opener !== undefined) {
        counts.set(last, (counts.get(last) ?? 0) - 1);
      }

      end -= 1;
    } else {
      return candidate.slice(0, end);
    }
  }
};

/**
 * The link a candidate is, if the URL parser reads it, its scheme is allowed, and it has a host.
 * @param text - The candidate's text.
 * @returns The link, or `undefined`.
 */
const linkOf = (text: string): Link | undefined => {
  const url = URL.parse(text);
  const scheme = url === null ? undefined : schemeOfProtocol.get(url.protocol);

  return url !== null && scheme !== undefined && url.host !== ""
    ? { href: url.href, scheme }
    : undefined;
};

/**
 * Finds the links in one run of text, and never throws. A link starts at `http://`,
 * `https://`, `irc://`, or `ircs://`, in any case, and runs to whitespace, a control, a
 * bidirectional formatting character, or a character a URL never holds unescaped. The
 * punctuation that ends a sentence around it is not part of it: trailing stops, commas,
 * quotes, and a closing bracket the link did not open. What is left must be a URL with a
 * host, or it is not a link. The work is linear in the run, however many brackets it holds.
 * @param run - Text with no formatting codes in it.
 * @returns Its links in order, which never overlap.
 */
export const linksInRun = (run: string): readonly LinkInRun[] => {
  const found: LinkInRun[] = [];

  for (const match of run.matchAll(linkPattern)) {
    const text = trimmed(match[0]);
    const link = linkOf(text);

    if (link !== undefined && text.length > 0) {
      found.push({ ...link, index: match.index, text });
    }
  }

  return found;
};

/**
 * Finds the links in a Message's text, which may hold mIRC formatting codes. Each span of
 * one style is searched on its own, as a Frontend draws it, so a link that formatting
 * splits is found only up to the split.
 * @param text - The Message's text, as it arrived.
 * @returns Its links in order.
 */
export const linksOf = (text: string): readonly Link[] =>
  parseFormatting(text).flatMap((span) =>
    linksInRun(span.text).map(({ href, scheme }) => ({ href, scheme }))
  );

const isPreviewable = (link: Link): link is Previewable =>
  link.scheme === "http" || link.scheme === "https";

/**
 * The links of a Message that may be previewed: its first {@link previewLimit} distinct
 * `http` or `https` links. An `irc` or `ircs` link never counts. A link that repeats an
 * earlier one, by `href` as the URL parser wrote it, counts once, so a later distinct
 * link takes its place.
 * @param text - The Message's text, as it arrived.
 * @returns Those links in order.
 */
export const previewableLinksOf = (text: string): readonly Previewable[] => {
  const seen = new Set<string>();
  const chosen: Previewable[] = [];

  for (const link of linksOf(text)) {
    if (chosen.length === previewLimit) {
      break;
    }

    if (isPreviewable(link) && !seen.has(link.href)) {
      seen.add(link.href);
      chosen.push(link);
    }
  }

  return chosen;
};
