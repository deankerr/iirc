/**
 * A Channel's lists as Lookups: its bans, ban exceptions, and invitation masks, each asked
 * with `MODE` by the mode the Network's ISUPPORT gives it, its reply tied by label or by
 * the Channel its numerics name, and reported once as `LookedUp`.
 */
import { describe, expect, it } from "vitest";

import { client } from "../core.ts";
import { Instant } from "../ids.ts";
import type { LookResult, News } from "../news.ts";
import type { State } from "../state.ts";
import { configured, floorIsupport, joined, play, registered } from "../testing/index.ts";
import type { Played } from "../testing/index.ts";

const base = configured();

const lines = (...rows: readonly string[]): string => rows.map((row) => `${row}\n`).join("");

const echo = ["batch", "echo-message", "labeled-response"];

const lists = [...floorIsupport, "CHANMODES=beI,k,l,imnst", "EXCEPTS", "INVEX"];

const inChannel = (isupport: readonly string[] = lists, offered: readonly string[] = []) => [
  registered(base, { isupport: [...isupport], offered: [...offered] }),
  joined(base, "#iirc", ["peer"]),
];

const played = (transcript: readonly string[]) => play(client, { configuration: base, transcript });

const lookedUp = (run: Played<State>): readonly Extract<News, { _tag: "LookedUp" }>[] =>
  run.steps.flatMap((step) => step.news.filter((news) => news._tag === "LookedUp"));

const resultOf = (run: Played<State>, index = 0): LookResult | undefined =>
  lookedUp(run)[index]?.result;

const seconds = (count: number) => Instant.make(count * 1000);

describe("a Channel's bans on the floor", () => {
  it("lists each mask, with who set it and when where the Ircd says", () => {
    const run = played([
      ...inChannel(),
      lines(
        "!! bans #iirc",
        ">> MODE #iirc +b",
        "<< :irc.test 367 iirc #iirc *!*@spam.test peer!u@peer.test 1767225600",
        "<< :irc.test 367 iirc #iirc bad!*@* irc.test",
        "<< :irc.test 367 iirc #iirc old!*@*",
        "<< :irc.test 367 iirc #iirc when!*@* peer soon",
        "<< :irc.test 368 iirc #iirc :End of Channel Ban List",
        "?? looked-up i1 bans=#iirc listed masks=4"
      ),
    ]);

    expect(resultOf(run)).toStrictEqual({
      _tag: "Listed",
      cut: undefined,
      masks: [
        { mask: "*!*@spam.test", setAt: seconds(1_767_225_600), setBy: "peer!u@peer.test" },
        { mask: "bad!*@*", setAt: undefined, setBy: "irc.test" },
        { mask: "old!*@*", setAt: undefined, setBy: undefined },
        { mask: "when!*@*", setAt: undefined, setBy: "peer" },
      ],
      notes: [],
    });
  });

  it("lists none by an end with nothing before it", () => {
    const run = played([
      ...inChannel(),
      lines(
        "!! bans #iirc",
        ">> MODE #iirc +b",
        "<< :irc.test 368 iirc #iirc :End of Channel Ban List",
        "?? looked-up i1 bans=#iirc listed masks=0"
      ),
    ]);

    expect(resultOf(run)).toMatchObject({ _tag: "Listed", masks: [] });
  });

  it("asks bans by CHANMODES alone, and RFC 1459's when none was sent", () => {
    played([
      ...inChannel(floorIsupport),
      lines(
        "!! bans #iirc",
        ">> MODE #iirc +b",
        "<< :irc.test 368 iirc #iirc :End",
        "?? looked-up i1 bans=#iirc listed masks=0"
      ),
    ]);

    expect.assertions(0);
  });

  it("ignores a mask that names nothing, and keeps the rest", () => {
    const run = played([
      ...inChannel(),
      lines(
        "!! bans #iirc",
        ">> MODE #iirc +b",
        "<< :irc.test 367 iirc #iirc",
        "?? ignored Malformed 367",
        "<< :irc.test 367 iirc #iirc ok!*@*",
        "<< :irc.test 368 iirc #iirc :End",
        "?? looked-up i1 bans=#iirc listed masks=1"
      ),
    ]);

    expect(resultOf(run)).toMatchObject({ masks: [{ mask: "ok!*@*" }] });
  });

  it("keeps at most 64 masks of a long list, and says it was cut short", () => {
    const flood = Array.from(
      { length: 70 },
      (_, index) => `<< :irc.test 367 iirc #iirc n${index}!*@* peer 1767225600`
    );

    const run = played([
      ...inChannel(),
      lines(
        "!! bans #iirc",
        ">> MODE #iirc +b",
        ...flood,
        "<< :irc.test 368 iirc #iirc :End",
        "?? looked-up i1 bans=#iirc listed=Bounded masks=64"
      ),
    ]);

    const result = resultOf(run);

    expect(result?._tag === "Listed" ? result.masks.at(-1)?.mask : undefined).toBe("n63!*@*");
  });

  it("reports what it has when no end comes within its time, or its Connection ends", () => {
    played([
      ...inChannel(),
      lines(
        "!! bans #iirc",
        ">> MODE #iirc +b",
        "<< :irc.test 367 iirc #iirc a!*@*",
        "+30s",
        "?? looked-up i1 bans=#iirc listed=TimedOut masks=1",
        "...",
        "!! bans #iirc",
        ">> MODE #iirc +b",
        "== closed Reset",
        "?? looked-up i2 bans=#iirc listed=Ended masks=0",
        "..."
      ),
    ]);

    expect.assertions(0);
  });
});

describe("a Channel's exceptions and invitation masks", () => {
  it("asks each by the mode EXCEPTS and INVEX name, e and I when they name none", () => {
    const run = played([
      ...inChannel(),
      lines(
        "!! exceptions #iirc",
        ">> MODE #iirc +e",
        "<< :irc.test 348 iirc #iirc friend!*@* peer 1767225600",
        "<< :irc.test 349 iirc #iirc :End of Channel Exception List",
        "?? looked-up i1 exceptions=#iirc listed masks=1",
        "!! invitations #iirc",
        ">> MODE #iirc +I",
        "<< :irc.test 346 iirc #iirc guest!*@*",
        "<< :irc.test 347 iirc #iirc :End of Channel Invite List",
        "?? looked-up i2 invitations=#iirc listed masks=1"
      ),
    ]);

    expect([resultOf(run, 0), resultOf(run, 1)]).toMatchObject([
      { masks: [{ mask: "friend!*@*", setAt: seconds(1_767_225_600), setBy: "peer" }] },
      { masks: [{ mask: "guest!*@*", setAt: undefined, setBy: undefined }] },
    ]);
  });

  it("asks each by the mode the Network names, when it is not e or I", () => {
    played([
      ...inChannel([...floorIsupport, "CHANMODES=bxy,k,l,imnst", "EXCEPTS=x", "INVEX=y"]),
      lines(
        "!! exceptions #iirc",
        ">> MODE #iirc +x",
        "<< :irc.test 349 iirc #iirc :End",
        "?? looked-up i1 exceptions=#iirc listed masks=0",
        "!! invitations #iirc",
        ">> MODE #iirc +y",
        "<< :irc.test 347 iirc #iirc :End",
        "?? looked-up i2 invitations=#iirc listed masks=0"
      ),
    ]);

    expect.assertions(0);
  });

  it("are not offered without their token, or while CHANMODES lists their mode as no list", () => {
    played([
      ...inChannel([...floorIsupport, "CHANMODES=b,k,l,imnst"]),
      lines(
        "!! exceptions #iirc",
        "?? looked-up i1 exceptions=#iirc refused=NotOffered",
        "!! invitations #iirc",
        "?? looked-up i2 invitations=#iirc refused=NotOffered"
      ),
    ]);
    played([
      ...inChannel([...floorIsupport, "CHANMODES=b,k,l,eImnst", "EXCEPTS", "INVEX"]),
      lines(
        "!! exceptions #iirc",
        "?? looked-up i1 exceptions=#iirc refused=NotOffered",
        "!! invitations #iirc",
        "?? looked-up i2 invitations=#iirc refused=NotOffered"
      ),
    ]);
    played([
      ...inChannel([...floorIsupport, "CHANMODES=eI,k,l,imnst", "EXCEPTS", "INVEX"]),
      lines("!! bans #iirc", "?? looked-up i1 bans=#iirc refused=NotOffered"),
    ]);

    expect.assertions(0);
  });
});

describe("a refusal of a Channel's list", () => {
  it("is the result, by 482, with no end to wait for", () => {
    played([
      ...inChannel(),
      lines(
        "!! exceptions #iirc",
        ">> MODE #iirc +e",
        "<< :irc.test 482 iirc #iirc :You're not channel operator",
        "?? looked-up i1 exceptions=#iirc failed=482"
      ),
    ]);

    expect.assertions(0);
  });

  it("is not found by 403, or the 401 some Ircds give", () => {
    played([
      ...inChannel(),
      lines(
        "!! bans #gone",
        ">> MODE #gone +b",
        "<< :irc.test 403 iirc #gone :No such channel",
        "?? looked-up i1 bans=#gone not-found=403",
        "!! bans #gone",
        ">> MODE #gone +b",
        "<< :irc.test 401 iirc #gone :No such nick/channel",
        "?? looked-up i2 bans=#gone not-found=401"
      ),
    ]);

    expect.assertions(0);
  });

  it("fails by a FAIL naming MODE", () => {
    played([
      ...inChannel(),
      lines(
        "!! bans #iirc",
        ">> MODE #iirc +b",
        "<< :irc.test FAIL MODE TEMPORARILY_UNAVAILABLE #iirc :Try later",
        "?? looked-up i1 bans=#iirc failed=TEMPORARILY_UNAVAILABLE"
      ),
    ]);

    expect.assertions(0);
  });

  it("is refused offline, and for a name that is not a Channel's", () => {
    played([lines("!! bans #iirc", "?? looked-up i1 bans=#iirc refused=Offline")]);
    played([
      ...inChannel(),
      lines(
        "!! bans peer",
        "?? looked-up i1 bans=peer refused=Unsendable",
        "!! bans #a,#b",
        "?? looked-up i2 bans=#a,#b refused=Unsendable"
      ),
    ]);

    expect.assertions(0);
  });
});

describe("a Channel's list among other Lines awaiting an answer", () => {
  it("ties each reply by the Channel it names, folded by the casemapping", () => {
    const run = played([
      ...inChannel(),
      lines(
        "!! bans #Other[",
        ">> MODE #Other[ +b",
        "!! bans #iirc",
        ">> MODE #iirc +b",
        "<< :irc.test 367 iirc #iirc ours!*@*",
        "<< :irc.test 367 iirc #other{ theirs!*@*",
        "<< :irc.test 368 iirc #iirc :End",
        "?? looked-up i2 bans=#iirc listed masks=1",
        "<< :irc.test 368 iirc #other{ :End",
        "?? looked-up i1 bans=#Other[ listed masks=1"
      ),
    ]);

    expect([resultOf(run, 0), resultOf(run, 1)]).toMatchObject([
      { masks: [{ mask: "ours!*@*" }] },
      { masks: [{ mask: "theirs!*@*" }] },
    ]);
  });

  it("takes no mask of another list of the same Channel", () => {
    played([
      ...inChannel(),
      lines(
        "!! bans #iirc",
        ">> MODE #iirc +b",
        "!! exceptions #iirc",
        ">> MODE #iirc +e",
        "<< :irc.test 348 iirc #iirc friend!*@*",
        "<< :irc.test 349 iirc #iirc :End",
        "?? looked-up i2 exceptions=#iirc listed masks=1",
        "<< :irc.test 368 iirc #iirc :End",
        "?? looked-up i1 bans=#iirc listed masks=0"
      ),
    ]);

    expect.assertions(0);
  });

  it("leaves an action on the same Channel sent before it its own 482", () => {
    played([
      ...inChannel(),
      lines(
        "!! mode #iirc +b=bad!*@*",
        ">> MODE #iirc +b bad!*@*",
        "!! exceptions #iirc",
        ">> MODE #iirc +e",
        "<< :irc.test 482 iirc #iirc :You're not channel operator",
        "?? refused i1 Rejected 482 mode=#iirc:+b in=channel:#iirc",
        "<< :irc.test 482 iirc #iirc :You're not channel operator",
        "?? looked-up i2 exceptions=#iirc failed=482"
      ),
    ]);

    expect.assertions(0);
  });

  it("takes its own 482 before an action on the same Channel sent after it", () => {
    played([
      ...inChannel(),
      lines(
        "!! exceptions #iirc",
        ">> MODE #iirc +e",
        "!! mode #iirc -b=bad!*@*",
        ">> MODE #iirc -b bad!*@*",
        "<< :irc.test 482 iirc #iirc :You're not channel operator",
        "?? looked-up i1 exceptions=#iirc failed=482",
        "<< :irc.test 482 iirc #iirc :You're not channel operator",
        "?? refused i2 Rejected 482 mode=#iirc:-b in=channel:#iirc"
      ),
    ]);

    expect.assertions(0);
  });

  it("leaves the Client's own MODE query of a Channel its answer", () => {
    const run = played([
      ...inChannel(),
      lines(
        "!! bans #new",
        ">> MODE #new +b",
        "!! configure +#new",
        ">> JOIN #new",
        "<< :iirc!~iirc@iirc.test JOIN #new",
        ">> MODE #new",
        "<< :irc.test 367 iirc #new a!*@*",
        "<< :irc.test 368 iirc #new :End",
        "?? looked-up i1 bans=#new listed masks=1",
        "<< :irc.test 324 iirc #new +nt",
        "..."
      ),
    ]);

    expect(lookedUp(run)).toHaveLength(1);
  });
});

describe("a reply that names MODE, not a Channel", () => {
  it("leaves a FAIL to the Client's own MODE query sent before the list, which then ends", () => {
    played([
      ...inChannel(),
      lines(
        "!! configure +#new",
        ">> JOIN #new",
        "<< :iirc!~iirc@iirc.test JOIN #new",
        ">> MODE #new",
        "!! bans #new",
        ">> MODE #new +b",
        "<< :irc.test FAIL MODE TEMPORARILY_UNAVAILABLE :Try later",
        "?? activity StandardReply FAIL MODE TEMPORARILY_UNAVAILABLE in=network :Try later",
        "<< :irc.test FAIL MODE TEMPORARILY_UNAVAILABLE :Try later",
        "?? looked-up i1 bans=#new failed=TEMPORARILY_UNAVAILABLE"
      ),
    ]);

    expect.assertions(0);
  });

  it("gives 461 and 421 naming MODE to the list sent first, ending it at once", () => {
    played([
      ...inChannel(),
      lines(
        "!! bans #iirc",
        ">> MODE #iirc +b",
        "!! mode #iirc -b=bad!*@*",
        ">> MODE #iirc -b bad!*@*",
        "<< :irc.test 461 iirc MODE :Not enough parameters",
        "?? looked-up i1 bans=#iirc failed=461",
        "<< :irc.test 461 iirc MODE :Not enough parameters",
        "?? refused i2 Rejected 461 mode=#iirc:-b in=channel:#iirc",
        "!! exceptions #iirc",
        ">> MODE #iirc +e",
        "<< :irc.test 421 iirc MODE :Unknown command",
        "?? looked-up i3 exceptions=#iirc failed=421"
      ),
    ]);

    expect.assertions(0);
  });

  it("fails a list at once by a 472 naming its mode, and leaves one naming another mode", () => {
    played([
      ...inChannel(),
      lines(
        "!! exceptions #iirc",
        ">> MODE #iirc +e",
        "<< :irc.test 472 iirc b :is unknown mode char to me",
        "<< :irc.test 472 iirc e :is unknown mode char to me",
        "?? looked-up i1 exceptions=#iirc failed=472"
      ),
    ]);

    expect.assertions(0);
  });

  it("weighs a 472 by send order against a MODE action changing the same mode", () => {
    played([
      ...inChannel(),
      lines(
        "!! mode #iirc +e=friend!*@*",
        ">> MODE #iirc +e friend!*@*",
        "!! exceptions #iirc",
        ">> MODE #iirc +e",
        "<< :irc.test 472 iirc e :is unknown mode char to me",
        "?? refused i1 Rejected 472 mode=#iirc:+e in=channel:#iirc",
        "<< :irc.test 472 iirc e :is unknown mode char to me",
        "?? looked-up i2 exceptions=#iirc failed=472",
        "!! invitations #iirc",
        ">> MODE #iirc +I",
        "!! mode #iirc -I=guest!*@*",
        ">> MODE #iirc -I guest!*@*",
        "<< :irc.test 472 iirc I :is unknown mode char to me",
        "?? looked-up i3 invitations=#iirc failed=472",
        "<< :irc.test 472 iirc I :is unknown mode char to me",
        "?? refused i4 Rejected 472 mode=#iirc:-I in=channel:#iirc"
      ),
    ]);

    expect.assertions(0);
  });

  it("answers one change of a MODE action by a 472, leaving its others to tie their own", () => {
    played([
      ...inChannel(),
      lines(
        "!! mode #iirc +e=friend!*@* +I=guest!*@*",
        ">> MODE #iirc +eI friend!*@* guest!*@*",
        "!! invitations #iirc",
        ">> MODE #iirc +I",
        "<< :irc.test 472 iirc e :is unknown mode char to me",
        "?? refused i1 Rejected 472 mode=#iirc:+eI in=channel:#iirc",
        // The action's own `+I` still awaits its answer, and refuses nothing again.
        "<< :irc.test 472 iirc I :is unknown mode char to me",
        "<< :irc.test 472 iirc I :is unknown mode char to me",
        "?? looked-up i2 invitations=#iirc failed=472"
      ),
    ]);

    expect.assertions(0);
  });

  it("leaves 461 naming MODE to an action sent before the list", () => {
    played([
      ...inChannel(),
      lines(
        "!! mode #iirc -b=bad!*@*",
        ">> MODE #iirc -b bad!*@*",
        "!! bans #iirc",
        ">> MODE #iirc +b",
        "<< :irc.test 461 iirc MODE :Not enough parameters",
        "?? refused i1 Rejected 461 mode=#iirc:-b in=channel:#iirc",
        "<< :irc.test 368 iirc #iirc :End",
        "?? looked-up i2 bans=#iirc listed masks=0"
      ),
    ]);

    expect.assertions(0);
  });
});

describe("a labelled Channel's list", () => {
  it("collects its batch by label, and nothing outside it", () => {
    const run = played([
      ...inChannel(lists, echo),
      lines(
        "!! bans #iirc",
        ">> @label=l1 MODE #iirc +b",
        "<< :irc.test 367 iirc #iirc floor!*@*",
        "<< @label=l1 :irc.test BATCH +b1 labeled-response",
        "<< @batch=b1 :irc.test 367 iirc #iirc ours!*@* peer 1767225600",
        "<< @batch=b1 :irc.test 368 iirc #iirc :End",
        "<< :irc.test BATCH -b1",
        "?? looked-up i1 bans=#iirc listed masks=1"
      ),
    ]);

    expect(resultOf(run)).toMatchObject({ masks: [{ mask: "ours!*@*" }] });
  });

  it("is refused by a lone labelled 482, and fails by an empty batch", () => {
    played([
      ...inChannel(lists, echo),
      lines(
        "!! invitations #iirc",
        ">> @label=l1 MODE #iirc +I",
        "<< @label=l1 :irc.test 482 iirc #iirc :You're not channel operator",
        "?? looked-up i1 invitations=#iirc failed=482",
        "!! bans #iirc",
        ">> @label=l2 MODE #iirc +b",
        "<< @label=l2 :irc.test BATCH +b2 labeled-response",
        "<< :irc.test BATCH -b2",
        "?? looked-up i2 bans=#iirc failed=BATCH"
      ),
    ]);

    expect.assertions(0);
  });
});
