import { encode, isRejected } from "@iirc/protocol/line";
import type { OutboundLine, Rejected } from "@iirc/protocol/line";
import { Effect, Random, Redacted } from "effect";
import { Base64 } from "effect/encoding";
import { describe, expect, it } from "vitest";

import { clientFinal, clientFirst, maxIterations, verify } from "./scram.ts";

// RFC 7677's test vector, section 3.
const nonce = "rOprNGfwEbeRWgbNEkqO";

const serverFirst =
  "r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096";

const serverFinal = "v=6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=";

// A Random that gives the bytes of RFC 7677's nonce, in order, to `nextIntBetween(0, 255)`.
const fixedRandom = (bytes: Uint8Array): Random.Random => {
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

const decoded = Base64.decode(nonce);
const nonceBytes = decoded._tag === "Success" ? decoded.success : new Uint8Array();

const run = async <A>(effect: Effect.Effect<A>) =>
  await Effect.runPromise(Effect.provideService(effect, Random.Random, fixedRandom(nonceBytes)));

// The SASL response the `AUTHENTICATE` Lines carry, as text.
const response = (lines: readonly OutboundLine[] | Rejected): string => {
  if (isRejected(lines)) {
    return lines.reason;
  }

  const payload = lines
    .map((line) => {
      const bytes = encode(line);

      return isRejected(bytes) ? "" : new TextDecoder().decode(bytes).trim().split(" ")[1];
    })
    .join("")
    .replace(/\+$/u, "");

  const text = Base64.decodeString(payload);

  return text._tag === "Success" ? text.success : "undecodable";
};

const b64 = (text: string) => Base64.encode(new TextEncoder().encode(text));

const pencil = Redacted.make("pencil");

const first = async () => await run(clientFirst("user"));

describe("SCRAM-SHA-256", () => {
  it("answers RFC 7677's test vector, with the nonce from Effect's Random", async () => {
    const opened = await first();

    expect(opened._tag).toBe("Answered");

    if (opened._tag !== "Answered") {
      return;
    }

    const proved = await run(clientFinal(opened.exchange, pencil, b64(serverFirst)));

    expect({
      final: proved._tag === "Answered" ? response(proved.lines) : proved._tag,
      first: response(opened.lines),
      verified: proved._tag === "Answered" && verify(proved.exchange, b64(serverFinal)),
    }).toStrictEqual({
      final:
        "c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,p=dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=",
      first: "n,,n=user,r=rOprNGfwEbeRWgbNEkqO",
      verified: true,
    });
  });

  it("does not verify a server signature that differs, an error, or no exchange", async () => {
    const opened = await first();

    const proved =
      opened._tag === "Answered"
        ? await run(clientFinal(opened.exchange, pencil, b64(serverFirst)))
        : opened;

    const exchange = proved._tag === "Answered" ? proved.exchange : undefined;

    expect([
      verify(exchange, b64("v=7rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=")),
      verify(exchange, b64("e=invalid-proof")),
      verify(exchange, "not base64!"),
      verify(undefined, b64(serverFinal)),
      verify(opened._tag === "Answered" ? opened.exchange : undefined, b64(serverFinal)),
    ]).toStrictEqual([false, false, false, false, false]);
  });

  it("refuses a server-first message whose nonce does not extend ours, or that does not parse", async () => {
    const opened = await first();

    if (opened._tag !== "Answered") {
      throw new Error("no client-first message");
    }

    const refused = await Promise.all(
      [
        b64(serverFirst.replace("r=rOpr", "r=xOpr")),
        b64(serverFirst.replace("%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0", "")),
        b64("m=ext,".concat(serverFirst)),
        b64("garbage"),
        b64(serverFirst.replace(",i=4096", "")),
        b64(serverFirst.replace("s=W22ZaJ0SNY7soEsUEjb6gQ==", "s=")),
        "not base64!",
        "",
      ].map(async (challenge) => {
        const answered = await run(clientFinal(opened.exchange, pencil, challenge));

        return answered._tag;
      })
    );

    expect(new Set(refused)).toStrictEqual(new Set(["Unanswerable"]));
  });

  it("refuses an iteration count above the bound before deriving anything", async () => {
    const opened = await first();

    if (opened._tag !== "Answered") {
      throw new Error("no client-first message");
    }

    // A count this large would take hours to derive, so an answer that comes at all was refused first.
    const huge = await run(
      clientFinal(opened.exchange, pencil, b64(serverFirst.replace("i=4096", "i=4000000000")))
    );

    const above = await run(
      clientFinal(
        opened.exchange,
        pencil,
        b64(serverFirst.replace("i=4096", `i=${maxIterations + 1}`))
      )
    );

    expect([huge._tag, above._tag]).toStrictEqual(["Unanswerable", "Unanswerable"]);
  });
});
