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
 * a Line in it of another command, or naming Self, a batch opened inside it, history, or
 * more than {@link maxHeld} of them. So is one that never ends, when its Connection does,
 * or when `batch` turns off.
 *
 * @packageDocumentation
 */
import type { Arrival } from "./feature.ts";
import { isSelf } from "./meaning.ts";
import type { News, Where } from "./news.ts";
import type { Run } from "./run.ts";
import { updateOpen } from "./run.ts";
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

    if (ends) {
      show(run, splitting);
    } else {
      giveBack(run, splitting);
    }
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

  if (!holds || nick === undefined || isSelf(run, nick) || splitting.held.length >= maxHeld) {
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
