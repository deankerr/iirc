/**
 * `LIST` as a Lookup: the Channel directory. Its reply may be tens of thousands of Lines,
 * so it is collected into the Channels with the most members, at most `maxDirectory`, with
 * how many were seen. Only one awaits at a time, so on the floor every `321`, `322`, and
 * `323` while it awaits is its own. Its conditions go to the Ircd only as `ELIST` allows.
 */
import { describe, expect, it } from "vitest";

import { client } from "../core.ts";
import type { ChannelEntry, LookResult, News } from "../news.ts";
import type { State } from "../state.ts";
import { configured, floorIsupport, play, registered } from "../testing/index.ts";
import type { Played } from "../testing/index.ts";

const base = configured();

const lines = (...rows: readonly string[]): string => rows.map((row) => `${row}\n`).join("");

const echo = ["batch", "echo-message", "labeled-response"];

const online = (isupport: readonly string[] = [], offered: readonly string[] = []) =>
  registered(base, {
    isupport: [...floorIsupport, ...isupport],
    offered: [...offered],
  });

const played = (transcript: readonly string[]) => play(client, { configuration: base, transcript });

const resultOf = (run: Played<State>, index = 0): LookResult | undefined =>
  run.steps
    .flatMap((step) => step.news)
    .filter((news): news is Extract<News, { _tag: "LookedUp" }> => news._tag === "LookedUp")[index]
    ?.result;

const channelsOf = (run: Played<State>, index = 0): readonly ChannelEntry[] => {
  const result = resultOf(run, index);

  return result?._tag === "Channels" ? result.channels : [];
};

const namesOf = (run: Played<State>, index = 0): readonly string[] =>
  channelsOf(run, index).map((entry) => entry.channel);

const listed = (channel: string, members: number, topic = "") =>
  `<< :irc.test 322 iirc ${channel} ${members} :${topic}`;

const end = "<< :irc.test 323 iirc :End of /LIST";

describe("a Channels Lookup", () => {
  // Catches: a directory shown in the order the Ircd sent it, a 321 or 322 shown in the
  // Network's Timeline, or one malformed 322 failing the whole Lookup.
  it("lists most members first, then by name, skipping a 322 it cannot read", () => {
    const run = played([
      online(),
      lines(
        "!! list",
        ">> LIST",
        "<< :irc.test 321 iirc Channel :Users  Name",
        listed("#small", 2, "quiet"),
        listed("#b", 9, "[+nt] busy"),
        listed("#a", 9),
        "<< :irc.test 322 iirc #notopic 4",
        "<< :irc.test 322 iirc #nocount many :what",
        "?? ignored Malformed 322",
        "<< :irc.test 322 iirc #short",
        "?? ignored Malformed 322",
        "<< :irc.test 322 iirc notachannel 50 :what",
        "?? ignored Malformed 322",
        end,
        "?? looked-up i1 list channels count=4 seen=4"
      ),
    ]);

    expect(channelsOf(run)).toStrictEqual([
      { channel: "#a", members: 9, topic: "" },
      { channel: "#b", members: 9, topic: "[+nt] busy" },
      { channel: "#notopic", members: 4, topic: "" },
      { channel: "#small", members: 2, topic: "quiet" },
    ]);
  });

  // Catches: a reply of thousands of Lines cut at the Lines one Lookup keeps, or a bound
  // that keeps the first Channels to come rather than the largest.
  it("keeps the 1000 with the most members, and counts every one it saw", () => {
    const many = Array.from({ length: 1100 }, (_, index) => listed(`#c${index}`, index));

    const run = played([
      online(),
      lines(
        "!! list",
        ">> LIST",
        ...many,
        end,
        "?? looked-up i1 list channels=Bounded count=1000 seen=1100"
      ),
    ]);

    const kept = channelsOf(run);

    expect([kept[0], kept.at(-1)]).toStrictEqual([
      { channel: "#c1099", members: 1099, topic: "" },
      { channel: "#c100", members: 100, topic: "" },
    ]);
  });

  // Catches: a condition sent to an Ircd that never offered it, a filter the Client
  // leaves undone when the Ircd was not asked to do it, Channels with no members dropped
  // for at least one, or a mask an Ircd with `N` would read as its negation. The Ircd here
  // sends every Channel, so what is kept is what the Client filtered.
  it.each([
    [
      "mask and count by ELIST=CMNTU",
      "ELIST=CMNTU",
      "list mask=*iirc* least=5",
      "LIST *iirc*,>4",
      ["#iirc", "#other", "#IIRC-dev", "#tiny", "#empty"],
    ],
    [
      "the mask alone by ELIST=M",
      "ELIST=M",
      "list mask=*iirc* least=5",
      "LIST *iirc*",
      ["#iirc", "#other", "#IIRC-dev"],
    ],
    [
      "the count alone by ELIST=u",
      "ELIST=u",
      "list mask=*iirc* least=5",
      "LIST >4",
      ["#iirc", "#IIRC-dev"],
    ],
    [
      "neither without ELIST",
      undefined,
      "list mask=*iirc* least=5",
      "LIST",
      ["#iirc", "#IIRC-dev"],
    ],
    [
      "a count of none for at least one",
      "ELIST=U",
      "list least=1",
      "LIST >0",
      ["#iirc", "#other", "#IIRC-dev", "#tiny", "#empty"],
    ],
    ["no mask that starts with !, by ELIST=MNU", "ELIST=MNU", "list mask=!*iirc*", "LIST", []],
  ] as const)("sends %s, and filters the rest itself", (_name, elist, asked, sent, kept) => {
    const run = played([
      online(elist === undefined ? [] : [elist]),
      lines(
        `!! ${asked}`,
        `>> ${sent}`,
        listed("#iirc", 30),
        listed("#other", 20),
        listed("#IIRC-dev", 10),
        listed("#tiny", 1),
        listed("#empty", 0),
        end,
        "..."
      ),
    ]);

    expect(namesOf(run)).toStrictEqual(kept);
  });

  // Catches: a mask that would split into a list of Channels or a second parameter sent
  // as it is.
  it.each([
    ["a list of masks", "list mask=#a,#b", "list mask=#a,#b"],
    ["an empty mask", "list mask=", 'list mask=""'],
    ["a count of none", "list least=0", "list least=0"],
  ])("refuses %s, sending nothing", (_name, asked, described) => {
    played([
      online(["ELIST=MU"]),
      lines(`!! ${asked}`, `?? looked-up i1 ${described} refused=Unsendable`),
    ]);

    expect.assertions(0);
  });

  // Catches: two LISTs at once, whose replies no structure can tell apart, or a guard
  // that never lets go once a reply ends.
  it("refuses a second while one awaits its end, and asks again once it ends", () => {
    const run = played([
      online(),
      lines(
        "!! list",
        ">> LIST",
        listed("#first", 3),
        "!! list",
        "?? looked-up i2 list refused=Busy",
        end,
        "?? looked-up i1 list channels count=1 seen=1",
        "!! list",
        ">> LIST",
        listed("#second", 5),
        end,
        "?? looked-up i3 list channels count=1 seen=1"
      ),
    ]);

    expect(namesOf(run, 2)).toStrictEqual(["#second"]);
  });

  // Catches: the late rest of a timed-out reply shown in the Network's Timeline Line by
  // Line, or taken into the next Lookup's result.
  it("reads a timed-out reply to its end, keeping nothing more and asking nothing", () => {
    const run = played([
      online(),
      lines(
        "!! list",
        ">> LIST",
        listed("#early", 3),
        "+30s",
        "?? looked-up i1 list channels=TimedOut count=1 seen=1",
        "!! list",
        "?? looked-up i2 list refused=Busy",
        listed("#late", 7),
        end,
        "!! list",
        ">> LIST",
        listed("#fresh", 2),
        end,
        "?? looked-up i3 list channels count=1 seen=1"
      ),
    ]);

    expect(namesOf(run, 2)).toStrictEqual(["#fresh"]);
  });

  // Catches: a Lookup left awaiting a 323 that never comes, keeping the next one Busy.
  it("ends by an error or try-again naming LIST, or a FAIL of LIST", () => {
    played([
      online(),
      lines(
        "!! list",
        ">> LIST",
        "<< :irc.test 421 iirc LIST :Unknown command",
        "?? looked-up i1 list failed=421",
        "!! list",
        ">> LIST",
        "<< :irc.test 263 iirc LIST :Please wait a while and try again.",
        "?? looked-up i2 list failed=263",
        "!! list",
        ">> LIST",
        "<< :irc.test FAIL LIST SLOW :Try again",
        "?? looked-up i3 list failed=SLOW",
        "!! list",
        ">> LIST",
        end,
        "?? looked-up i4 list channels count=0 seen=0"
      ),
    ]);

    expect.assertions(0);
  });

  it("reports what it has when its Connection ends", () => {
    played([
      online(),
      lines(
        "!! list",
        ">> LIST",
        listed("#one", 1),
        "== closed Reset",
        "?? looked-up i1 list channels=Ended count=1 seen=1",
        "?? session-ended Closed Reset"
      ),
    ]);

    expect.assertions(0);
  });

  // Catches: a LIST label evicted by later labelled Lines, so its answer's end is never
  // read and every later LIST is Busy until the Connection ends.
  it("is never labelled, so any number of labelled Lines while it awaits leaves it whole", () => {
    const says = Array.from({ length: 70 }, (_, index) => [
      "!! say #iirc :hi",
      `>> @label=l${index + 1} PRIVMSG #iirc hi`,
    ]).flat();

    const run = played([
      online([], echo),
      lines(
        "!! list",
        ">> LIST",
        ...says,
        "<< :irc.test 321 iirc Channel :Users  Name",
        listed("#iirc", 4, "hello"),
        end,
        "?? looked-up i1 list channels count=1 seen=1",
        "!! list",
        ">> LIST"
      ),
    ]);

    expect(channelsOf(run)).toStrictEqual([{ channel: "#iirc", members: 4, topic: "hello" }]);
  });

  // Catches: an older WHOIS taking a 323 that names its nick as part of its reply, or a LIST
  // taking a WHOIS's error because the nick it names reads as LIST.
  it("keeps 321 to 323 to itself, and takes no error that names a nick", () => {
    played([
      online(),
      lines(
        "!! whois alice",
        ">> WHOIS alice",
        "!! list",
        ">> LIST",
        "<< :irc.test 323 iirc alice",
        "?? looked-up i2 list channels count=0 seen=0",
        "<< :irc.test 318 iirc alice :End of /WHOIS list.",
        "?? looked-up i1 whois=alice not-found=318",
        "!! list",
        ">> LIST",
        "!! whois List",
        ">> WHOIS List",
        "<< :irc.test 401 iirc List :No such nick",
        "<< :irc.test 318 iirc List :End of /WHOIS list.",
        "?? looked-up i4 whois=List not-found=401",
        end,
        "?? looked-up i3 list channels count=0 seen=0"
      ),
    ]);

    expect.assertions(0);
  });

  // Catches: an older WHOIS of a nick that reads as LIST taking the 263 that refuses the
  // LIST, so the LIST never ends and every later /list is Busy.
  it("takes a 263 naming LIST for itself, past an older WHOIS of List", () => {
    played([
      online(),
      lines(
        "!! whois List",
        ">> WHOIS List",
        "!! list",
        ">> LIST",
        "<< :irc.test 263 iirc LIST :Please wait a while and try again.",
        "?? looked-up i2 list failed=263",
        "<< :irc.test 318 iirc List :End of /WHOIS list.",
        "?? looked-up i1 whois=List not-found=318",
        "!! list",
        ">> LIST"
      ),
    ]);

    expect.assertions(0);
  });

  // Catches: a try-again after the rows began ending the Lookup, so the rest of the rows
  // fall to the next one.
  it("holds to its 323 once its rows have begun, whatever refuses it after", () => {
    const run = played([
      online(),
      lines(
        "!! list",
        ">> LIST",
        listed("#early", 3),
        "+30s",
        "?? looked-up i1 list channels=TimedOut count=1 seen=1",
        "<< :irc.test 263 iirc LIST :Please wait a while and try again.",
        "?? activity Numeric 263 LIST in=network :Please wait a while and try again.",
        "!! list",
        "?? looked-up i2 list refused=Busy",
        listed("#late", 7),
        end,
        "!! list",
        ">> LIST",
        listed("#fresh", 2),
        end,
        "?? looked-up i3 list channels count=1 seen=1"
      ),
    ]);

    expect(namesOf(run, 2)).toStrictEqual(["#fresh"]);
  });

  // Catches: a directory of one Channel called Bounded because its reply held many notes.
  it("is cut short only by Channels it did not keep, not by its notes", () => {
    const notes = Array.from({ length: 70 }, () => "<< :irc.test NOTE LIST SLOW :Busy server");
    const kept = Array.from({ length: 64 }, () => "note=NOTE:SLOW").join(" ");

    played([
      online(),
      lines(
        "!! list",
        ">> LIST",
        ...notes,
        listed("#one", 1),
        end,
        `?? looked-up i1 list channels count=1 seen=1 ${kept}`
      ),
    ]);

    expect.assertions(0);
  });
});
