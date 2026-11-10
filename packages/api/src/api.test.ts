import { Option, Redacted, Schema } from "effect";
import { OpenApi } from "effect/http-api";
import { describe, expect, it } from "vitest";

import { DaemonApi, requestParseOptions } from "./api.ts";
import { CallerIntent, NetworkId, NewsEvent, SayRequest, SignInRequest } from "./schemas.ts";

const document = OpenApi.fromApi(DaemonApi);

describe("the contract", () => {
  it("puts every route under /api, and every one but signing in and out behind a key or a sign-in", () => {
    const routes = Object.entries(document.paths).flatMap(([path, operations]) =>
      (["get", "put", "post", "delete"] as const).flatMap((method) => {
        const operation = operations[method];

        return operation === undefined
          ? []
          : [{ route: `${method.toUpperCase()} ${path}`, security: operation.security }];
      })
    );

    const guarded = routes.filter(({ route }) => !route.endsWith(" /api/sign-in"));

    expect(routes.map(({ route }) => route).toSorted()).toStrictEqual([
      "DELETE /api/credentials/{name}",
      "DELETE /api/sign-in",
      "GET /api/credentials",
      "GET /api/networks",
      "GET /api/networks/{network}/inspect",
      "GET /api/networks/{network}/known",
      "GET /api/networks/{network}/said/{intent}",
      "GET /api/news",
      "POST /api/networks/{network}/retry",
      "POST /api/networks/{network}/say",
      "POST /api/sign-in",
      "PUT /api/credentials/{name}",
      "PUT /api/networks/{network}",
    ]);
    expect(new Set(guarded.map(({ security }) => JSON.stringify(security)))).toStrictEqual(
      new Set(['[{"bearer":[]},{"signIn":[]}]'])
    );
    expect(
      routes.filter(({ route }) => route.endsWith(" /api/sign-in")).map(({ security }) => security)
    ).toStrictEqual([[], []]);
    expect(document.components.securitySchemes).toStrictEqual({
      bearer: { scheme: "Bearer", type: "http" },
      signIn: { in: "cookie", name: "iirc_sign_in", type: "apiKey" },
    });
  });

  it("takes a key to sign in with, and nothing else", () => {
    const signIn = Schema.decodeUnknownOption(SignInRequest, requestParseOptions);
    const decoded = signIn({ key: "iirc_abc" });

    expect([
      decoded.pipe(Option.map(({ key }) => Redacted.value(key))),
      JSON.stringify(decoded).includes("iirc_abc"),
      signIn({ key: "" }),
      signIn({ key: "iirc_abc", remember: true }),
    ]).toStrictEqual([Option.some("iirc_abc"), false, Option.none(), Option.none()]);
  });

  it("parses ids that are safe in a path, and refuses the rest", () => {
    const network = Schema.is(NetworkId);
    const intent = Schema.is(CallerIntent);

    expect([network("libera"), network("Libera"), network("../x"), network("")]).toStrictEqual([
      true,
      false,
      false,
      false,
    ]);
    expect([
      intent("a1.b_c~d-e"),
      intent("..."),
      intent("a/b"),
      intent("a".repeat(129)),
      intent("."),
      intent(".."),
    ]).toStrictEqual([true, true, false, false, false, false]);
  });

  it("refuses to say text no Line can carry", () => {
    const say = Schema.is(SayRequest);

    expect([
      say({ kind: "Privmsg", target: "#iirc", text: "fine" }),
      say({ kind: "Privmsg", target: "#iirc", text: "two\r\nlines" }),
      say({ kind: "Privmsg", target: "", text: "no target" }),
    ]).toStrictEqual([true, false, false]);
  });

  it("carries a step's sequence as its event id, and a heartbeat with none", () => {
    const wire = [
      { data: '{"at":1,"network":"libera","news":[],"sequence":7}', event: "happened", id: "7" },
      { data: "{}", event: "heartbeat" },
    ];

    const decoded = wire.map((event) => Schema.decodeUnknownSync(NewsEvent)(event));

    expect(
      decoded.map((event) => (event.event === "happened" ? event.id : undefined))
    ).toStrictEqual([7, undefined]);
    expect(decoded.map((event) => Schema.encodeSync(NewsEvent)(event))).toStrictEqual(wire);
  });
});
