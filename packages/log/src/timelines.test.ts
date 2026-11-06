import { Database } from "bun:sqlite";

import { BunServices } from "@effect/platform-bun";
import { assert, describe, it } from "@effect/vitest";
import type { Entry, NewEntry } from "@iirc/session/entry";
import { Recorder } from "@iirc/session/recorder";
import { attemptInput } from "@iirc/session/testing";
import { Array as Arr, Effect, FileSystem, pipe } from "effect";

import { openDatabase } from "./database.ts";
import { Log } from "./log.ts";
import type { LoggedActivity, LoggedMessage, Place } from "./log.ts";
import { Partners, partnersPerGeneration } from "./partners.ts";

// MSG-1, MSG-2, MSG-5, MSG-6, KNOW-8, PROT-1, PROT-2, PROT-5, PROT-6, and LOG-10: where
// each Line belongs, what it says as a Message or as Activity, and that a rebuild derives
// exactly what was derived live.

const encoder = new TextEncoder();
const ircd = { host: "irc.example", port: 6697, tls: true };
const network = "libera";

const attempt: NewEntry = {
  _tag: "Connection",
  ircd,
  network,
  nicks: ["alice", "alice_"],
  ...attemptInput,
  phase: "attempt",
};

const opened = (connection: number): NewEntry => ({
  _tag: "Connection",
  connection,
  ircd,
  network,
  phase: "opened",
});

const closed = (connection: number, reason: string): NewEntry => ({
  _tag: "Connection",
  connection,
  ircd,
  network,
  phase: "closed",
  reason,
});

const heard = (...texts: readonly string[]): NewEntry[] =>
  texts.map((text) => ({
    _tag: "Line",
    bytes: encoder.encode(text),
    connection: 1,
    direction: "inbound",
    network,
  }));

const sent = (...texts: readonly string[]): NewEntry[] =>
  texts.map((text) => ({
    _tag: "Line",
    bytes: encoder.encode(text),
    cause: "test",
    connection: 1,
    direction: "outbound",
    network,
  }));

const record = (entries: readonly NewEntry[]) =>
  Recorder.use(({ record: recorded }) =>
    Arr.isReadonlyArrayNonEmpty(entries)
      ? recorded(entries, (all): readonly Entry[] => all)
      : Effect.succeed<readonly Entry[]>([])
  );

// A Connection's ID is the sequence of its `attempt`, which the machine checks.
const connected = (before: readonly NewEntry[] = []) =>
  Effect.gen(function* () {
    const recorded = yield* record(Arr.append(before, attempt));
    const connection = recorded.at(-1)?.sequence ?? 0;

    yield* record([opened(connection)]);

    return connection;
  });

const everything = { after: 0, limit: 1_000_000 };
const allMessages = Log.use(({ messages }) => messages(everything));

const allActivity = Log.use(({ activity }) =>
  activity({ after: { sequence: 0 }, limit: 1_000_000 })
);

const allGaps = Log.use(({ gaps }) => gaps(everything));
const rebuild = Log.use(({ rebuild: again }) => again);

const derived = Effect.gen(function* () {
  return {
    activity: yield* allActivity,
    gaps: yield* allGaps,
    messages: yield* allMessages,
    standing: yield* Recorder.use(({ standing }) => standing(network)),
  };
});

const inTempDirectory = <A, E, R>(test: (dataDir: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;

    // Not `/tmp`, because that is tmpfs on fserv, where fsync means nothing.
    return yield* test(
      yield* fileSystem.makeTempDirectoryScoped({ directory: "/var/tmp", prefix: "iirc-log-" })
    );
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer));

const withLog = <A, E>(
  test: (dataDir: string) => Effect.Effect<A, E, FileSystem.FileSystem | Log | Recorder>
) => inTempDirectory((dataDir) => test(dataDir).pipe(Effect.provide(Log.layer({ dataDir }))));

// Runs a statement on a second connection, as a vandal would.
const execute = (dataDir: string, statement: string) =>
  Effect.gen(function* () {
    const sql = yield* openDatabase(dataDir);

    yield* sql.unsafe(statement);
  }).pipe(Effect.scoped);

const shownPlace = (place: Place) =>
  place._tag === "Network" ? "network" : `${place._tag.toLowerCase()} ${place.name}`;

// An Activity as the tests read it: where, what, who, and what it says beside its kind.
const shownActivity = ({ actor, details, place }: LoggedActivity) => {
  const { kind, ...rest } = details;
  const said = Object.keys(rest).length === 0 ? "" : ` ${JSON.stringify(rest)}`;

  return `${shownPlace(place)}: ${kind} by ${actor ?? "nobody"}${said}`;
};

const shownMessage = ({ kind, place, sender, statusmsg, text }: LoggedMessage) =>
  `${shownPlace(place)}: ${kind} from ${sender}${statusmsg === undefined ? "" : ` to ${statusmsg}`}: ${text}`;

const welcome = heard(
  ":irc.example 001 alice :Welcome to the Network",
  ":irc.example 005 alice CHANTYPES=# STATUSMSG=@+ PREFIX=(ov)@+ CHANMODES=b,k,l,imnt CASEMAPPING=rfc1459 :are supported"
);

// A Session as a busy Network gives one: registration, ISUPPORT, the MOTD, joins and their
// NAMES, Messages, Direct Messages both ways, CTCP, a netsplit, nick changes, then a kill
// and a reconnect, in many commits of many sizes.
const realistic = Effect.gen(function* () {
  yield* connected([{ _tag: "Daemon", phase: "started", version: "0.0.0" }]);
  yield* record(heard(":irc.example NOTICE * :*** Looking up your hostname"));
  yield* record([
    ...welcome,
    ...heard(
      ":irc.example 375 alice :- irc.example Message of the Day -",
      ":irc.example 372 alice :- be excellent",
      ":irc.example 376 alice :End of /MOTD command.",
      ":alice!a@home MODE alice :+i"
    ),
  ]);
  yield* record(sent("JOIN #iirc,#rust"));
  yield* record(
    heard(
      ":alice!a@home JOIN #iirc",
      ":irc.example 332 alice #iirc :the topic",
      ":irc.example 353 alice = #iirc :alice @bob +carol dave split1 split2 split3",
      ":irc.example 366 alice #iirc :End of /NAMES list.",
      ":alice!a@home JOIN #Rust",
      ":irc.example 353 alice = #rust :alice bob split1 split2",
      ":irc.example 366 alice #rust :End of /NAMES list."
    )
  );
  yield* record([
    ...heard(
      ":bob!b@h PRIVMSG #iirc :hello all",
      ":bob!b@h NOTICE @#iirc :ops, look",
      ":bob!b@h PRIVMSG #iirc :\u0001ACTION waves\u0001",
      ":erin!e@h PRIVMSG alice :hi, a stranger here",
      ":erin!e@h PRIVMSG alice :\u0001VERSION\u0001"
    ),
    ...sent(
      "NOTICE erin :\u0001VERSION iirc\u0001",
      "PRIVMSG frank :hello frank",
      "PRIVMSG Grace :hello grace"
    ),
    ...sent("PRIVMSG #rust :\u0001ACTION reads\u0001"),
  ]);
  yield* record(
    heard(
      ":frank!f@h NOTICE alice :\u0001PING 123\u0001",
      ":frank!f@h PRIVMSG alice :\u0001DCC SEND file.txt 2130706433 5000 12\u0001",
      ":irc.example FAIL JOIN CHANNEL_FULL #full :Cannot join",
      ":irc.example WALLOPS :An oper says hello",
      ":irc.example CAP alice LS :multi-prefix",
      ":bob!b@h INVITE alice #secret",
      "PING :irc.example",
      ":irc.example PONG irc.example :lag-1",
      ":bob!b@h TOPIC #iirc :a new topic",
      ":bob!b@h MODE #iirc +o-v carol carol",
      ":bob!b@h MODE #iirc +k",
      ":bob!b@h KICK #iirc dave :bye dave",
      ":carol!c@h PART #iirc :later"
    )
  );
  // A netsplit: several Users leave both Channels at once, and one of them is someone Self
  // has Direct Messages with.
  yield* record(
    heard(
      ":split1!s@h QUIT :irc.example other.example",
      ":split2!s@h QUIT :irc.example other.example",
      ":split3!s@h QUIT :irc.example other.example",
      ":erin!e@h QUIT :irc.example other.example"
    )
  );
  yield* record(
    heard(
      ":bob!b@h NICK :Robert",
      ":frank!f@h NICK :franklin",
      ":alice!a@home NICK :alicia",
      ":irc.example 999 alicia :an unknown numeric",
      "ERROR :Closing Link: (Killed)"
    )
  );
  // Killed: no `closed`, then a new start, and a reconnect as someone else.
  const again = yield* connected([{ _tag: "Daemon", phase: "started", version: "0.0.0" }]);

  yield* record([
    ...heard(
      ":irc.example 001 alice_ :Welcome back",
      ":alice_!a@home JOIN #iirc",
      ":irc.example 353 alice_ = #iirc :alice_ Robert",
      ":irc.example 366 alice_ #iirc :End of /NAMES list."
    ),
  ]);
  // A partner from the last Session, who shares no Channel now. A partner's new nick has no
  // Timeline of its own until something is placed there.
  yield* record(
    heard(":GRACE!g@h QUIT :gone", ":franklin!f@h QUIT :gone too", ":Robert!b@h QUIT :also gone")
  );
  yield* record([closed(again, "iirc stopping")]);
});

// A `NAMES` reply as an Ircd sends one, 50 names a Line.
const names = (channel: string, members: readonly string[]) => [
  ...Arr.chunksOf(members, 50).map(
    (chunk) => `:irc.example 353 alice = ${channel} :${chunk.join(" ")}`
  ),
  `:irc.example 366 alice ${channel} :End of /NAMES list.`,
];

// Another Session after it, with a netsplit's storm: 300 Users across two Channels, some in
// both, quit in one socket read, and 100 more change nick, a few of them partners.
const stormy = Effect.gen(function* () {
  yield* realistic;
  yield* connected();

  const users = Arr.range(1, 400).map((index) => `user${index}`);

  yield* record([
    ...welcome,
    ...heard(":alice!a@home JOIN #a", ...names("#a", users.slice(0, 250))),
    ...heard(":alice!a@home JOIN #b", ...names("#b", users.slice(150))),
    ...heard(":user390!u@h PRIVMSG alice :psst", ":user5!u@h PRIVMSG alice :psst"),
  ]);
  yield* record(
    heard(...users.slice(0, 300).map((nick) => `:${nick}!u@h QUIT :a.example b.example`))
  );
  yield* record(heard(...users.slice(300).map((nick) => `:${nick}!u@h NICK :${nick}_`)));
});

describe("Timelines in the Log", () => {
  describe("a realistic Session", () => {
    it.effect("MSG-1, MSG-2: derives each Message once, in its place", () =>
      withLog(() =>
        Effect.gen(function* () {
          yield* realistic;

          assert.deepStrictEqual((yield* allMessages).map(shownMessage), [
            "network: NOTICE from irc.example: *** Looking up your hostname",
            "channel #iirc: PRIVMSG from bob: hello all",
            "channel #iirc: NOTICE from bob to @: ops, look",
            "channel #iirc: ACTION from bob: waves",
            "user erin: PRIVMSG from erin: hi, a stranger here",
            "user frank: PRIVMSG from alice: hello frank",
            "user Grace: PRIVMSG from alice: hello grace",
            "channel #rust: ACTION from alice: reads",
          ]);
        })
      )
    );

    it.effect("MSG-5, MSG-6, KNOW-8, PROT-1, PROT-2, PROT-5, PROT-6: derives its Activity", () =>
      withLog(() =>
        Effect.gen(function* () {
          yield* realistic;

          assert.deepStrictEqual((yield* allActivity).map(shownActivity), [
            // MSG-6: registration and the MOTD are the Network's.
            'network: line by irc.example {"command":"001","params":["alice","Welcome to the Network"]}',
            'network: line by irc.example {"command":"005","params":["alice","CHANTYPES=#","STATUSMSG=@+","PREFIX=(ov)@+","CHANMODES=b,k,l,imnt","CASEMAPPING=rfc1459","are supported"]}',
            'network: line by irc.example {"command":"375","params":["alice","- irc.example Message of the Day -"]}',
            'network: line by irc.example {"command":"372","params":["alice","- be excellent"]}',
            'network: line by irc.example {"command":"376","params":["alice","End of /MOTD command."]}',
            'network: mode by alice {"params":["+i"]}',
            "channel #iirc: join by alice",
            'network: line by irc.example {"command":"332","params":["alice","#iirc","the topic"]}',
            'network: line by irc.example {"command":"353","params":["alice","=","#iirc","alice @bob +carol dave split1 split2 split3"]}',
            'network: line by irc.example {"command":"366","params":["alice","#iirc","End of /NAMES list."]}',
            "channel #Rust: join by alice",
            'network: line by irc.example {"command":"353","params":["alice","=","#rust","alice bob split1 split2"]}',
            'network: line by irc.example {"command":"366","params":["alice","#rust","End of /NAMES list."]}',
            // PROT-2: a CTCP request is Activity, in the place a Message would have.
            'user erin: ctcp by erin {"args":"","command":"VERSION","reply":false}',
            'user frank: ctcp by frank {"args":"123","command":"PING","reply":true}',
            // PROT-5: a DCC offer is recorded, and nothing more.
            'user frank: dcc by frank {"args":"file.txt 2130706433 5000 12","subcommand":"SEND"}',
            // PROT-6.
            'network: reply by irc.example {"code":"CHANNEL_FULL","command":"JOIN","context":["#full"],"description":"Cannot join","reply":"FAIL"}',
            // PROT-1: a command the Daemon does not handle is an unknown Line.
            'network: unknown by irc.example {"command":"WALLOPS","params":["An oper says hello"]}',
            'network: unknown by irc.example {"command":"CAP","params":["alice","LS","multi-prefix"]}',
            'user bob: invite by bob {"channel":"#secret","nick":"alice"}',
            'channel #iirc: topic by bob {"topic":"a new topic"}',
            'channel #iirc: mode by bob {"changes":[{"adding":true,"letter":"o","param":"carol"},{"adding":false,"letter":"v","param":"carol"}],"params":["+o-v","carol","carol"]}',
            // KNOW-6: a MODE that does not add up is kept raw.
            'channel #iirc: mode by bob {"params":["+k"]}',
            'channel #iirc: kick by bob {"nick":"dave","reason":"bye dave"}',
            'channel #iirc: part by carol {"reason":"later"}',
            // KNOW-8: a QUIT in each Channel shared just before it.
            'channel #iirc: quit by split1 {"reason":"irc.example other.example"}',
            'channel #Rust: quit by split1 {"reason":"irc.example other.example"}',
            'channel #iirc: quit by split2 {"reason":"irc.example other.example"}',
            'channel #Rust: quit by split2 {"reason":"irc.example other.example"}',
            'channel #iirc: quit by split3 {"reason":"irc.example other.example"}',
            // KNOW-8: a partner who shares no Channel quits in their own Timeline.
            'user erin: quit by erin {"reason":"irc.example other.example"}',
            'channel #iirc: nick by bob {"from":"bob","to":"Robert"}',
            'channel #Rust: nick by bob {"from":"bob","to":"Robert"}',
            // bob is a partner too, by his invite.
            'user bob: nick by bob {"from":"bob","to":"Robert"}',
            'user frank: nick by frank {"from":"frank","to":"franklin"}',
            'channel #iirc: nick by alice {"from":"alice","to":"alicia"}',
            'channel #Rust: nick by alice {"from":"alice","to":"alicia"}',
            'network: line by irc.example {"command":"999","params":["alicia","an unknown numeric"]}',
            'network: line by nobody {"command":"ERROR","params":["Closing Link: (Killed)"]}',
            'network: line by irc.example {"command":"001","params":["alice_","Welcome back"]}',
            "channel #iirc: join by alice_",
            'network: line by irc.example {"command":"353","params":["alice_","=","#iirc","alice_ Robert"]}',
            'network: line by irc.example {"command":"366","params":["alice_","#iirc","End of /NAMES list."]}',
            // KNOW-8: partners outlast a Session, so this Session knows Grace was one.
            'user GRACE: quit by GRACE {"reason":"gone"}',
            'network: quit by franklin {"reason":"gone too"}',
            'channel #iirc: quit by Robert {"reason":"also gone"}',
          ]);
        })
      )
    );

    it.effect("KNOW-3: a place is keyed under the mapping in force, and keeps its spelling", () =>
      withLog(() =>
        Effect.gen(function* () {
          yield* realistic;

          const places = (yield* allActivity).map(({ place }) => place);

          assert.deepInclude(places, { _tag: "Channel", key: "#rust", name: "#Rust" });
          assert.deepInclude(places, { _tag: "User", key: "grace", name: "GRACE" });
          assert.deepInclude(
            (yield* allMessages).map(({ place }) => place),
            { _tag: "User", key: "grace", name: "Grace" }
          );
        })
      )
    );

    it.effect("LOG-10: rebuilt Messages, Activity, and Gaps equal the live ones", () =>
      withLog((dataDir) =>
        Effect.gen(function* () {
          yield* stormy;

          const live = yield* derived;

          // A fixture that derives little would pass everything below.
          assert.lengthOf(live.messages, 10);
          // The first Session's, then the second's registration, joins, and NAMES, a QUIT in
          // each Channel it leaves and in user5's Timeline, and a NICK in #b and user390's.
          assert.lengthOf(live.activity, 46 + 16 + (150 + 2 * 100 + 50 + 1) + (100 + 1));
          assert.lengthOf(live.gaps, 2);

          yield* rebuild;

          assert.deepStrictEqual(yield* derived, live);

          // A rebuild that kept the old rows would pass the check above.
          yield* execute(dataDir, "DELETE FROM activity");
          assert.deepStrictEqual(yield* allActivity, []);

          yield* rebuild;

          assert.deepStrictEqual(yield* derived, live);
        })
      )
    );

    it.effect("LOG-10: gives the same rows one Entry at a time as in its commits", () =>
      Effect.gen(function* () {
        const inCommits = yield* withLog(() => Effect.andThen(stormy, derived));

        const oneByOne = yield* withLog(() =>
          Effect.gen(function* () {
            const real = yield* Recorder;

            yield* stormy.pipe(
              Effect.provideService(Recorder, {
                ...real,
                record: (entries, within) =>
                  Effect.map(
                    Effect.all(
                      pipe(
                        entries,
                        Arr.map((entry) => real.record([entry], ([one]) => one))
                      )
                    ),
                    within
                  ),
              })
            );

            return yield* derived;
          })
        );

        assert.deepStrictEqual(oneByOne.activity, inCommits.activity);
        assert.deepStrictEqual(oneByOne.messages, inCommits.messages);
      })
    );

    it.effect("MSG-5, LOG-10: the writer's read pages by cursor, inside an Entry too", () =>
      withLog(() =>
        Effect.gen(function* () {
          yield* stormy;

          const all = yield* allActivity;
          const paged: LoggedActivity[] = [];

          let page = yield* Log.use(({ activity }) =>
            activity({ after: { sequence: 0 }, limit: 7 })
          );

          while (page.length > 0) {
            assert.isAtMost(page.length, 7);
            paged.push(...page);

            const { ordinal, sequence } = page.at(-1) ?? { ordinal: 0, sequence: 0 };

            page = yield* Log.use(({ activity }) =>
              activity({ after: { ordinal, sequence }, limit: 7 })
            );
          }

          // Each QUIT of the storm is in two Channels, so pages of 7 end inside Entries.
          assert.deepStrictEqual(paged, all);
        })
      )
    );

    for (const vandalism of ["DELETE FROM activity", "DROP TABLE activity"]) {
      it.effect(`LOG-10: a restart after \`${vandalism}\` derives identical rows`, () =>
        inTempDirectory((dataDir) =>
          Effect.gen(function* () {
            const before = yield* Effect.andThen(stormy, derived).pipe(
              Effect.provide(Log.layer({ dataDir }))
            );

            yield* execute(dataDir, vandalism);

            const after = yield* derived.pipe(Effect.provide(Log.layer({ dataDir })));

            assert.deepStrictEqual(after, before);
          })
        )
      );
    }

    it.effect("LOG-10: a derived table of another shape is made again, and filled", () =>
      inTempDirectory((dataDir) =>
        Effect.gen(function* () {
          const before = yield* Effect.andThen(stormy, derived).pipe(
            Effect.provide(Log.layer({ dataDir }))
          );

          // `messages` as an earlier binary shaped it, with a row of its own.
          yield* Effect.sync(() => {
            const database = new Database(`${dataDir}/iirc.sqlite`);

            database.run("DROP TABLE messages");
            database.run(
              "CREATE TABLE messages (sequence INTEGER PRIMARY KEY, at INTEGER NOT NULL, " +
                "kind TEXT NOT NULL, network TEXT NOT NULL, sender TEXT NOT NULL, " +
                "target TEXT NOT NULL, text TEXT NOT NULL) STRICT"
            );
            database.run(
              "INSERT INTO messages VALUES (1, 0, 'PRIVMSG', 'libera', 'x', '#x', 'old')"
            );
            database.close();
          });

          const after = yield* derived.pipe(Effect.provide(Log.layer({ dataDir })));

          assert.deepStrictEqual(after, before);
        })
      )
    );
  });

  describe("placing and attributing", () => {
    it.effect("MSG-2: Self's outbound Messages are placed by their Target", () =>
      withLog(() =>
        Effect.gen(function* () {
          yield* connected();
          yield* record(welcome);
          yield* record(
            sent(
              "PRIVMSG #iirc :to a Channel",
              "NOTICE @#iirc :to its ops",
              "PRIVMSG Bob[1] :to a User",
              "PRIVMSG $*.example :to a mask"
            )
          );

          const messages = yield* allMessages;

          assert.deepStrictEqual(messages.map(shownMessage), [
            "channel #iirc: PRIVMSG from alice: to a Channel",
            "channel #iirc: NOTICE from alice to @: to its ops",
            "user Bob[1]: PRIVMSG from alice: to a User",
            "network: PRIVMSG from alice: to a mask",
          ]);
          assert.deepStrictEqual(messages[2]?.place, {
            _tag: "User",
            key: "bob{1}",
            name: "Bob[1]",
          });
        })
      )
    );

    it.effect("MSG-3: text keeps its formatting codes, an ACTION's too", () =>
      withLog(() =>
        Effect.gen(function* () {
          yield* connected();
          yield* record(welcome);
          yield* record(
            heard(
              ":bob!b@h PRIVMSG #iirc :\u0002bold\u0002 \u000312blue",
              ":bob!b@h PRIVMSG #iirc :\u0001ACTION \u001Dleans\u001D"
            )
          );

          assert.deepStrictEqual(
            (yield* allMessages).map(({ kind, text }) => [kind, text]),
            [
              ["PRIVMSG", "\u0002bold\u0002 \u000312blue"],
              ["ACTION", "\u001Dleans\u001D"],
            ]
          );
        })
      )
    );

    it.effect("PROT-2: a CTCP request other than ACTION is no Message, and Self's is nothing", () =>
      withLog(() =>
        Effect.gen(function* () {
          yield* connected();
          yield* record(welcome);
          yield* record([
            ...heard(":bob!b@h PRIVMSG #iirc :\u0001TIME\u0001"),
            ...sent("PRIVMSG bob :\u0001VERSION\u0001"),
          ]);

          assert.deepStrictEqual(yield* allMessages, []);
          assert.deepStrictEqual((yield* allActivity).slice(2).map(shownActivity), [
            'channel #iirc: ctcp by bob {"args":"","command":"TIME","reply":false}',
          ]);
        })
      )
    );

    it.effect("KNOW-8: a partner is anyone Self exchanged a place with, in either direction", () =>
      withLog(() =>
        Effect.gen(function* () {
          yield* connected();
          yield* record(welcome);
          yield* record([
            ...sent("PRIVMSG Carol :hi carol"),
            ...heard(
              ":dave!d@h NOTICE alice :hi alice",
              ":CAROL!c@h NICK carol2",
              ":dave!d@h QUIT :bye",
              ":stranger!s@h QUIT :never spoke"
            ),
          ]);

          assert.deepStrictEqual((yield* allActivity).slice(2).map(shownActivity), [
            // Under the mapping in force, CAROL is Carol, so her Timeline has it.
            'user CAROL: nick by CAROL {"from":"CAROL","to":"carol2"}',
            'user dave: quit by dave {"reason":"bye"}',
            // Someone who shares nothing and has no Timeline still is not invisible.
            'network: quit by stranger {"reason":"never spoke"}',
          ]);
        })
      )
    );

    it.effect("MSG-6: a NAMES reply is one row for each Line, never one for each member", () =>
      withLog(() =>
        Effect.gen(function* () {
          const nicks = Arr.range(1, 2000).map((index) => `user${index}`);

          yield* connected();
          yield* record([...welcome, ...heard(":alice!a@h JOIN #big")]);
          yield* record([
            ...Arr.chunksOf(nicks, 100).flatMap((chunk) =>
              heard(`:irc.example 353 alice = #big :${chunk.join(" ")}`)
            ),
            ...heard(":irc.example 366 alice #big :End of /NAMES list."),
          ]);

          // The welcome, the ISUPPORT, the JOIN, 20 NAMES Lines, and their end.
          assert.lengthOf(yield* allActivity, 24);
        })
      )
    );

    it.effect("LIVE-1: a PING or a PONG is in no Timeline, only in /entries", () =>
      withLog(() =>
        Effect.gen(function* () {
          yield* connected();
          yield* record(welcome);
          yield* record(heard("PING :token", ":irc.example PONG irc.example :lag-1"));

          assert.lengthOf(yield* allActivity, 2);
        })
      )
    );

    it.effect("HOST-2: a cut Line, or one that does not parse, derives nothing", () =>
      withLog(() =>
        Effect.gen(function* () {
          yield* connected();
          yield* record(welcome);
          yield* record([
            ...heard("", ":only-a-source"),
            {
              _tag: "Line",
              bytes: encoder.encode(":bob!b@h PRIVMSG #iirc :cut sho"),
              connection: 1,
              cut: true,
              direction: "inbound",
              network,
            },
          ]);

          assert.lengthOf(yield* allActivity, 2);
          assert.deepStrictEqual(yield* allMessages, []);
        })
      )
    );
  });

  describe("partners", () => {
    it("KNOW-8: are bounded by generations, forgetting the oldest whole", () => {
      let partners = Partners.empty();

      for (const index of Arr.range(0, 2 * partnersPerGeneration)) {
        partners = partners.with(`user${index}`, `user${index}`);
      }

      // The first generation filled at `partnersPerGeneration`, and the second just after.
      assert.isFalse(partners.has("user0"));
      assert.isTrue(partners.has(`user${partnersPerGeneration + 1}`));
      assert.isTrue(partners.has(`user${2 * partnersPerGeneration}`));

      // A partner already held in the newer generation changes nothing.
      const held = partners.with(`user${2 * partnersPerGeneration}`, "again");

      assert.strictEqual(held, partners);
    });

    it("KNOW-3, KNOW-8: are keyed again from their spellings under another mapping", () => {
      const partners = Partners.empty().under("ascii").with("bob[1]", "Bob[1]");

      assert.isTrue(partners.under("rfc1459").has("bob{1}"));
      assert.isFalse(partners.under("rfc1459").has("bob[1]"));
      assert.strictEqual(partners.under("ascii"), partners);
    });

    // Under `ascii`, `Bob[1]` is `bob[1]`, and under `rfc1459` it is `bob{1}`.
    const remapped = Effect.gen(function* () {
      yield* connected();
      yield* record([
        ...heard(
          ":irc.example 001 alice :Welcome",
          ":irc.example 005 alice CASEMAPPING=ascii :are supported",
          ":Bob[1]!b@h PRIVMSG alice :hi",
          ":Carol[2]!c@h PRIVMSG alice :hi"
        ),
      ]);
      // Mid-Session, the mapping changes.
      yield* record(
        heard(":irc.example 005 alice CASEMAPPING=rfc1459 :are supported", ":Bob[1]!b@h QUIT :bye")
      );
      // A new Session, under the default mapping until its `005` says otherwise.
      yield* connected();
      yield* record(heard(":irc.example 001 alice :Welcome back", ":CAROL{2}!c@h QUIT :bye"));
    });

    it.effect("KNOW-3, KNOW-8: a partner is found when the mapping in force changes", () =>
      withLog((dataDir) =>
        Effect.gen(function* () {
          yield* remapped;

          const live = yield* derived;
          const quits = live.activity.filter(({ details }) => details.kind === "quit");

          assert.deepStrictEqual(quits.map(shownActivity), [
            'user Bob[1]: quit by Bob[1] {"reason":"bye"}',
            'user CAROL{2}: quit by CAROL{2} {"reason":"bye"}',
          ]);
          assert.deepStrictEqual(
            quits.map(({ place }) => place),
            [
              { _tag: "User", key: "bob{1}", name: "Bob[1]" },
              { _tag: "User", key: "carol{2}", name: "CAROL{2}" },
            ]
          );

          // LOG-10: a rebuild keys them again just as the live fold did.
          yield* execute(dataDir, "DELETE FROM activity");
          yield* rebuild;

          assert.deepStrictEqual(yield* derived, live);
        })
      )
    );
  });
});
