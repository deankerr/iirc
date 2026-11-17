import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { credentialsOf, IrcdAddress, NetworkConfiguration } from "./configuration.ts";

const decode = Schema.decodeUnknownResult(IrcdAddress);

describe("an Ircd's address", () => {
  it.each([1, 6667, 6697, 65_535])("takes port %d", (port) => {
    expect(Result.isSuccess(decode({ host: "irc.test", port, tls: true }))).toBeTruthy();
  });

  it.each([0, -1, 65_536, 6667.5])("refuses port %d", (port) => {
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
    ircds: [{ host: "irc.test", port: 6697, tls: true }],
    login: { _tag: "None" },
    nicks: ["iirc"],
    realname: "iirc",
    username: "iirc",
  };

  it("decode as none from a Configuration written before they existed", () => {
    const decoded = Schema.decodeUnknownSync(NetworkConfiguration)(old);

    expect(decoded.highlights).toStrictEqual([]);
  });

  it("are kept, and encoded as given", () => {
    const decoded = Schema.decodeUnknownSync(NetworkConfiguration)({
      ...old,
      highlights: ["iirc", "release"],
    });

    expect(decoded.highlights).toStrictEqual(["iirc", "release"]);
    expect(Schema.encodeSync(NetworkConfiguration)(decoded)).toMatchObject({
      highlights: ["iirc", "release"],
    });
  });

  const takes = (highlights: readonly string[]) =>
    Result.isSuccess(Schema.decodeUnknownResult(NetworkConfiguration)({ ...old, highlights }));

  it("are at most 64, of at most 64 characters each", () => {
    expect([
      takes(Array.from({ length: 64 }, () => "x".repeat(64))),
      takes(Array.from({ length: 65 }, () => "x")),
      takes(["x".repeat(65)]),
    ]).toStrictEqual([true, false, false]);
  });
});

describe("ignore masks", () => {
  const old = {
    channels: [],
    declined: [],
    enabled: true,
    fallbackEncoding: "windows-1252",
    ircds: [{ host: "irc.test", port: 6697, tls: true }],
    login: { _tag: "None" },
    nicks: ["iirc"],
    realname: "iirc",
    username: "iirc",
  };

  it("decode as none from a Configuration written before they existed", () => {
    expect(Schema.decodeUnknownSync(NetworkConfiguration)(old).ignores).toStrictEqual([]);
  });

  it("are kept, and encoded as given", () => {
    const decoded = Schema.decodeUnknownSync(NetworkConfiguration)({
      ...old,
      ignores: ["spam!*@*", "*!*@bad.test"],
    });

    expect(decoded.ignores).toStrictEqual(["spam!*@*", "*!*@bad.test"]);
    expect(Schema.encodeSync(NetworkConfiguration)(decoded)).toMatchObject({
      ignores: ["spam!*@*", "*!*@bad.test"],
    });
  });

  const takes = (ignores: readonly string[]) =>
    Result.isSuccess(Schema.decodeUnknownResult(NetworkConfiguration)({ ...old, ignores }));

  it("are at most 64, and each a mask", () => {
    expect([
      takes(Array.from({ length: 64 }, () => "x!*@*")),
      takes(Array.from({ length: 65 }, () => "x!*@*")),
      takes(["spam"]),
    ]).toStrictEqual([true, false, false]);
  });
});

describe("answering CTCP", () => {
  const old = {
    channels: [],
    declined: [],
    enabled: true,
    fallbackEncoding: "windows-1252",
    ircds: [{ host: "irc.test", port: 6697, tls: true }],
    login: { _tag: "None" },
    nicks: ["iirc"],
    realname: "iirc",
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

describe("asking who is in each Channel on joining it", () => {
  const old = {
    channels: [],
    declined: [],
    enabled: true,
    fallbackEncoding: "windows-1252",
    ircds: [{ host: "irc.test", port: 6697, tls: true }],
    login: { _tag: "None" },
    nicks: ["iirc"],
    realname: "iirc",
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

describe("the Credentials a Configuration names", () => {
  it("include an operator login's", () => {
    const configuration = Schema.decodeSync(NetworkConfiguration)({
      channels: [],
      declined: [],
      enabled: true,
      fallbackEncoding: "windows-1252",
      ircds: [{ host: "irc.test", port: 6697, tls: true }],
      login: { _tag: "None" },
      nicks: ["iirc"],
      oper: { _tag: "Login", credential: "operpw", name: "admin" },
      realname: "iirc",
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
      ircds: [{ host: "irc.test", port: 6697, tls: true }],
      login: { _tag: "Sasl", account: "iirc", credential: "sasl", required: false },
      nicks: ["iirc"],
      password: "pass",
      realname: "iirc",
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
      ircds: [{ host: "irc.test", port: 6697, tls: true }],
      login: {
        _tag: "Service",
        account: "iirc",
        credential: "nickserv",
        service: "NickServ",
        wait: 5,
      },
      nicks: ["iirc"],
      realname: "iirc",
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
  ircds: [{ host: "irc.test", port: 6697, tls: true }],
  login: { _tag: "Service", account, credential: "pw", service, wait: 5 },
  nicks: ["iirc"],
  realname: "iirc",
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

  it.each(["@#staff", "%#staff", "~#staff", "+#staff", "#staff", "&local", "$*", "a,b", "a b", ""])(
    "refuses %j as the service, which is no User",
    (service) => {
      expect(takesLogin(service)).toBeFalsy();
    }
  );

  it.each(["acct\twrong", "a b", "a b", "a　b", ""])(
    "refuses %j as the account, which is not one word",
    (account) => {
      expect(takesLogin("NickServ", account)).toBeFalsy();
    }
  );
});
