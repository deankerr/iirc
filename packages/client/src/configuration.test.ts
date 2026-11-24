import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { credentialsOf, IrcdAddress, Login, NetworkConfiguration } from "./configuration.ts";

const decode = Schema.decodeUnknownResult(IrcdAddress);

describe("an Ircd's address", () => {
  it.each([1, 65_535])("takes port %d", (port) => {
    expect(Result.isSuccess(decode({ host: "irc.test", port, tls: true }))).toBeTruthy();
  });

  it.each([0, 65_536, 6667.5])("refuses port %d", (port) => {
    expect(Result.isFailure(decode({ host: "irc.test", port, tls: true }))).toBeTruthy();
  });

  it("refuses an empty host", () => {
    expect(Result.isFailure(decode({ host: "", port: 6697, tls: true }))).toBeTruthy();
  });
});

describe("highlight words", () => {
  const old = {
    channels: [],
    declined: [],
    enabled: true,
    fallbackEncoding: "windows-1252",
    login: { _tag: "None" },
    nicks: ["iirc"],
    realname: "iirc",
    servers: [{ host: "irc.test", port: 6697, tls: true }],
    username: "iirc",
  };

  it("decode as none from a Configuration written before they existed", () => {
    const decoded = Schema.decodeUnknownSync(NetworkConfiguration)(old);

    expect(decoded.highlights).toStrictEqual([]);
  });
});

describe("ignore masks", () => {
  const old = {
    channels: [],
    declined: [],
    enabled: true,
    fallbackEncoding: "windows-1252",
    login: { _tag: "None" },
    nicks: ["iirc"],
    realname: "iirc",
    servers: [{ host: "irc.test", port: 6697, tls: true }],
    username: "iirc",
  };

  it("decode as none from a Configuration written before they existed", () => {
    expect(Schema.decodeUnknownSync(NetworkConfiguration)(old).ignores).toStrictEqual([]);
  });

  const takes = (ignores: readonly string[]) =>
    Result.isSuccess(Schema.decodeUnknownResult(NetworkConfiguration)({ ...old, ignores }));

  it("are each a mask", () => {
    expect(takes(["spam"])).toBeFalsy();
  });
});

describe("answering CTCP", () => {
  const old = {
    channels: [],
    declined: [],
    enabled: true,
    fallbackEncoding: "windows-1252",
    login: { _tag: "None" },
    nicks: ["iirc"],
    realname: "iirc",
    servers: [{ host: "irc.test", port: 6697, tls: true }],
    username: "iirc",
  };

  it("decodes as off from a Configuration written before it existed, which answered nothing", () => {
    const decode = Schema.decodeUnknownSync(NetworkConfiguration);

    expect([
      decode(old).answerCtcp,
      decode({ ...old, answerCtcp: true }).answerCtcp,
      decode({ ...old, answerCtcp: false }).answerCtcp,
    ]).toStrictEqual([false, true, false]);
  });

  it("starts on for a new Network", () => {
    expect(NetworkConfiguration.fields.answerCtcp.ast.annotations).toMatchObject({ default: true });
  });
});

describe("a SASL login's mechanism", () => {
  const old = { _tag: "Sasl", account: "iirc", password: "sasl", required: true };

  it("decodes as plain from a Configuration written before it existed, which logged in with PLAIN", () => {
    const decode = Schema.decodeUnknownSync(Login);

    expect([
      decode(old),
      decode({ ...old, mechanism: "auto" }),
      decode({ ...old, mechanism: "scram-sha-256" }),
    ]).toMatchObject([
      { mechanism: "plain" },
      { mechanism: "auto" },
      { mechanism: "scram-sha-256" },
    ]);
  });

  it("starts as auto for a new Network", () => {
    expect(Login.cases.Sasl.fields.mechanism.ast.annotations).toMatchObject({ default: "auto" });
  });
});

describe("asking who is in each Channel on joining it", () => {
  const old = {
    channels: [],
    declined: [],
    enabled: true,
    fallbackEncoding: "windows-1252",
    login: { _tag: "None" },
    nicks: ["iirc"],
    realname: "iirc",
    servers: [{ host: "irc.test", port: 6697, tls: true }],
    username: "iirc",
  };

  it("decodes as off from a Configuration written before it existed, which asked nothing", () => {
    const decode = Schema.decodeUnknownSync(NetworkConfiguration);

    expect([
      decode(old).whoOnJoin,
      decode({ ...old, whoOnJoin: true }).whoOnJoin,
      decode({ ...old, whoOnJoin: false }).whoOnJoin,
    ]).toStrictEqual([false, true, false]);
  });

  it("starts on for a new Network", () => {
    expect(NetworkConfiguration.fields.whoOnJoin.ast.annotations).toMatchObject({ default: true });
  });
});

describe("a client certificate", () => {
  const old = {
    channels: [],
    declined: [],
    enabled: true,
    fallbackEncoding: "windows-1252",
    login: { _tag: "None" },
    nicks: ["iirc"],
    realname: "iirc",
    servers: [{ host: "irc.test", port: 6697, tls: true }],
    username: "iirc",
  };

  const external = { _tag: "External", required: false };
  const certificate = { _tag: "Certificate", certificate: "cert" };

  const takes = (overrides: { readonly login: unknown; readonly tls?: unknown }) =>
    Result.isSuccess(Schema.decodeUnknownResult(NetworkConfiguration)({ ...old, ...overrides }));

  it("decodes as none from a Configuration written before it existed", () => {
    expect(Schema.decodeUnknownSync(NetworkConfiguration)(old).tls).toStrictEqual({
      _tag: "None",
    });
  });

  it("is needed by an External login, which is refused without it", () => {
    expect([
      takes({ login: external }),
      takes({ login: external, tls: { _tag: "None" } }),
      takes({ login: external, tls: certificate }),
      takes({ login: { _tag: "None" }, tls: certificate }),
    ]).toStrictEqual([false, false, true, true]);
  });
});

describe("the Credentials a Configuration names", () => {
  it("include a client certificate's, and an External login names none of its own", () => {
    const configuration = Schema.decodeSync(NetworkConfiguration)({
      channels: [],
      declined: [],
      enabled: true,
      fallbackEncoding: "windows-1252",
      login: { _tag: "External", required: true },
      nicks: ["iirc"],
      realname: "iirc",
      servers: [{ host: "irc.test", port: 6697, tls: true }],
      tls: { _tag: "Certificate", certificate: "cert" },
      username: "iirc",
    });

    expect(credentialsOf(configuration)).toStrictEqual(new Set(["cert"]));
  });

  it("include an operator login's", () => {
    const configuration = Schema.decodeSync(NetworkConfiguration)({
      channels: [],
      declined: [],
      enabled: true,
      fallbackEncoding: "windows-1252",
      login: { _tag: "None" },
      nicks: ["iirc"],
      oper: { _tag: "Login", name: "admin", password: "operpw" },
      realname: "iirc",
      servers: [{ host: "irc.test", port: 6697, tls: true }],
      username: "iirc",
    });

    expect(credentialsOf(configuration)).toStrictEqual(new Set(["operpw"]));
  });

  it("are its password, its SASL login's, and each Channel's key, once each", () => {
    const configuration = Schema.decodeSync(NetworkConfiguration)({
      channels: [{ name: "#a" }, { key: "shared", name: "#b" }, { key: "shared", name: "#c" }],
      declined: [],
      enabled: true,
      fallbackEncoding: "windows-1252",
      login: {
        _tag: "Sasl",
        account: "iirc",
        mechanism: "auto",
        password: "sasl",
        required: false,
      },
      nicks: ["iirc"],
      password: "pass",
      realname: "iirc",
      servers: [{ host: "irc.test", port: 6697, tls: true }],
      username: "iirc",
    });

    expect(credentialsOf(configuration)).toStrictEqual(new Set(["pass", "sasl", "shared"]));
  });

  it("include a service login's", () => {
    const configuration = Schema.decodeSync(NetworkConfiguration)({
      channels: [],
      declined: [],
      enabled: true,
      fallbackEncoding: "windows-1252",
      login: {
        _tag: "Service",
        account: "iirc",
        password: "nickserv",
        service: "NickServ",
        wait: 5,
      },
      nicks: ["iirc"],
      realname: "iirc",
      servers: [{ host: "irc.test", port: 6697, tls: true }],
      username: "iirc",
    });

    expect(credentialsOf(configuration)).toStrictEqual(new Set(["nickserv"]));
  });
});

const serviceLogin = (service: string, account = "acct") => ({
  channels: [],
  declined: [],
  enabled: true,
  fallbackEncoding: "windows-1252",
  login: { _tag: "Service", account, password: "pw", service, wait: 5 },
  nicks: ["iirc"],
  realname: "iirc",
  servers: [{ host: "irc.test", port: 6697, tls: true }],
  username: "iirc",
});

const takesLogin = (service: string, account?: string) =>
  Result.isSuccess(
    Schema.decodeUnknownResult(NetworkConfiguration)(serviceLogin(service, account))
  );

describe("a service login", () => {
  it("takes a service by its nick, or nick@server", () => {
    expect([takesLogin("NickServ"), takesLogin("NickServ@services.libera.chat")]).toStrictEqual([
      true,
      true,
    ]);
  });

  it("refuses a Channel as the service, which is no User", () => {
    expect(takesLogin("#staff")).toBeFalsy();
  });

  it("refuses an account that is not one word", () => {
    expect(takesLogin("NickServ", "a b")).toBeFalsy();
  });

  it("keeps an account it was given, and takes one with none", () => {
    const { login } = serviceLogin("NickServ");
    const { account: _account, ...alone } = login;

    const decoded = [login, alone].map(
      (given) =>
        Schema.decodeUnknownSync(NetworkConfiguration)({
          ...serviceLogin("NickServ"),
          login: given,
        }).login
    );

    expect(decoded).toStrictEqual([login, alone]);
  });
});
