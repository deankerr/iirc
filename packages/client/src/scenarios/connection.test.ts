import { describe, expect, it } from "vitest";

import { client } from "../core.ts";
import { TimerId } from "../ids.ts";
import { configured, play, registered } from "../testing/index.ts";

const base = configured();

const lines = (...rows: readonly string[]): string => rows.map((row) => `${row}\n`).join("");

// What the Client sends when a Connection opens, before the Ircd says anything.
const opening = lines("== opened", ">> CAP LS 302", ">> NICK iirc", ">> USER iirc 0 * iirc");

const dial = "-> dial irc.test:6697 tls\n";

// Keeps a Session alive for `times` × 50 s, with the Ircd's `PING`s answered.
const chatter = (times: number): string =>
  Array.from({ length: times }, () => lines("+50s", "<< PING :keep", ">> PONG keep")).join("");

describe("dialling", () => {
  it("dials the first Ircd at once on the first Configured, and numbers it 1", () => {
    const played = play(client, { configuration: base, transcript: `!! configure\n${dial}` });

    expect(client.inspect(played.state)).toMatchObject({
      connection: 1,
      states: { network: "Connection.Dialing" },
    });
    expect(client.known(played.state).session).toStrictEqual({
      _tag: "Connecting",
      since: played.inputs[0]?.at,
    });
  });

  it("does not dial while disabled, and dials at once when enabled", () => {
    const off = configured({ enabled: false });

    const played = play(client, {
      configuration: off,
      transcript: lines("!! configure", "+1m", "!! configure enable", "-> dial irc.test:6697 tls"),
    });

    expect(played.steps[0]?.outputs).toStrictEqual([]);
  });

  it("ignores every input before the first Configured", () => {
    const played = play(client, {
      configuration: base,
      transcript: lines(
        "== started",
        "?? ignored NotNow Started",
        "!! retry",
        "?? ignored NotNow Retry",
        "!! say #iirc :early",
        "?? ignored NotNow Say",
        "!! configure",
        "-> dial irc.test:6697 tls"
      ),
    });

    expect(played.ignored).toHaveLength(3);
  });

  it("opens, and ignores a second Opened", () => {
    const played = play(client, {
      configuration: base,
      transcript: `!! configure\n${dial}${opening}== opened\n?? ignored NotNow Opened\n`,
    });

    expect(client.known(played.state).session._tag).toBe("Registering");
  });
});

describe("redialling", () => {
  it("waits 2 s, then 4, 8, and 16, doubling while Connections keep failing", () => {
    const played = play(client, {
      configuration: base,
      transcript: lines(
        "!! configure",
        "-> dial irc.test:6697 tls",
        "== closed Refused",
        "?? connection-failed Closed Refused",
        "+1999ms",
        "+1ms",
        "-> dial irc.test:6697 tls",
        "== closed Unreachable",
        "+3999ms",
        "+1ms",
        "-> dial irc.test:6697 tls",
        "== closed TimedOut",
        "+7999ms",
        "+1ms",
        "-> dial irc.test:6697 tls",
        "== closed Refused",
        "+16s",
        "-> dial irc.test:6697 tls"
      ),
    });

    expect(client.inspect(played.state).connection).toBe(5);
  });

  it("never waits more than 5 minutes", () => {
    const failures = Array.from({ length: 12 }, () =>
      lines("== closed Refused", "+5m", "-> dial irc.test:6697 tls")
    ).join("");

    const played = play(client, {
      configuration: base,
      transcript: `!! configure\n${dial}${failures}== closed Refused\n`,
    });

    expect(client.inspect(played.state).timers.get(TimerId.make("redial"))).toBe(
      (played.inputs.at(-1)?.at ?? 0) + 300_000
    );
  });

  it("starts again from 2 s after a Session that lasted", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        lines("!! configure", "-> dial irc.test:6697 tls", "== closed Refused", "+2s"),
        lines("-> dial irc.test:6697 tls", "== closed Refused", "+4s"),
        registered(base).replace(/^!! configure\n-> dial[^\n]*\n/u, "-> dial irc.test:6697 tls\n"),
        chatter(7),
        lines(
          "== closed Reset",
          "?? session-ended Closed Reset",
          "+2s",
          "-> dial irc.test:6697 tls"
        ),
      ],
    });

    expect(client.known(played.state).session._tag).toBe("Connecting");
  });

  it("does not start again from 2 s after a Session that did not last", () => {
    play(client, {
      configuration: base,
      transcript: [
        lines("!! configure", "-> dial irc.test:6697 tls", "== closed Refused", "+2s"),
        registered(base).replace(/^!! configure\n-> dial[^\n]*\n/u, "-> dial irc.test:6697 tls\n"),
        lines("== closed Reset", "+3999ms", "+1ms", "-> dial irc.test:6697 tls"),
      ],
    });

    expect.assertions(0);
  });

  it("rotates through the Ircds in order", () => {
    const two = configured({
      ircds: [
        { host: "a.test", port: 6697, tls: true },
        { host: "b.test", port: 6667, tls: false },
      ],
    });

    const played = play(client, {
      configuration: two,
      transcript: lines(
        "!! configure",
        "-> dial a.test:6697 tls",
        "== closed Refused",
        "+2s",
        "-> dial b.test:6667",
        "== closed Refused",
        "+4s",
        "-> dial a.test:6697 tls"
      ),
    });

    expect(client.inspect(played.state).connection).toBe(3);
  });

  it("dials now on Retry while waiting, and ignores Retry otherwise", () => {
    play(client, {
      configuration: base,
      transcript: lines(
        "!! configure",
        "-> dial irc.test:6697 tls",
        "!! retry",
        "?? ignored NotNow Retry",
        "== closed Refused",
        "+1s",
        "!! retry",
        "-> dial irc.test:6697 tls",
        "+5s"
      ),
    });

    expect.assertions(0);
  });

  it("keeps waiting when a Configured changes nothing that needs a dial", () => {
    play(client, {
      configuration: base,
      transcript: lines(
        "!! configure",
        "-> dial irc.test:6697 tls",
        "== closed Refused",
        "+1s",
        "!! configure +#iirc",
        "+1s",
        "-> dial irc.test:6697 tls"
      ),
    });

    expect.assertions(0);
  });
});

describe("disabling", () => {
  it("quits and hangs up a Session, and does not redial", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        registered(base),
        lines(
          "!! configure disable",
          ">> QUIT",
          "-> hangup",
          "== closed HungUp",
          "?? session-ended Disabled",
          "+60m"
        ),
      ],
    });

    expect(client.known(played.state).session._tag).toBe("Offline");
    expect(client.inspect(played.state).states).toStrictEqual({ network: "Idle" });
  });

  it("hangs up a Connection still dialling, and ignores its late Opened", () => {
    play(client, {
      configuration: base,
      transcript: lines(
        "!! configure",
        "-> dial irc.test:6697 tls",
        "!! configure disable",
        "-> hangup",
        "== opened",
        "?? ignored NotNow Opened",
        "== closed HungUp",
        "?? connection-failed Disabled",
        "+60m"
      ),
    });

    expect.assertions(0);
  });

  it("dials at once when enabled again before the Connection closed", () => {
    play(client, {
      configuration: base,
      transcript: lines(
        "!! configure",
        "-> dial irc.test:6697 tls",
        "!! configure disable",
        "-> hangup",
        "!! configure enable",
        "== closed HungUp",
        "-> dial irc.test:6697 tls"
      ),
    });

    expect.assertions(0);
  });

  it("stops waiting to redial", () => {
    const played = play(client, {
      configuration: base,
      transcript: lines(
        "!! configure",
        "-> dial irc.test:6697 tls",
        "== closed Refused",
        "!! configure disable",
        "+60m",
        "!! configure enable",
        "-> dial irc.test:6697 tls"
      ),
    });

    expect(client.inspect(played.state).timers.size).toBe(0);
  });
});

describe("restarting", () => {
  it("ends the Session it believed open, dials at once, and ignores the old Connection", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        registered(base),
        lines(
          "+1s",
          "== started",
          "?? session-ended Restarted",
          "-> dial irc.test:6697 tls",
          "== connection 1",
          "<< PING :late",
          "?? ignored StaleConnection 1",
          "== closed Reset",
          "?? ignored StaleConnection 1",
          "== connection 2",
          "== opened",
          ">> CAP LS 302",
          ">> NICK iirc",
          ">> USER iirc 0 * iirc"
        ),
      ],
    });

    expect(client.inspect(played.state).connection).toBe(2);
  });

  it("dials at once when it was waiting to redial", () => {
    play(client, {
      configuration: base,
      transcript: lines(
        "!! configure",
        "-> dial irc.test:6697 tls",
        "== closed Refused",
        "== started",
        "-> dial irc.test:6697 tls"
      ),
    });

    expect.assertions(0);
  });

  it("stays offline when disabled", () => {
    const played = play(client, {
      configuration: configured({ enabled: false }),
      transcript: lines("!! configure", "== started", "+60m"),
    });

    expect(played.steps.flatMap((step) => step.outputs)).toStrictEqual([]);
  });
});

describe("the Transport", () => {
  it("ignores input from a Connection it never dialled", () => {
    play(client, {
      configuration: base,
      transcript: lines(
        "!! configure",
        "-> dial irc.test:6697 tls",
        "== connection 7",
        "== opened",
        "?? ignored StaleConnection 7"
      ),
    });

    expect.assertions(0);
  });

  it("ignores a Line before the Connection opened", () => {
    play(client, {
      configuration: base,
      transcript: lines(
        "!! configure",
        "-> dial irc.test:6697 tls",
        "<< :irc.test NOTICE * :early",
        "?? ignored NotNow Received"
      ),
    });

    expect.assertions(0);
  });

  it("reports the Ircd's ERROR as why the Session ended", () => {
    play(client, {
      configuration: base,
      transcript: [
        registered(base),
        lines("<< ERROR :Closing Link", "== closed Ended", "?? session-ended Error"),
      ],
    });

    expect.assertions(0);
  });
});
