import { parseLine } from "@iirc/protocol/line";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { channelOf, initialState, stepState, userOf } from "./state.ts";
import type { Channel, IrcState, StateChange, User } from "./state.ts";

// YAML has no `undefined`, so the vectors say `null` for it.
const Absent = <S extends Schema.Top>(schema: S) => Schema.optional(Schema.NullOr(schema));

const IsupportView = Schema.Struct({
  casemapping: Schema.optional(Schema.String),
  chantypes: Schema.optional(Schema.String),
  maxModes: Absent(Schema.Finite),
  modes: Schema.optional(
    Schema.Struct({
      always: Schema.String,
      flags: Schema.String,
      list: Schema.String,
      prefix: Schema.String,
      whenSet: Schema.String,
    })
  ),
  network: Absent(Schema.String),
  prefixSymbols: Schema.optional(Schema.String),
  statusmsg: Schema.optional(Schema.String),
  unknownCasemapping: Absent(Schema.String),
});

const SelfView = Schema.Struct({
  away: Schema.optional(Schema.Boolean),
  host: Absent(Schema.String),
  modes: Schema.optional(Schema.String),
  nick: Schema.optional(Schema.String),
  user: Absent(Schema.String),
});

const ChannelView = Schema.Struct({
  createdAt: Absent(Schema.Finite),
  members: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  membersUncertain: Schema.optional(Schema.Boolean),
  modes: Schema.optional(Schema.Record(Schema.String, Schema.NullOr(Schema.String))),
  modesUncertain: Schema.optional(Schema.Boolean),
  topic: Absent(
    Schema.Struct({
      setAt: Schema.NullOr(Schema.Finite),
      setBy: Schema.NullOr(Schema.String),
      text: Schema.String,
    })
  ),
});

const UserView = Schema.Struct({
  away: Absent(Schema.Boolean),
  host: Absent(Schema.String),
  nick: Schema.optional(Schema.String),
  realname: Absent(Schema.String),
  user: Absent(Schema.String),
});

const Vectors = Schema.Struct({
  tests: Schema.Array(
    Schema.Struct({
      absent: Schema.optional(Schema.Array(Schema.String)),
      changes: Schema.optional(Schema.Array(Schema.Record(Schema.String, Schema.Unknown))),
      channels: Schema.optional(Schema.Record(Schema.String, ChannelView)),
      isupport: Schema.optional(IsupportView),
      lines: Schema.Array(Schema.String),
      name: Schema.String,
      self: Schema.optional(SelfView),
      users: Schema.optional(Schema.Record(Schema.String, Schema.NullOr(UserView))),
    })
  ),
});

const vectorsFile = new URL("testdata/state.yaml", import.meta.url);

const { tests: vectors } = Schema.decodeUnknownSync(Vectors)(
  Bun.YAML.parse(await Bun.file(vectorsFile).text())
);

const run = (lines: readonly string[]) => {
  let state: IrcState = initialState;
  let changes: readonly StateChange[] = [];

  for (const text of lines) {
    const parsed = parseLine(text);

    if (parsed._tag === "Unparseable") {
      throw new Error(`Expected a Line from ${text}`);
    }

    ({ changes, next: state } = stepState(state, parsed.line));
  }

  return { changes, state };
};

const isupportView = ({ isupport }: IrcState): typeof IsupportView.Type => ({
  casemapping: isupport.casemapping,
  chantypes: isupport.chantypes,
  maxModes: isupport.maxModes ?? null,
  modes: isupport.modes,
  network: isupport.network ?? null,
  prefixSymbols: isupport.prefixSymbols,
  statusmsg: isupport.statusmsg,
  unknownCasemapping: isupport.unknownCasemapping ?? null,
});

const selfView = ({ self }: IrcState): typeof SelfView.Type | null =>
  self === undefined
    ? null
    : {
        away: self.away,
        host: self.host ?? null,
        modes: self.modes,
        nick: self.nick,
        user: self.user ?? null,
      };

const channelView = (channel: Channel): typeof ChannelView.Type => ({
  createdAt: channel.createdAt ?? null,
  members: Object.fromEntries(
    [...channel.members.values()].map(({ nick, prefixes }) => [nick, prefixes])
  ),
  membersUncertain: channel.membersUncertain,
  modes: Object.fromEntries([...channel.modes].map(([letter, param]) => [letter, param ?? null])),
  modesUncertain: channel.modesUncertain,
  topic:
    channel.topic === undefined
      ? null
      : {
          setAt: channel.topic.setAt ?? null,
          setBy: channel.topic.setBy ?? null,
          text: channel.topic.text,
        },
});

const userView = (user: User | undefined): typeof UserView.Type | null =>
  user === undefined
    ? null
    : {
        away: user.away ?? null,
        host: user.host ?? null,
        nick: user.nick,
        realname: user.realname ?? null,
        user: user.user ?? null,
      };

const changeView = (change: StateChange) =>
  Object.fromEntries(Object.entries(change).map(([field, value]) => [field, value ?? null]));

// The fields of a view that a vector names, and only those, so that each is compared
// exactly, as `toMatchObject` would not compare a nested map.
const only = <View extends object>(view: View | null, named: Partial<View>) =>
  view === null
    ? null
    : Object.fromEntries(Object.entries(view).filter(([field]) => Object.hasOwn(named, field)));

const mapped = <From, To>(
  record: Readonly<Record<string, From>>,
  each: (value: From, key: string) => To
) => Object.fromEntries(Object.entries(record).map(([key, value]) => [key, each(value, key)]));

describe("KNOW-1 to KNOW-9 Network state vectors", () => {
  it.each(vectors)("$name", (vector) => {
    const { changes, state } = run(vector.lines);
    const channels = vector.channels ?? {};
    const users = vector.users ?? {};
    const absent = vector.absent ?? [];

    expect({
      absent: absent.filter((name) => channelOf(state, name) !== undefined),
      channels: mapped(channels, (named, name) => {
        const channel = channelOf(state, name);

        return only(channel === undefined ? null : channelView(channel), named);
      }),
      isupport: only(isupportView(state), vector.isupport ?? {}),
      self: only(selfView(state), vector.self ?? {}),
      users: mapped(users, (named, nick) => {
        const user = userView(userOf(state, nick));

        return named === null ? user : only(user, named);
      }),
    }).toStrictEqual({
      absent: [],
      channels,
      isupport: vector.isupport ?? {},
      self: vector.self === undefined && state.self === undefined ? null : (vector.self ?? {}),
      users,
    });
    expect(vector.changes === undefined ? [] : changes.map(changeView)).toMatchObject(
      vector.changes ?? []
    );
  });
});
