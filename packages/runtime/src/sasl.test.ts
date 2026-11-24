/**
 * A SASL `SCRAM-SHA-256` login through the Runtime, driving the real Client against an
 * Ircd that answers with RFC 7677's test vector: what goes on the wire, what the Journal
 * holds, and that a replay of the Journal rebuilds the same Client.
 */
import { client } from "@iirc/client";
import { configured } from "@iirc/client/testing";
import { CredentialName } from "@iirc/protocol/line";
import { Effect, Random, Redacted, Schema } from "effect";
import { Base64 } from "effect/encoding";
import { describe, expect, it } from "vitest";

import { Entry, NetworkId } from "./journal.ts";
import { refold } from "./replay.ts";
import { entries, runTest, settle, startRuntime } from "./testing/harness.ts";
import type { World } from "./testing/harness.ts";

const libera = NetworkId.make("libera");
const credential = CredentialName.make("libera-password");
const text = new TextDecoder();
const b64 = (message: string) => Base64.encode(new TextEncoder().encode(message));

// RFC 7677's test vector, section 3.
const nonce = "rOprNGfwEbeRWgbNEkqO";
const clientFirst = b64(`n,,n=user,r=${nonce}`);

const serverFirst = b64(
  "r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096"
);

const proof = "dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=";

const clientFinal = b64(`c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,p=${proof}`);

const serverFinal = b64("v=6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=");
const wrongFinal = b64("v=7rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=");

// A Random that gives the bytes of RFC 7677's nonce, in order, to `nextIntBetween(0, 255)`.
const fixedRandom = (): Random.Random => {
  const decoded = Base64.decode(nonce);
  const bytes = decoded._tag === "Success" ? decoded.success : new Uint8Array();
  let next = 0;

  return {
    nextDoubleUnsafe: () => {
      const byte = bytes[next] ?? 0;

      next += 1;

      return (byte + 0.5) / 256;
    },
    nextIntUnsafe: () => 0,
  };
};

const configuration = configured({
  login: { _tag: "Sasl", account: "user", mechanism: "auto", password: credential, required: true },
  nicks: ["user"],
});

// Logs in against an Ircd that sends `final` as its server-final message, and gives what
// the Ircd heard, the Journal as JSON, what was logged, and the Client live and refolded.
const login = (world: World, final: string) =>
  Effect.gen(function* () {
    yield* world.vault.hold(credential, Redacted.make("pencil"));

    // The Runtime is made with the fixed Random, and the Network is added after, from a
    // fiber without it, as the API adds one.
    const { runtime } = yield* startRuntime(world, client, {
      pacing: { burst: 100, interval: 1 },
    }).pipe(Effect.provideService(Random.Random, fixedRandom()));

    yield* runtime.configure(libera, configuration);
    const call = yield* world.memory.ircd.accept;
    const heard: string[] = [];

    const hear = Effect.gen(function* () {
      const bytes = yield* call.heard;

      heard.push(text.decode(bytes).trimEnd());
    });

    const say = (line: string) => call.say(new TextEncoder().encode(`${line}\r\n`));

    yield* call.open;
    yield* Effect.repeat(hear, { times: 2 });
    yield* say(":irc.test CAP * LS :sasl=PLAIN,SCRAM-SHA-256");
    yield* hear;
    yield* say(":irc.test CAP user ACK :sasl");
    yield* hear;
    yield* say("AUTHENTICATE +");
    yield* hear;
    yield* say(`AUTHENTICATE ${serverFirst}`);
    yield* hear;
    yield* say(`AUTHENTICATE ${final}`);
    yield* say(":irc.test 900 user user!user@host user :You are now logged in as user");
    yield* say(":irc.test 903 user :SASL authentication successful");
    yield* hear;
    yield* hear;
    yield* settle;

    const journaled = (yield* entries(world.journal)).map((entry) =>
      Schema.encodeSync(Schema.fromJsonString(Schema.toCodecJson(Entry)))(entry)
    );

    const live = yield* runtime.inspect(libera);
    const folded = (yield* refold(client, world.journal)).get(libera);

    return {
      heard,
      journaled,
      live: live.client,
      logged: JSON.stringify(world.logged),
      refolded:
        folded?._tag === "Broken" ? undefined : client.inspect(folded?.state ?? client.initial),
    };
  });

describe("a SCRAM-SHA-256 login", () => {
  it("answers each round from the exchange, sends `+` once verified, and journals no secret", async () => {
    const result = await runTest((world) => login(world, serverFinal));

    expect(result.heard).toStrictEqual([
      "CAP LS 302",
      "NICK user",
      "USER iirc 0 * iirc",
      "CAP REQ sasl",
      "AUTHENTICATE SCRAM-SHA-256",
      `AUTHENTICATE ${clientFirst}`,
      `AUTHENTICATE ${clientFinal}`,
      "AUTHENTICATE +",
      "CAP END",
    ]);

    // The nonce comes back in the Ircd's own Lines, which are journaled as received. Nothing
    // the Runtime made or derived is journaled anywhere, nor logged.
    const made = [clientFirst, clientFinal, proof, "pencil"];

    expect(
      made.filter((secret) => result.journaled.some((entry) => entry.includes(secret)))
    ).toStrictEqual([]);
    expect(made.filter((secret) => result.logged.includes(secret))).toStrictEqual([]);
    expect(
      result.journaled.filter(
        (entry) => entry.includes(nonce) && !entry.includes('"_tag":"Received"')
      )
    ).toStrictEqual([]);
  });

  it("rebuilds the same Client from the Journal", async () => {
    const result = await runTest((world) => login(world, serverFinal));

    expect(result.refolded).toStrictEqual(result.live);
  });

  it("aborts with `AUTHENTICATE *` when the server signature differs, and gives up", async () => {
    const result = await runTest((world) => login(world, wrongFinal));

    expect(result.heard.slice(7)).toStrictEqual(["AUTHENTICATE *", "QUIT"]);
  });
});
