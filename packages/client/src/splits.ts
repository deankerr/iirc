/**
 * A split of the Network, and its healing, as `netsplit` and `netjoin` batches tell them.
 * The Lines of one are read as they arrive, so what is known of each Channel's members is
 * what it would be unbatched, and only their News waits: each quit or join is held, placed
 * as it came, until the batch ends, and then shown as one Activity in each Channel it
 * touched, with the two servers and the nicks. A Direct Message Timeline a quit touched
 * still gets that quit, and a User the Owner ignores is shown as they were, as unbatched.
 *
 * A batch that is not what its type says is read as its Lines would be unbatched: what it
 * held is given back as it was, in the order it came, and the rest of it is read without
 * it. That is a Line in it of another command, or naming Self, or one that means no quit
 * or join, a batch opened inside it, history, a `BATCH -` with more than its reference, or
 * a quit or join past {@link maxHeld} held across the Connection. So is one that never
 * ends, when its Connection does, or when `batch` turns off, and every one open when the
 * casemapping changes, which changes how what came before is read, or holding a User whose
 * ignore mask is taken away.
 *
 * @packageDocumentation
 */
import type { Arrival } from "./feature.ts";
import { isSelf } from "./meaning.ts";
import type { News, Where } from "./news.ts";
import type { Run } from "./run.ts";
import { linkOf, updateOpen } from "./run.ts";
import type { Held, Link, Splits, Splitting } from "./state.ts";
import { maxHeld, maxSplits, noSplits } from "./state.ts";
import { openOf } from "./views.ts";

type ActivityNews = Extract<News, { readonly _tag: "Activity" }>;

/** The command each kind of split holds. */
const commands = { Netjoin: "JOIN", Netsplit: "QUIT" } as const;

const splitsOf = (run: Run): Splits => openOf(run.state)?.splits ?? noSplits;

const setSplits = (run: Run, splits: Splits): void => {
  updateOpen(run, (open) => ({ ...open, splits }));
};

// Closes the splits a test picks, and gives back what they held, as it was, in the order it
// came, which the others keep holding.
const close = (run: Run, closing: (ref: string) => boolean): readonly Held[] => {
  const { open, held } = splitsOf(run);
  const given = held.filter((each) => closing(each.ref));

  setSplits(run, {
    held: held.filter((each) => !closing(each.ref)),
    open: new Map([...open].filter(([ref]) => !closing(ref))),
  });

  return given;
};

const giveBack = (run: Run, closing: (ref: string) => boolean): void => {
  run.news.push(...close(run, closing).map(({ news }) => news));
};

// A split's end: one Activity in each Channel it touched, in the order they were first
// touched, then each quit as it was where else it was placed, which is a Direct Message
// Timeline that exists.
const show = (run: Run, splitting: Splitting, held: readonly Held[]): void => {
  const channels = new Map<string, { readonly where: Where; readonly nicks: string[] }>();
  const elsewhere: ActivityNews[] = [];

  for (const { news } of held) {
    const { activity } = news;

    // A User the Owner ignores is shown as they were, stamped, so a projection still hides them.
    if (news.ignored !== undefined) {
      elsewhere.push(news);

      continue;
    }

    const nick = activity._tag === "Quit" || activity._tag === "Joined" ? activity.nick : "";
    const others = news.where.filter((where) => where._tag !== "Channel");

    for (const where of news.where) {
      if (where._tag === "Channel") {
        const touched = channels.get(where.key) ?? { nicks: [], where };

        if (!touched.nicks.includes(nick)) {
          touched.nicks.push(nick);
        }

        channels.set(where.key, touched);
      }
    }

    if (others.length > 0) {
      elsewhere.push({ ...news, where: others });
    }
  }

  for (const { where, nicks } of channels.values()) {
    run.news.push({
      _tag: "Activity",
      activity: {
        _tag: splitting.kind,
        channel: where._tag === "Channel" ? where.name : "",
        nicks,
        servers: splitting.servers,
      },
      at: splitting.at,
      id: { _tag: "Unknown" },
      live: true,
      where: [where],
    });
  }

  run.news.push(...elsewhere);
};

/**
 * Before a Line is read: its split opens, or ends and is shown, or the Line is of a
 * command its split does not hold, and the split gives back what it held.
 * @param run - The step.
 * @param arrival - The Line.
 */
export const splitBefore = (run: Run, arrival: Arrival): void => {
  const mark = arrival.split;
  const { open, held } = splitsOf(run);

  if (mark === undefined) {
    return;
  }

  if (mark._tag === "Opens") {
    if (arrival.live && !open.has(mark.ref) && open.size < maxSplits) {
      setSplits(run, {
        held,
        open: new Map(open).set(mark.ref, {
          at: arrival.time,
          kind: mark.kind,
          servers: mark.servers,
        }),
      });
    }

    return;
  }

  const splitting = open.get(mark.ref);

  if (splitting === undefined) {
    return;
  }

  const ends = mark._tag === "Ends";

  if (ends && mark.whole) {
    show(
      run,
      splitting,
      close(run, (ref) => ref === mark.ref)
    );
  } else if (ends || arrival.line.command !== commands[splitting.kind] || !arrival.live) {
    giveBack(run, (ref) => ref === mark.ref);
  }
};

/**
 * How many quits or joins the Connection's splits hold now, before a Line is read, for
 * {@link splitAfter}.
 * @param run - The step.
 * @returns How many.
 */
export const heldBefore = (run: Run): number => splitsOf(run).held.length;

/**
 * After a Line in a split is read: one that meant no quit or join the split held, such as
 * one the core found malformed, makes the split give back what it held. Only a Line's own
 * split can hold anything as it is read, so whether the count grew says whether it did.
 * @param run - The step.
 * @param arrival - The Line.
 * @param count - What {@link heldBefore} said.
 */
export const splitAfter = (run: Run, arrival: Arrival, count: number): void => {
  const ref = arrival.split?._tag === "In" ? arrival.split.ref : undefined;
  const { open, held } = splitsOf(run);

  if (ref !== undefined && open.has(ref) && held.length === count) {
    giveBack(run, (each) => each === ref);
  }
};

/**
 * Holds an Activity a Line in a split meant, when it is what the split holds: a quit or a
 * join of a User other than Self. Any other Activity gives back what the split held first.
 * @param run - The step.
 * @param arrival - The Line.
 * @param news - The Activity, placed.
 * @returns Whether it was held, so it is not reported now.
 */
export const held = (run: Run, arrival: Arrival, news: ActivityNews): boolean => {
  const ref = arrival.split?._tag === "In" ? arrival.split.ref : undefined;
  const splits = splitsOf(run);
  const splitting = ref === undefined ? undefined : splits.open.get(ref);

  if (ref === undefined || splitting === undefined) {
    return false;
  }

  const { activity } = news;

  const holds =
    (activity._tag === "Quit" && splitting.kind === "Netsplit") ||
    (activity._tag === "Joined" && splitting.kind === "Netjoin");

  const nick = activity._tag === "Quit" || activity._tag === "Joined" ? activity.nick : undefined;

  if (!holds || nick === undefined || isSelf(run, nick) || splits.held.length >= maxHeld) {
    giveBack(run, (each) => each === ref);

    return false;
  }

  setSplits(run, { ...splits, held: [...splits.held, { news, ref }] });

  return true;
};

/**
 * Gives back what every split held, in the order it came, when its Connection ends or
 * `batch` turns off.
 * @param run - The step.
 * @param link - The Connection, as it was.
 */
export const releaseSplits = (run: Run, link: Link): void => {
  const splits = link.phase._tag === "Open" ? link.phase.splits : noSplits;

  run.news.push(...splits.held.map(({ news }) => news));

  if (splits.open.size > 0) {
    updateOpen(run, (open) => ({ ...open, splits: noSplits }));
  }
};

/**
 * Gives back what splits held, in the order it came, before News that changes how a
 * projection reads what came before it: every split before a new casemapping, which keys
 * its Timelines again, and before ignore masks are taken away, each split holding a User
 * they stamped.
 * @param run - The step.
 * @param masks - The masks taken away, or `undefined` for a new casemapping.
 */
export const giveBackSplits = (run: Run, masks?: readonly string[]): void => {
  if (linkOf(run) === undefined) {
    return;
  }

  const stamped = new Set(
    splitsOf(run).held.flatMap(({ news, ref }) =>
      masks === undefined || news.ignored?.some((mask) => masks.includes(mask)) === true
        ? [ref]
        : []
    )
  );

  giveBack(run, (ref) => masks === undefined || stamped.has(ref));
};
