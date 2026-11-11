/**
 * The fold over a real Client's News: a transcript played through the Client, each step
 * folded as the Runtime's News stream would give it.
 */
import { client } from "@iirc/client";
import { configured, joined, play, registered } from "@iirc/client/testing";
import { describe, expect, it } from "vitest";

import type { Change } from "./change.ts";
import { emptyDirectory, step } from "./fold.ts";
import type { Directory, Happened } from "./fold.ts";

const base = configured();

const lines = (...rows: readonly string[]): string => rows.map((row) => `${row}\n`).join("");

const folded = (transcript: readonly string[]) => {
  const played = play(client, { configuration: base, transcript });

  const happened: Happened[] = played.steps.flatMap((each, index) => {
    const input = played.inputs[index];

    return input === undefined || each.news.length === 0
      ? []
      : [{ at: input.at, network: "libera", news: each.news, sequence: index + 1 }];
  });

  let directory: Directory = emptyDirectory;
  const changes: Change[] = [];

  for (const each of happened) {
    const stepped = step(directory, each);

    ({ directory } = stepped);
    changes.push(...stepped.changes);
  }

  return { changes, directory };
};

describe("a played Session", () => {
  it("opens the Channel, the partner's Timeline, and follows the partner's rename", () => {
    const { changes, directory } = folded([
      registered(base),
      joined(base, "#iirc", ["peer"]),
      lines(
        "<< :peer!u@h PRIVMSG #iirc :hello all",
        "?? message Privmsg peer #iirc in=channel:#iirc :hello all",
        "<< :peer!u@h PRIVMSG iirc :psst",
        "?? message Privmsg peer iirc in=direct:peer :psst",
        "<< :peer!u@h NICK Peer2",
        "?? activity NickChanged peer Peer2 in=channel:#iirc in=renamed:peer>peer2:Peer2"
      ),
    ]);

    const libera = directory.networks.get("libera");

    const names = changes.flatMap((change) =>
      change._tag === "Described" ? [`${change.timeline.kind} ${change.timeline.name}`] : []
    );

    expect(names).toStrictEqual(["Network libera", "Channel #iirc", "Direct peer", "Direct Peer2"]);
    expect([...(libera?.channels.keys() ?? [])]).toStrictEqual(["#iirc"]);
    expect([...(libera?.directs.keys() ?? [])]).toStrictEqual(["peer2"]);
    expect(libera?.gap).toBeUndefined();
  });

  it("places a refused action in its Channel's Timeline as re-keyed by a casemapping declared since", () => {
    const ascii = registered(base, {
      isupport: ["CASEMAPPING=ascii", "CHANTYPES=#", "PREFIX=(ov)@+"],
    });

    const { changes, directory } = folded([
      ascii,
      joined(base, "#Foo[", ["peer"]),
      lines(
        "<< :peer!u@h PRIVMSG #Foo[ :hello",
        "...",
        "!! topic #Foo[ :mine",
        ">> TOPIC #Foo[ mine",
        "<< :irc.test 005 iirc CASEMAPPING=rfc1459 :are supported by this server",
        "...",
        "<< :irc.test 482 iirc #Foo[ :You're not channel operator",
        "?? refused i1 Rejected 482 topic=#Foo[ in=channel:#foo{:#Foo["
      ),
    ]);

    const channels = directory.networks.get("libera")?.channels;

    const refused = changes.find(
      (change) => change._tag === "Added" && change.content._tag === "ActionRefused"
    );

    expect({
      channels: [...(channels?.keys() ?? [])],
      opened: changes.filter(
        (change) => change._tag === "Described" && change.timeline.kind === "Channel"
      ).length,
      placed: refused?._tag === "Added" ? refused.timeline : undefined,
    }).toStrictEqual({ channels: ["#foo{"], opened: 2, placed: channels?.get("#foo{") });
  });
});
