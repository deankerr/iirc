import { describe, expect, it } from "vitest";

import { client } from "../core.ts";
import { configured, joined, play, registered } from "../testing/index.ts";

const base = configured();

const lines = (...rows: readonly string[]): string => rows.map((row) => `${row}\n`).join("");

describe("what cannot be read is ignored, never fatal", () => {
  it.each([
    ["no command", "<< :irc.test", "Unparseable NoCommand"],
    ["only spaces", "<<\\ \\x20\\x20", "Unparseable Empty"],
    ["JOIN with no Channel", "<< :peer!u@h JOIN", "Malformed JOIN"],
    ["JOIN with no source", "<< JOIN #iirc", "Malformed JOIN"],
    ["PART with no Channel", "<< :peer!u@h PART", "Malformed PART"],
    ["KICK with no nick", "<< :op!u@h KICK #iirc", "Malformed KICK"],
    ["QUIT with no source", "<< QUIT :bye", "Malformed QUIT"],
    ["NICK with no nick", "<< :peer!u@h NICK", "Malformed NICK"],
    ["MODE with no modes", "<< :op!u@h MODE #iirc", "Malformed MODE"],
    ["TOPIC with no text", "<< :op!u@h TOPIC #iirc", "Malformed TOPIC"],
    ["AWAY with no source", "<< AWAY :gone", "Malformed AWAY"],
    ["332 with no topic", "<< :irc.test 332 iirc #iirc", "Malformed 332"],
    ["333 with no setter", "<< :irc.test 333 iirc #iirc", "Malformed 333"],
    ["324 with no modes", "<< :irc.test 324 iirc #iirc", "Malformed 324"],
    ["900 with no account", "<< :irc.test 900 iirc mask", "Malformed 900"],
    ["474 with no Channel", "<< :irc.test 474 iirc", "Malformed 474"],
  ])("ignores %s, and the Connection stays up", (_name, line, reason) => {
    const played = play(client, {
      configuration: base,
      transcript: [
        registered(base),
        joined(base, "#iirc", ["peer"]),
        lines(
          line,
          `?? ignored ${reason}`,
          "<< :peer!u@h PRIVMSG #iirc :still here",
          "?? message Privmsg peer #iirc in=channel:#iirc :still here"
        ),
      ],
    });

    expect(client.known(played.state).session._tag).toBe("Registered");
  });

  it("does nothing with a numeric or command it does not read, and ignores none of it", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        registered(base),
        lines(
          "<< :irc.test 251 iirc :There are 2 users",
          "<< :irc.test 375 iirc :- MOTD -",
          "<< :irc.test 999 iirc odd :whatever",
          "<< :irc.test WALLOPS :hello",
          "<< :irc.test 404 iirc #nowhere :Cannot send"
        ),
      ],
    });

    expect(played.ignored).toStrictEqual([]);
  });

  it("reads Lines whatever the Ircd's trailing colons", () => {
    const played = play(client, {
      configuration: base,
      transcript: [
        registered(base),
        lines(
          "!! configure +#iirc",
          ">> JOIN #iirc",
          "<< :iirc!~iirc@h JOIN :#iirc",
          "<< :irc.test 353 iirc = #iirc :iirc",
          "<< :irc.test 366 iirc #iirc End",
          "<< :peer!u@h JOIN :#iirc",
          "<< :peer!u@h PART :#iirc",
          "?? activity Parted #iirc peer in=channel:#iirc"
        ),
      ],
    });

    expect(client.known(played.state).channels.get("#iirc")?.standing).toBe("Joined");
  });
});
