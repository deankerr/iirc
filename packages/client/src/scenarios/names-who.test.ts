/**
 * `NAMES` and `WHO` as Lookups: sent through `Look`, their replies collected by structure,
 * by label or by the Channel or mask the numerics name, bounded, and reported once as
 * `LookedUp`. A `NAMES` of a Channel Self is in also corrects its members, but only by a
 * listing that ends with its `366`.
 */
import { describe, expect, it } from "vitest";

import { client } from "../core.ts";
import type { LookResult, News } from "../news.ts";
import type { State } from "../state.ts";
import { configured, floorIsupport, joined, play, registered } from "../testing/index.ts";
import type { Played } from "../testing/index.ts";

const base = configured();

const lines = (...rows: readonly string[]): string => rows.map((row) => `${row}\n`).join("");

const echo = ["batch", "echo-message", "labeled-response"];

const inChannel = (offered: readonly string[] = [], isupport = floorIsupport) => [
  registered(base, { isupport, offered: [...offered] }),
  joined(base, "#iirc", ["peer", "pal"]),
];

const played = (transcript: readonly string[], configuration = base) =>
  play(client, { configuration, transcript });

const lookedUp = (run: Played<State>): readonly Extract<News, { _tag: "LookedUp" }>[] =>
  run.steps.flatMap((step) => step.news.filter((news) => news._tag === "LookedUp"));

const resultOf = (run: Played<State>, index = 0): LookResult | undefined =>
  lookedUp(run)[index]?.result;

const membersOf = (run: Played<State>): readonly string[] => [
  ...(client.known(run.state).channels.get("#iirc")?.members.keys() ?? []),
];

const nicks = (count: number, from = 0): readonly string[] =>
  Array.from({ length: count }, (_, index) => `n${from + index}`);

describe("a NAMES Lookup", () => {
  it("reports each member with the modes its prefixes stand for, on the floor", () => {
    const run = played([
      ...inChannel(),
      lines(
        "!! names #iirc",
        ">> NAMES #iirc",
        "<< :irc.test 353 iirc = #iirc :iirc @peer +pal",
        "<< :irc.test 366 iirc #iirc :End of /NAMES list.",
        "?? looked-up i1 names=#iirc members count=3",
        "!! names #elsewhere",
        ">> NAMES #elsewhere",
        "<< :irc.test 353 iirc #elsewhere :someone",
        "<< :irc.test 366 iirc #elsewhere :End of /NAMES list.",
        "?? looked-up i2 names=#elsewhere members count=1",
        "!! names #nowhere",
        ">> NAMES #nowhere",
        "<< :irc.test 366 iirc #nowhere :End of /NAMES list.",
        "?? looked-up i3 names=#nowhere members count=0"
      ),
    ]);

    expect(resultOf(run)).toStrictEqual({
      _tag: "Members",
      cut: undefined,
      members: [
        { nick: "iirc", prefixes: [] },
        { nick: "peer", prefixes: ["o"] },
        { nick: "pal", prefixes: ["v"] },
      ],
      notes: [],
    });
    expect(resultOf(run, 1)).toMatchObject({ members: [{ nick: "someone" }] });
  });

  it("is collected by label, with every prefix multi-prefix gives", () => {
    const run = played([
      ...inChannel([...echo, "multi-prefix"]),
      lines(
        "!! names #iirc",
        ">> @label=l1 NAMES #iirc",
        "<< :irc.test 353 iirc = #iirc :notours",
        "<< :irc.test 366 iirc #iirc :End of /NAMES list.",
        "<< @label=l1 :irc.test BATCH +b1 labeled-response",
        "<< @batch=b1 :irc.test 353 iirc = #iirc :iirc @+peer pal",
        "<< @batch=b1 :irc.test 366 iirc #iirc :End of /NAMES list.",
        "<< :irc.test BATCH -b1",
        "?? looked-up i1 names=#iirc members count=3"
      ),
    ]);

    expect(resultOf(run)).toMatchObject({
      members: [
        { nick: "iirc", prefixes: [] },
        { nick: "peer", prefixes: ["o", "v"] },
        { nick: "pal", prefixes: [] },
      ],
    });
  });

  it("keeps 500 members and says the rest were cut", () => {
    const listing = Array.from(
      { length: 11 },
      (_, index) => `<< :irc.test 353 iirc = #big :${nicks(50, index * 50).join(" ")}`
    );

    const run = played([
      ...inChannel(),
      lines(
        "!! names #big",
        ">> NAMES #big",
        ...listing,
        "<< :irc.test 366 iirc #big :End of /NAMES list.",
        "?? looked-up i1 names=#big members=Bounded count=500"
      ),
    ]);

    expect(resultOf(run)).toMatchObject({ members: { 499: { nick: "n499" } } });
  });

  it("reports what it has when no end comes within its time, or its Connection ends", () => {
    played([
      ...inChannel(),
      lines(
        "!! names #other",
        ">> NAMES #other",
        "<< :irc.test 353 iirc = #other :one two",
        "+30s",
        "?? looked-up i1 names=#other members=TimedOut count=2"
      ),
    ]);
    played([
      ...inChannel(),
      lines(
        "!! names #other",
        ">> NAMES #other",
        "<< :irc.test 353 iirc = #other :one",
        "== closed Reset",
        "?? looked-up i1 names=#other members=Ended count=1",
        "?? session-ended Closed Reset"
      ),
    ]);

    expect.assertions(0);
  });

  it("corrects the members of a Channel Self is in, once its listing ends", () => {
    const run = played([
      ...inChannel(),
      lines(
        "!! names #iirc",
        ">> NAMES #iirc",
        "<< :irc.test 353 iirc = #iirc :iirc @peer newbie",
        "<< :irc.test 366 iirc #iirc :End of /NAMES list.",
        "?? looked-up i1 names=#iirc members count=3"
      ),
    ]);

    expect(membersOf(run)).toStrictEqual(["iirc", "peer", "newbie"]);
  });

  it("removes no member when its answer ends without a 366, by label, time, or Connection", () => {
    const labelled = played([
      ...inChannel(echo),
      lines(
        "!! names #iirc",
        ">> @label=l1 NAMES #iirc",
        "<< @label=l1 :irc.test BATCH +b1 labeled-response",
        "<< @batch=b1 :irc.test 353 iirc = #iirc :iirc peer",
        "<< :irc.test BATCH -b1",
        "?? looked-up i1 names=#iirc members=Ended count=2"
      ),
    ]);

    const late = played([
      ...inChannel(),
      lines(
        "!! names #iirc",
        ">> NAMES #iirc",
        "<< :irc.test 353 iirc = #iirc :iirc peer",
        "+30s",
        "?? looked-up i1 names=#iirc members=TimedOut count=2"
      ),
    ]);

    expect(membersOf(labelled)).toStrictEqual(["iirc", "peer", "pal"]);
    expect(membersOf(late)).toStrictEqual(["iirc", "peer", "pal"]);
  });

  it("leaves nothing of a labelled answer cut short for the next listing to keep", () => {
    const run = played([
      ...inChannel(echo),
      lines(
        "!! names #iirc",
        ">> @label=l1 NAMES #iirc",
        "<< @label=l1 :irc.test BATCH +b1 labeled-response",
        "<< @batch=b1 :irc.test 353 iirc = #iirc :iirc peer",
        "<< :irc.test BATCH -b1",
        "?? looked-up i1 names=#iirc members=Ended count=2",
        "!! names #iirc",
        ">> @label=l2 NAMES #iirc",
        "<< @label=l2 :irc.test BATCH +b2 labeled-response",
        "<< @batch=b2 :irc.test 353 iirc = #iirc :iirc pal",
        "<< @batch=b2 :irc.test 366 iirc #iirc :End of /NAMES list.",
        "<< :irc.test BATCH -b2",
        "?? looked-up i2 names=#iirc members count=2"
      ),
    ]);

    expect(membersOf(run)).toStrictEqual(["iirc", "pal"]);
  });

  it("reads its answer after its time runs out, so a late labelled batch leaves nothing pending", () => {
    const run = played([
      ...inChannel(echo),
      lines(
        "!! names #iirc",
        ">> @label=l1 NAMES #iirc",
        "+30s",
        "?? looked-up i1 names=#iirc members=TimedOut count=0",
        "<< @label=l1 :irc.test BATCH +b1 labeled-response",
        "<< @batch=b1 :irc.test 353 iirc = #iirc :iirc peer",
        "<< :irc.test BATCH -b1",
        "!! names #iirc",
        ">> @label=l2 NAMES #iirc",
        "<< @label=l2 :irc.test BATCH +b2 labeled-response",
        "<< @batch=b2 :irc.test 353 iirc = #iirc :iirc pal",
        "<< @batch=b2 :irc.test 366 iirc #iirc :End of /NAMES list.",
        "<< :irc.test BATCH -b2",
        "?? looked-up i2 names=#iirc members count=2"
      ),
    ]);

    expect(membersOf(run)).toStrictEqual(["iirc", "pal"]);
  });

  it("corrects the members by its own late 366 on the floor", () => {
    const run = played([
      ...inChannel(),
      lines(
        "!! names #iirc",
        ">> NAMES #iirc",
        "<< :irc.test 353 iirc = #iirc :iirc",
        "+30s",
        "?? looked-up i1 names=#iirc members=TimedOut count=1",
        "<< :irc.test 353 iirc = #iirc :peer",
        "<< :irc.test 366 iirc #iirc :End of /NAMES list."
      ),
    ]);

    expect(membersOf(run)).toStrictEqual(["iirc", "peer"]);
  });

  it("keeps two labelled answers of one Channel apart", () => {
    const run = played([
      ...inChannel(echo),
      lines(
        "!! names #iirc",
        ">> @label=l1 NAMES #iirc",
        "!! names #iirc",
        ">> @label=l2 NAMES #iirc",
        "<< @label=l1 :irc.test BATCH +b1 labeled-response",
        "<< @label=l2 :irc.test BATCH +b2 labeled-response",
        "<< @batch=b1 :irc.test 353 iirc = #iirc :iirc peer",
        "<< @batch=b2 :irc.test 353 iirc = #iirc :iirc",
        "<< :irc.test BATCH -b1",
        "?? looked-up i1 names=#iirc members=Ended count=2",
        "<< @batch=b2 :irc.test 353 iirc = #iirc :pal",
        "<< @batch=b2 :irc.test 366 iirc #iirc :End of /NAMES list.",
        "<< :irc.test BATCH -b2",
        "?? looked-up i2 names=#iirc members count=2"
      ),
    ]);

    expect(membersOf(run)).toStrictEqual(["iirc", "pal"]);
  });

  it("collects a lone labelled 353, and leaves nothing of it pending", () => {
    const run = played([
      ...inChannel(echo),
      lines(
        "!! names #iirc",
        ">> @label=l1 NAMES #iirc",
        "<< @label=l1 :irc.test 353 iirc = #iirc :iirc peer",
        "?? looked-up i1 names=#iirc members=Ended count=2",
        "<< :irc.test 353 iirc = #iirc :iirc pal",
        "<< :irc.test 366 iirc #iirc :End of /NAMES list."
      ),
    ]);

    expect(membersOf(run)).toStrictEqual(["iirc", "pal"]);
  });

  it("finishes Self's JOIN listing when it takes that listing's own Lines", () => {
    const configuration = configured({ whoOnJoin: true });

    const run = played(
      [
        registered(configuration),
        lines(
          "!! configure +#iirc",
          ">> JOIN #iirc",
          "<< :iirc!~iirc@iirc.test JOIN #iirc",
          ">> MODE #iirc",
          "!! names #iirc",
          ">> NAMES #iirc",
          "<< :irc.test 353 iirc = #iirc :iirc peer",
          "<< :irc.test 366 iirc #iirc :End of /NAMES list.",
          "?? looked-up i1 names=#iirc members count=2",
          ">> WHO #iirc"
        ),
      ],
      configuration
    );

    expect(membersOf(run)).toStrictEqual(["iirc", "peer"]);
  });

  it("takes each change to the members that comes before its 366", () => {
    const run = played([
      ...inChannel(),
      lines(
        "!! names #iirc",
        ">> NAMES #iirc",
        "<< :irc.test 353 iirc = #iirc :iirc peer pal",
        "<< :pal!~p@pal.test PART #iirc",
        "<< :new!~n@new.test JOIN #iirc",
        "<< :irc.test 366 iirc #iirc :End of /NAMES list.",
        "?? looked-up i1 names=#iirc members count=3"
      ),
    ]);

    expect(membersOf(run)).toStrictEqual(["iirc", "peer", "new"]);
  });

  it("leaves Self's JOIN listing, and the WHO it draws, to that listing's own 366, when labelled", () => {
    const configuration = configured({ whoOnJoin: true });

    const run = played(
      [
        registered(configuration, { offered: echo }),
        lines(
          "!! configure +#iirc",
          ">> JOIN #iirc",
          "<< :iirc!~iirc@iirc.test JOIN #iirc",
          ">> MODE #iirc",
          "<< :irc.test 353 iirc = #iirc :iirc peer",
          "!! names #iirc",
          ">> @label=l1 NAMES #iirc",
          "<< @label=l1 :irc.test BATCH +b1 labeled-response",
          "<< @batch=b1 :irc.test 353 iirc = #iirc :iirc peer pal",
          "<< @batch=b1 :irc.test 366 iirc #iirc :End of /NAMES list.",
          "<< :irc.test BATCH -b1",
          "?? looked-up i1 names=#iirc members count=3",
          "<< :irc.test 353 iirc = #iirc :pal other",
          "<< :irc.test 366 iirc #iirc :End of /NAMES list.",
          ">> WHO #iirc"
        ),
      ],
      configuration
    );

    expect(membersOf(run)).toStrictEqual(["iirc", "peer", "pal", "other"]);
  });

  it("lets no answer a forgotten Lookup began replace the members", () => {
    const run = played([
      ...inChannel(),
      lines(
        "!! names #iirc",
        ">> NAMES #iirc",
        "<< :irc.test 353 iirc = #iirc :iirc peer",
        "+30s",
        "?? looked-up i1 names=#iirc members=TimedOut count=2",
        "!! names #o1",
        ">> NAMES #o1",
        "!! names #o2",
        ">> NAMES #o2",
        "!! names #o3",
        ">> NAMES #o3",
        "!! names #o4",
        ">> NAMES #o4",
        "!! names #o5",
        ">> NAMES #o5",
        "!! names #o6",
        ">> NAMES #o6",
        "!! names #o7",
        ">> NAMES #o7",
        "!! names #o8",
        ">> NAMES #o8",
        "+30s",
        "?? looked-up i2 names=#o1 members=TimedOut count=0",
        "?? looked-up i3 names=#o2 members=TimedOut count=0",
        "?? looked-up i4 names=#o3 members=TimedOut count=0",
        "?? looked-up i5 names=#o4 members=TimedOut count=0",
        "?? looked-up i6 names=#o5 members=TimedOut count=0",
        "?? looked-up i7 names=#o6 members=TimedOut count=0",
        "?? looked-up i8 names=#o7 members=TimedOut count=0",
        "?? looked-up i9 names=#o8 members=TimedOut count=0",
        ">> PING iirc",
        "<< :irc.test 353 iirc = #iirc :pal",
        "<< :irc.test 366 iirc #iirc :End of /NAMES list."
      ),
    ]);

    expect(membersOf(run)).toStrictEqual(["iirc", "peer", "pal"]);
  });

  it("is ended only by a 366 naming its own Channel", () => {
    const run = played([
      ...inChannel(echo),
      lines(
        "!! names #iirc",
        ">> @label=l1 NAMES #iirc",
        "<< @label=l1 :irc.test BATCH +b1 labeled-response",
        "<< @batch=b1 :irc.test 353 iirc = #iirc :iirc peer",
        "<< @batch=b1 :irc.test 366 iirc #other :End of /NAMES list.",
        "<< :irc.test BATCH -b1",
        "?? looked-up i1 names=#iirc members=Ended count=2"
      ),
    ]);

    expect(membersOf(run)).toStrictEqual(["iirc", "peer", "pal"]);
  });

  it("ends by a lone labelled 353 that does not parse", () => {
    played([
      ...inChannel(echo),
      lines(
        "!! names #iirc",
        ">> @label=l1 NAMES #iirc",
        "<< @label=l1 :irc.test 353 iirc",
        "?? ignored Malformed 353",
        "?? looked-up i1 names=#iirc failed=353"
      ),
    ]);

    expect.assertions(0);
  });

  it("ends by an error naming its Channel, or a FAIL of NAMES", () => {
    played([
      ...inChannel(),
      lines(
        "!! names #iirc",
        ">> NAMES #iirc",
        "<< :irc.test 421 iirc NAMES :Unknown command",
        "?? looked-up i1 names=#iirc failed=421",
        "!! names #gone",
        ">> NAMES #gone",
        "<< :irc.test 403 iirc #gone :No such channel",
        "?? looked-up i2 names=#gone not-found=403",
        "!! names #iirc",
        ">> NAMES #iirc",
        "<< :irc.test FAIL NAMES SLOW :Try again",
        "?? looked-up i3 names=#iirc failed=SLOW"
      ),
    ]);

    expect.assertions(0);
  });

  it("is refused for a name that is not a Channel's, and offline", () => {
    played([lines("!! names #iirc", "?? looked-up i1 names=#iirc refused=Offline")]);
    played([
      ...inChannel(),
      lines(
        "!! names peer",
        "?? looked-up i1 names=peer refused=Unsendable",
        "!! names #a,#b",
        "?? looked-up i2 names=#a,#b refused=Unsendable"
      ),
    ]);

    expect.assertions(0);
  });
});

describe("a WHO Lookup", () => {
  it("reports each User a 352 describes, on the floor, asking no WHOX fields", () => {
    const run = played([
      ...inChannel([], [...floorIsupport, "WHOX"]),
      lines(
        "!! who *.test",
        ">> WHO *.test",
        "<< :irc.test 352 iirc * ~p peer.test irc.test peer G :3 Pe Er",
        "<< :irc.test 352 iirc #iirc ~q pal.test irc.test pal H@ :0 Pal",
        "<< :irc.test 352 iirc * ~x x.test irc.test odd * :5",
        "<< :irc.test 315 iirc *.test :End of WHO list",
        "?? looked-up i1 who=*.test users count=3"
      ),
    ]);

    expect(resultOf(run)).toStrictEqual({
      _tag: "Users",
      cut: undefined,
      notes: [],
      users: [
        { away: true, host: "peer.test", nick: "peer", realname: "Pe Er", user: "~p" },
        { away: false, host: "pal.test", nick: "pal", realname: "Pal", user: "~q" },
        { away: undefined, host: "x.test", nick: "odd", realname: undefined, user: "~x" },
      ],
    });
  });

  it("is collected by label, and an empty answer is no Users", () => {
    const run = played([
      ...inChannel(echo),
      lines(
        "!! who peer",
        ">> @label=l1 WHO peer",
        "<< :irc.test 352 iirc * ~f floor.test irc.test peer H :0 Not Ours",
        "<< :irc.test 315 iirc peer :End of WHO list",
        "<< @label=l1 :irc.test BATCH +b1 labeled-response",
        "<< @batch=b1 :irc.test 352 iirc * ~p peer.test irc.test peer H :0 Peer",
        "<< @batch=b1 :irc.test 315 iirc peer :End of WHO list",
        "<< :irc.test BATCH -b1",
        "?? looked-up i1 who=peer users count=1",
        "!! who nobody",
        ">> @label=l2 WHO nobody",
        "<< @label=l2 :irc.test 315 iirc nobody :End of WHO list",
        "?? looked-up i2 who=nobody users count=0"
      ),
    ]);

    expect(resultOf(run)).toMatchObject({ users: [{ host: "peer.test", realname: "Peer" }] });
  });

  it("is cut short by a labelled batch that ends without its 315", () => {
    played([
      ...inChannel(echo),
      lines(
        "!! who peer",
        ">> @label=l1 WHO peer",
        "<< @label=l1 :irc.test BATCH +b1 labeled-response",
        "<< @batch=b1 :irc.test 352 iirc * ~p peer.test irc.test peer H :0 Peer",
        "<< :irc.test BATCH -b1",
        "?? looked-up i1 who=peer users=Ended count=1"
      ),
    ]);

    expect.assertions(0);
  });

  it("is ended only by a 315 naming its own mask", () => {
    played([
      ...inChannel(echo),
      lines(
        "!! who peer",
        ">> @label=l1 WHO peer",
        "<< @label=l1 :irc.test BATCH +b1 labeled-response",
        "<< @batch=b1 :irc.test 352 iirc * ~p peer.test irc.test peer H :0 Peer",
        "<< @batch=b1 :irc.test 315 iirc other :End of WHO list",
        "<< :irc.test BATCH -b1",
        "?? looked-up i1 who=peer users=Ended count=1"
      ),
    ]);

    expect.assertions(0);
  });

  it("keeps 500 Users and says the rest were cut", () => {
    const flood = nicks(501).map(
      (nick) => `<< :irc.test 352 iirc * ~u ${nick}.test irc.test ${nick} H :0 ${nick}`
    );

    played([
      ...inChannel(),
      lines(
        "!! who *",
        ">> WHO *",
        ...flood,
        "<< :irc.test 315 iirc * :End of WHO list",
        "?? looked-up i1 who=* users=Bounded count=500"
      ),
    ]);

    expect.assertions(0);
  });

  it("reports what it has when no end comes within its time, or its Connection ends", () => {
    played([
      ...inChannel(),
      lines(
        "!! who peer",
        ">> WHO peer",
        "<< :irc.test 352 iirc * ~p peer.test irc.test peer H :0 Peer",
        "+30s",
        "?? looked-up i1 who=peer users=TimedOut count=1"
      ),
    ]);
    played([
      ...inChannel(),
      lines(
        "!! who peer",
        ">> WHO peer",
        "== closed Reset",
        "?? looked-up i1 who=peer users=Ended count=0",
        "?? session-ended Closed Reset"
      ),
    ]);

    expect.assertions(0);
  });

  it("leaves the join-time WHO its own Channel's Users, and shares them when it asks that Channel", () => {
    const configuration = configured({ whoOnJoin: true });

    const joining = lines(
      "!! configure +#iirc",
      ">> JOIN #iirc",
      "<< :iirc!~iirc@iirc.test JOIN #iirc",
      ">> MODE #iirc",
      "<< :irc.test 353 iirc = #iirc :iirc peer",
      "<< :irc.test 366 iirc #iirc :End of /NAMES list.",
      ">> WHO #iirc"
    );

    const answer = lines(
      "<< :irc.test 352 iirc #iirc ~iirc iirc.test irc.test iirc H :0 iirc",
      "<< :irc.test 352 iirc #iirc ~p peer.test irc.test peer G :0 Pe Er",
      "<< :irc.test 315 iirc #iirc :End of WHO list"
    );

    const ofMask = played(
      [
        registered(configuration),
        joining,
        lines("!! who peer", ">> WHO peer"),
        answer,
        lines(
          "?? channel-learned channel:#iirc",
          "<< :irc.test 352 iirc * ~p peer.test irc.test peer G :0 Pe Er",
          "<< :irc.test 315 iirc peer :End of WHO list",
          "?? looked-up i1 who=peer users count=1",
          "+31s"
        ),
      ],
      configuration
    );

    played(
      [
        registered(configuration),
        joining,
        lines("!! who #iirc", ">> WHO #iirc"),
        answer,
        lines("?? looked-up i1 who=#iirc users count=2", "?? channel-learned channel:#iirc"),
        answer,
        lines("+31s"),
      ],
      configuration
    );

    expect(client.known(ofMask.state).users.get("peer")).toMatchObject({
      away: { _tag: "Known", from: "replied" },
      realname: { _tag: "Known", value: "Pe Er" },
    });
  });

  it("leaves a 421 of WHO to the join-time WHO when it awaits none", () => {
    const configuration = configured({ whoOnJoin: true });

    played(
      [
        registered(configuration),
        lines(
          "!! configure +#iirc",
          ">> JOIN #iirc",
          "<< :iirc!~iirc@iirc.test JOIN #iirc",
          ">> MODE #iirc",
          "<< :irc.test 353 iirc = #iirc :iirc peer",
          "<< :irc.test 366 iirc #iirc :End of /NAMES list.",
          ">> WHO #iirc",
          "<< :irc.test 421 iirc WHO :Unknown command",
          "!! who peer",
          ">> WHO peer",
          "<< :irc.test 421 iirc WHO :Unknown command",
          "?? looked-up i1 who=peer failed=421",
          "+31s"
        ),
      ],
      configuration
    );

    expect.assertions(0);
  });

  it("is refused for a mask no Line can carry, and offline", () => {
    played([lines("!! who peer", "?? looked-up i1 who=peer refused=Offline")]);
    played([
      ...inChannel(),
      lines(
        "!! who :peer",
        '?? looked-up i1 who=":peer" refused=Unsendable',
        "!! who a,b",
        "?? looked-up i2 who=a,b refused=Unsendable"
      ),
    ]);

    expect.assertions(0);
  });
});
