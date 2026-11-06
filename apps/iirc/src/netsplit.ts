import { randomUUID } from "node:crypto";

import type { ActivityCursor, ChannelDetails, LoggedActivity, LogEntry } from "@iirc/api";
import { Console, Effect, Redacted } from "effect";

import {
  addNetwork,
  ensure,
  floorIrcd,
  floorNetwork,
  lineEntries,
  newHome,
  pageSize,
  runDaemon,
  Skipped,
  toCheck,
  untilJoined,
  waitFor,
  watcherIn,
} from "./floor.ts";
import type { Heard, Running } from "./floor.ts";

// Milestone 2 is done when derived state matches `NAMES` and `MODE` after a netsplit and a
// reconnect. This proves it on two private ngircds linked on loopback: A, which the
// Daemon is on, dials B, which waits for it. An IRC operator on A splits them with
// `DISCONNECT` and joins them again with `CONNECT`, so B and the Users on it live through
// the split, and the link's burst is what brings them back. Killing B would take its Users
// with it, so nothing would come back on the link, and ngircd's own redial, at least 5
// seconds after the last, would race the checks made during the split.

const channel = "#split";
const id = "split";
const nameA = "a.split.proof.test";
const nameB = "b.split.proof.test";
const self = "splitd";
const onB = new Set(["ob", "vb"]);

// So few that every comparison here pages.
const perPage = 2;
const operator = { name: "splitter", password: `oper-${randomUUID()}` };

// A raw client's casefolding, as ngircd's `CASEMAPPING=ascii` says, and owing nothing to the
// Daemon's own.
const asciiFold = (nick: string) => nick.replaceAll(/[A-Z]/gu, (letter) => letter.toLowerCase());

/** One side of a comparison: members as a prefix and a casefolded nick, and modes. */
interface View {
  readonly members: readonly string[];
  readonly modes: readonly string[];
}

const show = (items: readonly string[]) => (items.length === 0 ? "nothing" : items.join(" "));

const without = (items: readonly string[], others: readonly string[]) =>
  items.filter((item) => !others.includes(item));

const sameItems = (one: readonly string[], other: readonly string[]) =>
  one.length === other.length && one.every((item, index) => item === other[index]);

// One mode as both sides are compared by: a letter and its parameter, and the key as set
// only, because the Daemon never shows its value (CRED-4).
const modeWord = (letter: string, param: string | undefined) =>
  letter === "k" || param === undefined ? letter : `${letter} ${param}`;

/** What a raw client was told of `PREFIX` and `CHANMODES` in its own `005`. */
interface Told {
  readonly symbols: string;
  readonly withParam: string;
}

const toldBy = (heard: readonly Heard[]): Told => {
  const tokens = heard
    .filter(({ text }) => text.split(" ")[1] === "005")
    .flatMap(({ text }) => text.split(" "));

  const value = (name: string) =>
    tokens.find((token) => token.startsWith(`${name}=`))?.slice(name.length + 1) ?? "";

  const [, symbols = ""] = /^\([^)]*\)(?<symbols>.*)$/u.exec(value("PREFIX")) ?? [];
  const [, always = "", whenSet = ""] = value("CHANMODES").split(",");

  return { symbols, withParam: `${always}${whenSet}` };
};

// What ngircd itself says in a reply to the observer: `353`s until the `366`, and the `324`.
const ircdView = (told: Told, replies: readonly Heard[]): View => {
  const members = replies
    .flatMap(({ text }) =>
      text.split(" ")[1] === "353"
        ? text.slice(text.indexOf(" :", text.indexOf(" 353 ")) + 2).split(" ")
        : []
    )
    .flatMap((name) => {
      if (name === "") {
        return [];
      }

      return told.symbols.includes(name.charAt(0))
        ? [`${name.charAt(0)}${asciiFold(name.slice(1))}`]
        : [asciiFold(name)];
    });

  // `:server 324 eye #split +letters params...`
  const words = replies.find(({ text }) => text.split(" ")[1] === "324")?.text.split(" ") ?? [];
  const letters = (words[4] ?? "").replace(/^\+/u, "");
  const queue = words.slice(5).map((param) => param.replace(/^:/u, ""));

  const modes = letters
    .split("")
    .map((letter) => modeWord(letter, told.withParam.includes(letter) ? queue.shift() : undefined));

  return { members: members.toSorted(), modes: modes.toSorted() };
};

/**
 * Every page of the Channel the Daemon gives, two members a page so that paging is used.
 * @param running - The Daemon.
 * @returns The pages, in order.
 */
const allPages = (running: Running) =>
  Effect.gen(function* () {
    const pages: ChannelDetails[] = [];
    let after: ChannelDetails["members"]["next"] = null;

    do {
      const page: ChannelDetails = yield* running.client.networks.target({
        params: { id, target: channel },
        query: { limit: perPage, ...(after !== null && { after }) },
      });

      yield* ensure(
        page.members.items.length <= perPage,
        `a page asked for ${perPage} members gave ${page.members.items.length}`
      );
      pages.push(page);
      ({ next: after } = page.members);
    } while (after !== null);

    return pages;
  });

const daemonView = (pages: readonly ChannelDetails[]): View => ({
  // Without `multi-prefix`, `NAMES` shows only the highest prefix, so that is compared.
  members: pages
    .flatMap(({ members }) => members.items)
    .map(({ nick, symbols }) => `${symbols.charAt(0)}${asciiFold(nick)}`)
    .toSorted(),
  modes: (pages[0]?.modes ?? []).map(({ letter, param }) => modeWord(letter, param)).toSorted(),
});

// The last read of each kind the Daemon sent, which the numeric that ends its reply
// answered, if one came after it (KNOW-5).
const answers = { MODE: "324", NAMES: "366", WHO: "315" } as const;

const unanswered = (entries: readonly LogEntry[]) => {
  const lines = lineEntries(entries);

  return Object.entries(answers).flatMap(([command, numeric]) => {
    const asked = lines.findLast(
      ({ cause, direction, text }) =>
        direction === "outbound" && cause === "read" && text === `${command} ${channel}`
    );

    const answered =
      asked === undefined ||
      lines.some(({ direction, sequence, text }) => {
        const [, said, , about = ""] = text.split(" ");

        return (
          direction === "inbound" &&
          sequence > asked.sequence &&
          said === numeric &&
          asciiFold(about) === channel
        );
      });

    return answered ? [] : [command];
  });
};

/** A Daemon on A, the observer beside it, and how to compare what each says. */
interface Scene {
  readonly eye: Effect.Success<ReturnType<typeof watcherIn>>;
  readonly running: Running;
}

/**
 * The Daemon has settled once it has folded everything the observer saw before a Message
 * the observer sends after it, its Channel read says nothing is uncertain, every read it
 * sent is answered, and two reads in a row show the same `at`.
 */
const settle = Effect.fnUntraced(function* ({ eye, running }: Scene) {
  const text = `settle ${randomUUID()}`;

  yield* eye.send(`PRIVMSG ${channel} :${text}`);

  const messages = yield* waitFor(
    `the Daemon to hear "${text}"`,
    running.client.daemon.messages({ query: { after: 0, limit: pageSize, network: id } }),
    (all) => all.some((said) => said.text === text)
  );

  const barrier = messages.find((said) => said.text === text)?.sequence ?? 0;

  const look = Effect.gen(function* () {
    const first = yield* allPages(running);
    const pending = unanswered(yield* running.entriesOf(id));
    const second = yield* allPages(running);

    return { first, pending, second };
  });

  return yield* waitFor("the Daemon to settle", look, ({ first, pending, second }) => {
    const [page] = first;
    const [again] = second;

    return (
      page !== undefined &&
      again !== undefined &&
      page.at >= barrier &&
      page.at === again.at &&
      !page.uncertain.members &&
      !page.uncertain.modes &&
      pending.length === 0
    );
  }).pipe(Effect.map(({ second }) => second));
});

/**
 * Asks ngircd for `NAMES` and `MODE` through the observer, once the Daemon has settled, and
 * fails with a diff unless the Daemon says exactly the same.
 */
const compare = Effect.fnUntraced(function* (scene: Scene, label: string) {
  const { eye } = scene;
  const pages = yield* settle(scene);
  const from = eye.mark();

  yield* eye.send(`NAMES ${channel}`);
  yield* eye.send(`MODE ${channel}`);
  yield* eye.until(`ngircd's NAMES and MODE ${label}`, (text) => / 324 eye /u.test(text), from);

  const replies = eye.heard().slice(from);
  const ircd = ircdView(toldBy(eye.heard()), replies);
  const daemon = daemonView(pages);

  const members = pages.reduce((sum, { members: { items } }) => sum + items.length, 0);

  yield* ensure(
    members <= perPage || pages.length > 1,
    `${label}: ${members} members came in one page of at most ${perPage}`
  );

  const keyShown = (pages[0]?.modes ?? []).some(
    ({ letter, param }) => letter === "k" && param !== undefined
  );

  yield* ensure(!keyShown, `${label}: the Daemon shows the Channel key's value`);
  yield* ensure(
    sameItems(ircd.members, daemon.members) && sameItems(ircd.modes, daemon.modes),
    [
      `${label}: the Daemon differs from ngircd`,
      `  NAMES:  ${show(ircd.members)}`,
      `  Daemon: ${show(daemon.members)}`,
      `  only in NAMES: ${show(without(ircd.members, daemon.members))}; only in the Daemon: ${show(without(daemon.members, ircd.members))}`,
      `  MODE:   ${show(ircd.modes)}`,
      `  Daemon: ${show(daemon.modes)}`,
    ].join("\n")
  );

  yield* Console.log(
    `  ${label}: ${show(daemon.members)}; ${show(daemon.modes)}; at ${pages[0]?.at}, ` +
      `${pages.length} pages, equal to ngircd's NAMES and MODE`
  );

  return daemon;
});

const quitsSince = Effect.fnUntraced(function* (running: Running, after: number) {
  const quits: LoggedActivity[] = [];
  let cursor: ActivityCursor = { sequence: after };
  let page: readonly LoggedActivity[] = [];

  do {
    const read = yield* running.client.daemon.activity({
      query: {
        after: cursor,
        limit: pageSize,
        network: id,
        place: { _tag: "Channel", name: channel },
      },
    });

    page = read.activity;
    cursor = read.next;
    quits.push(...page.filter(({ details }) => details.kind === "quit"));
  } while (page.length > 0);

  return quits;
});

const isServerMode = (nick: string) => (text: string) =>
  text.startsWith(`:${nameB} MODE ${channel} `) && text.endsWith(` ${nick}`);

const readsSince = (entries: readonly LogEntry[], after: number) =>
  lineEntries(entries)
    .filter(
      ({ cause, direction, sequence }) =>
        direction === "outbound" && cause === "read" && sequence > after
    )
    .map(({ text }) => text);

const headOf = (running: Running) =>
  Effect.map(running.client.daemon.status(), ({ head }) => head ?? 0);

// KNOW-4, KNOW-5, KNOW-6, KNOW-8, MSG-5, LIVE-6, CRED-4
export const netsplit = toCheck(
  Effect.gen(function* () {
    const started = Date.now();
    const key = `key-${randomUUID()}`;

    const b = yield* floorIrcd({
      link: { myPassword: "b-to-a", name: nameA, peerPassword: "a-to-b" },
      name: nameB,
    });

    const a = yield* floorIrcd({
      link: { myPassword: "a-to-b", name: nameB, peerPassword: "b-to-a", port: b.port },
      name: nameA,
      operator,
    });

    if (!a.linkable || !b.linkable) {
      return new Skipped({ reason: "this ngircd did not read a [Server] block, so cannot link" });
    }

    yield* waitFor("A to link to B", a.logged, (text) =>
      text.includes(`Synchronization with "${nameB}" done`)
    );

    // First in, so ngircd makes it the Channel operator.
    const opa = yield* watcherIn(a.port, "opa", channel);

    yield* ensure(
      opa.heard().some(({ text }) => text.endsWith(" 353 opa = #split :@opa")),
      "opa does not hold @"
    );

    const ob = yield* watcherIn(b.port, "ob", channel);
    const vb = yield* watcherIn(b.port, "vb", channel);

    // A member, so that ngircd shows it the parameters of `+l` and `+k`.
    const eye = yield* watcherIn(a.port, "eye", channel);

    yield* opa.until("ob across the link", (text) => text.startsWith(":ob!"));
    yield* opa.until("vb across the link", (text) => text.startsWith(":vb!"));
    yield* ensure(ob.heard().length > 0 && vb.heard().length > 0, "B's clients heard nothing");

    yield* opa.send(`MODE ${channel} +ovv ob ob vb`);
    yield* eye.until("ob @+ and vb +", (text) => text.endsWith(`MODE ${channel} +ovv ob ob vb`));
    yield* opa.send(`MODE ${channel} +ntlk 50 ${key}`);
    yield* eye.until("the Channel's modes", (text) => text.endsWith(`+ntlk 50 ${key}`));

    // In after the prefixes, so it knows ob only as `@`, which is all `NAMES` shows.
    const running = yield* runDaemon(yield* newHome);

    yield* addNetwork(running, floorNetwork({ id, nick: self, port: a.port }));
    yield* waitFor("a Session", running.statusOf(id), ({ phase }) => phase === "session");
    yield* running.client.networks.join({
      params: { id },
      payload: { channel, key: Redacted.make(key), remember: true },
    });
    yield* untilJoined(running.statusOf(id), channel);

    const scene = { eye, running };

    yield* compare(scene, "joined");

    // A `-o` leaves ob a `+v` the Daemon never saw, until the debounced `NAMES` (KNOW-5).
    yield* opa.send(`MODE ${channel} -o ob`);

    const removed = yield* waitFor("the Daemon to record -o", running.entriesOf(id), (all) =>
      lineEntries(all).some(({ text }) => text.endsWith(`MODE ${channel} -o ob`))
    );

    const removal = lineEntries(removed).find(({ text }) => text.endsWith(`MODE ${channel} -o ob`));

    const debounced = yield* waitFor("the debounced NAMES", running.entriesOf(id), (all) =>
      lineEntries(all).some(
        ({ cause, sequence, text }) =>
          cause === "read" && text === `NAMES ${channel}` && sequence > (removal?.sequence ?? 0)
      )
    ).pipe(
      Effect.map((all) =>
        lineEntries(all).find(
          ({ cause, sequence, text }) =>
            cause === "read" && text === `NAMES ${channel}` && sequence > (removal?.sequence ?? 0)
        )
      )
    );

    yield* compare(
      scene,
      `after -o ob, by a NAMES ${(debounced?.at ?? 0) - (removal?.at ?? 0)} ms later`
    );

    yield* opa.send(`MODE ${channel} +ov ob ${self}`);
    yield* eye.until("ob @ again and Self +", (text) => text.endsWith(`+ov ob ${self}`));

    const before = yield* compare(scene, "Self voiced");

    // The split.
    yield* opa.send(`OPER ${operator.name} ${operator.password}`);
    yield* opa.until("opa to be an IRC operator", (text) => / 381 opa /u.test(text));

    const splitAt = yield* headOf(running);

    yield* opa.send(`DISCONNECT ${nameB}`);
    yield* eye.until("ob to split", (text) => text.startsWith(":ob!") && text.includes(" QUIT "));
    yield* eye.until("vb to split", (text) => text.startsWith(":vb!") && text.includes(" QUIT "));

    yield* waitFor(
      "the Daemon to drop B's Users",
      Effect.map(allPages(running), daemonView),
      ({ members }) => members.every((member) => !onB.has(member.replace(/^\W/u, "")))
    );

    const quits = yield* waitFor(
      "a QUIT in #split for each of B's Users",
      quitsSince(running, splitAt),
      (rows) => rows.length >= 2
    );

    const reason = `${nameA} ${nameB}`;

    yield* ensure(
      quits.map(({ actor }) => actor).join(",") === "ob,vb" ||
        quits.map(({ actor }) => actor).join(",") === "vb,ob",
      `the QUITs in ${channel} were from ${quits.map(({ actor }) => actor).join(",")}`
    );
    yield* ensure(
      quits.every(
        ({ details, place }) =>
          details.kind === "quit" &&
          details.reason?.text === reason &&
          place._tag === "Channel" &&
          place.key === channel
      ),
      `the QUITs were ${JSON.stringify(quits.map(({ details, place }) => ({ details, place })))}`
    );

    yield* Console.log(
      `  QUIT Activity in ${channel}: ${quits.map(({ actor, sequence }) => `${actor} at ${sequence}`).join(", ")}, "${reason}"`
    );

    const during = yield* compare(scene, "during the split");

    // The link comes back, and its burst says who is on B, and with what.
    const relinkAt = yield* headOf(running);
    const relinked = eye.mark();

    yield* opa.send(`CONNECT ${nameB}`);
    yield* eye.until("ob's modes in the burst", isServerMode("ob"), relinked);
    yield* eye.until("vb's modes in the burst", isServerMode("vb"), relinked);

    const after = yield* compare(scene, "after the rejoin burst");

    yield* ensure(
      sameItems(after.members, before.members) && sameItems(after.modes, before.modes),
      `after the rejoin burst the Daemon has ${show(after.members)}, not ${show(before.members)}`
    );

    const burst = eye
      .heard()
      .slice(relinked)
      .filter(({ text }) => text.startsWith(`:${nameB} MODE `))
      .map(({ text }) => text.slice(text.indexOf(" MODE ") + 1));

    const reread = readsSince(yield* running.entriesOf(id), relinkAt);

    yield* Console.log(
      `  the burst said ${burst.map((line) => `"${line}"`).join(" and ")}, and the Daemon ` +
        `read again with ${reread.length === 0 ? "nothing" : reread.join(", ")}`
    );

    // The reconnect: a new Session, which carries over nothing, not even Self's `+v`
    // (LIVE-6), and rejoins with the key the Owner gave (CRED-4).
    const rejoined = eye.mark();

    yield* running.client.networks.disconnect({ params: { id } });
    yield* waitFor("the disconnect", running.statusOf(id), ({ phase }) => phase === "closed");
    yield* running.client.networks.connect({ params: { id } });
    yield* untilJoined(running.statusOf(id), channel);
    yield* eye.until(
      "Self back in #split",
      (text) => text.startsWith(`:${self}!`) && text.endsWith(`JOIN :${channel}`),
      rejoined
    );

    const reconnected = yield* compare(scene, "after the reconnect");
    const selfNow = reconnected.members.find((member) => member.endsWith(self)) ?? "";

    yield* ensure(selfNow === self, `after the reconnect Self is ${selfNow}`);

    const seconds = ((Date.now() - started) / 1000).toFixed(1);

    return (
      `${nameA} and ${nameB} split by DISCONNECT and joined by CONNECT; the Daemon matched ` +
      `NAMES and MODE joined, after a debounced NAMES, during the split ` +
      `(${show(during.members)}), after the burst, and after its own reconnect, where Self ` +
      `was +${self} and came back ${selfNow}, in ${seconds} s`
    );
  })
);
