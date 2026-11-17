/**
 * How a query ranks what is listed, in one place, so the palette and the composer's list
 * find the same things in the same order. A query matches an item's names and its
 * description in four tiers, and is ASCII case-insensitive, reading no locale.
 *
 * @packageDocumentation
 */

/**
 * How well a query matches, best first: the text starts with it, it starts a word of the
 * text, it starts a word of the description, or its characters appear in the text in order.
 */
const tiers = { Described: 1, Fuzzy: 0, Prefix: 3, WordStart: 2 } as const;

/** How well an item matches: its tier, then the lower `cost` the better. */
export interface Score {
  readonly tier: number;
  readonly cost: number;
}

/** What an item is matched by: its names, best first, and what it is, in a few words. */
export interface Matched {
  readonly names: readonly string[];
  readonly description: string;
}

/**
 * Orders scores best first.
 * @param left - One score.
 * @param right - The other.
 * @returns Their order.
 */
export const byScore = (left: Score, right: Score) =>
  right.tier - left.tier || left.cost - right.cost;

/**
 * Text in ASCII lower case, which is how a query and what it matches are compared.
 * @param text - The text.
 * @returns It, folded.
 */
export const lower = (text: string) => text.replaceAll(/[A-Z]/gu, (letter) => letter.toLowerCase());

/**
 * What was typed, as a query: trimmed, each run of whitespace one space, and folded.
 * @param typed - What was typed.
 * @returns The query.
 */
export const queryOf = (typed: string) => lower(typed.trim().replaceAll(/\s+/gu, " "));

const wordCharacter = /[\p{L}\p{N}]/u;

/**
 * Where the query starts a word of the text: at its start, or after a character that is
 * not a letter or a digit, such as `.`, `#`, or a space.
 * @param text - The text, folded.
 * @param query - The query, folded.
 * @returns Where, or -1.
 */
const wordStart = (text: string, query: string) => {
  for (let at = text.indexOf(query); at !== -1; at = text.indexOf(query, at + 1)) {
    if (at === 0 || !wordCharacter.test(text[at - 1] ?? "")) {
      return at;
    }
  }

  return -1;
};

/**
 * The span the query's characters cover in the text, in order, matching each as early as
 * it can after the last.
 * @param text - The text, folded.
 * @param query - The query, folded.
 * @returns The span and where it begins, or `null` when they do not all appear in order.
 */
const subsequence = (text: string, query: string) => {
  let first = -1;
  let at = -1;

  for (const character of query) {
    at = text.indexOf(character, at + 1);

    if (at === -1) {
      return null;
    }

    first = first === -1 ? at : first;
  }

  return { first, span: at - first };
};

/**
 * How well a query matches names and a description.
 * @param query - The query, folded, not empty.
 * @param matched - What the item is called, best first, and what it is.
 * @returns The score, or none when it does not match.
 */
const scoreOf = (query: string, matched: Matched): Score | undefined => {
  const folded = matched.names.map(lower);
  const best: Score[] = [];

  for (const [index, name] of folded.entries()) {
    // A name further down the list costs more, so the item's own name wins over its others.
    const penalty = index * 1000;

    if (name.startsWith(query)) {
      best.push({ cost: penalty + name.length, tier: tiers.Prefix });
    }

    const word = wordStart(name, query);

    if (word !== -1) {
      best.push({ cost: penalty + word * 100 + name.length, tier: tiers.WordStart });
    }

    const fuzzy = subsequence(name, query);

    if (fuzzy !== null) {
      best.push({
        cost: penalty + fuzzy.span * 1000 + fuzzy.first * 100 + name.length,
        tier: tiers.Fuzzy,
      });
    }
  }

  const described = matched.description === "" ? -1 : wordStart(lower(matched.description), query);

  if (described !== -1) {
    best.push({ cost: described, tier: tiers.Described });
  }

  return best.toSorted(byScore)[0];
};

/**
 * The items a query matches, best first, each with its score. Items that score the same
 * keep their order.
 * @param query - The query, folded, not empty.
 * @param items - The items, in their own order.
 * @param matched - What an item is matched by.
 * @returns Those that match, ranked.
 */
export const ranked = <A>(
  query: string,
  items: readonly A[],
  matched: (item: A) => Matched
): readonly { readonly item: A; readonly score: Score }[] =>
  items
    .flatMap((item) => {
      const score = scoreOf(query, matched(item));

      return score === undefined ? [] : [{ item, score }];
    })
    // Sorting is stable, so items that score the same keep their own order.
    .toSorted((left, right) => byScore(left.score, right.score));
