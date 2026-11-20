/**
 * A split of the Network, and its healing, as `netsplit` and `netjoin` batches tell them.
 * The Lines of one are read as they arrive, so what is known of each Channel's members is
 * what it would be unbatched, and only their News waits: each quit or join is held, placed
 * as it came, until the batch ends, and then shown as one Activity in each Channel it
 * touched, with the two servers and the nicks. A Direct Message Timeline a quit touched
 * still gets that quit, and a User the Owner ignores is shown as they were, as unbatched.
 *
 * A batch that is not what its type says is read as its Lines would be unbatched: what it
 * held is given back as it was, in order, and the rest of it is read without it. That is
 * a Line in it of another command, or naming Self, or one that means no quit or join, a
 * batch opened inside it, history, a `BATCH -` with more than its reference, or a quit or
 * join past {@link maxHeld} held across the Connection. So is one that never ends, when its
 * Connection does, or when `batch` turns off, and every one open when the casemapping
 * changes or ignore masks are taken away, which change how what came before is read.
 *
 * @packageDocumentation
 */
import type { Arrival } from "./feature.ts";
import { isSelf } from "./meaning.ts";
import type { News, Where } from "./news.ts";
import type { Run } from "./run.ts";
import { linkOf, updateOpen } from "./run.ts";
import type { Link, Splitting } from "./state.ts";
import { maxHeld, maxSplits } from "./state.ts";
import { openOf } from "./views.ts";

type ActivityNews = Extract<News, { readonly _tag: "Activity" }>;

/** The command each kind of split holds. */
const commands = { Netjoin: "JOIN", Netsplit: "QUIT" } as const;

const splitsOf = (run: Run): ReadonlyMap<string, Splitting> =>
  openOf(run.state)?.splits ?? new Map();

const setSplits = (run: Run, change: (splits: Map<string, Splitting>) => void): void => {
  updateOpen(run, (open) => {
    const splits = new Map(open.splits);

    change(splits);

    return { ...open, splits };
  });
};

// Gives back what a split held, as it was, in order.
const giveBack = (run: Run, splitting: Splitting): void => {
  run.news.push(...splitting.held);
};

// A split's end: one Activity in each Channel it touched, in the order they were first
// touched, then each quit as it was where else it was placed, which is a Direct Message
// Timeline that exists.
const show = (run: Run, splitting: Splitting): void => {
  const channels = new Map<string, { readonly where: Where; readonly nicks: string[] }>();
  const elsewhere: ActivityNews[] = [];

  for (const news of splitting.held) {
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
  const splits = splitsOf(run);

  if (mark === undefined) {
    return;
  }

  if (mark._tag === "Opens") {
    if (arrival.live && !splits.has(mark.ref) && splits.size < maxSplits) {
      setSplits(run, (each) =>
        each.set(mark.ref, {
          at: arrival.time,
          held: [],
          kind: mark.kind,
          servers: mark.servers,
        })
      );
    }

    return;
  }

  const splitting = splits.get(mark.ref);

  if (splitting === undefined) {
    return;
  }

  const ends = mark._tag === "Ends";

  if (ends || arrival.line.command !== commands[splitting.kind] || !arrival.live) {
    setSplits(run, (each) => each.delete(mark.ref));

    if (ends && mark.whole) {
      show(run, splitting);
    } else {
      giveBack(run, splitting);
    }
  }
};

/**
 * How many quits or joins a Line's split holds now, before the Line is read, for
 * {@link splitAfter}.
 * @param run - The step.
 * @param arrival - The Line.
 * @returns How many, or `undefined` for a Line in no split.
 */
export const heldBefore = (run: Run, arrival: Arrival): number | undefined =>
  arrival.split?._tag === "In" ? splitsOf(run).get(arrival.split.ref)?.held.length : undefined;

/**
 * After a Line in a split is read: one that meant no quit or join the split held, such as
 * one the core found malformed, makes the split give back what it held.
 * @param run - The step.
 * @param arrival - The Line.
 * @param count - What {@link heldBefore} said.
 */
export const splitAfter = (run: Run, arrival: Arrival, count: number | undefined): void => {
  const ref = arrival.split?._tag === "In" ? arrival.split.ref : undefined;
  const splitting = ref === undefined ? undefined : splitsOf(run).get(ref);

  if (ref !== undefined && splitting !== undefined && splitting.held.length === count) {
    setSplits(run, (each) => each.delete(ref));
    giveBack(run, splitting);
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
  const splitting = ref === undefined ? undefined : splitsOf(run).get(ref);

  if (ref === undefined || splitting === undefined) {
    return false;
  }

  const { activity } = news;

  const holds =
    (activity._tag === "Quit" && splitting.kind === "Netsplit") ||
    (activity._tag === "Joined" && splitting.kind === "Netjoin");

  const nick = activity._tag === "Quit" || activity._tag === "Joined" ? activity.nick : undefined;

  const total = [...splitsOf(run).values()].reduce((sum, each) => sum + each.held.length, 0);

  if (!holds || nick === undefined || isSelf(run, nick) || total >= maxHeld) {
    setSplits(run, (each) => each.delete(ref));
    giveBack(run, splitting);

    return false;
  }

  setSplits(run, (each) => each.set(ref, { ...splitting, held: [...splitting.held, news] }));

  return true;
};

/**
 * Gives back what every split held, when its Connection ends or `batch` turns off.
 * @param run - The step.
 * @param link - The Connection, as it was.
 */
export const releaseSplits = (run: Run, link: Link): void => {
  const splits = link.phase._tag === "Open" ? link.phase.splits : new Map<string, Splitting>();

  for (const splitting of splits.values()) {
    giveBack(run, splitting);
  }

  if (splits.size > 0) {
    updateOpen(run, (open) => ({ ...open, splits: new Map() }));
  }
};

/**
 * Gives back what every split held, before News that changes how a projection reads what
 * came before it: a new casemapping, or ignore masks taken away.
 * @param run - The step.
 */
export const giveBackSplits = (run: Run): void => {
  const link = linkOf(run);

  if (link !== undefined) {
    releaseSplits(run, link);
  }
};
