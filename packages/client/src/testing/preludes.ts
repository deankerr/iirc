/**
 * Preludes write the common parts of a scenario, as transcript text, so a scenario
 * reads as its prelude and then what it is about. They commit to how a Client
 * registers on the floor and with caps, and the Client is held to that.
 *
 * @packageDocumentation
 */
import {
  authenticate,
  cap,
  encode,
  isRejected,
  join,
  mode,
  nick as nickLine,
  user,
} from "@iirc/protocol/line";
import type { OutboundLine, Rejected } from "@iirc/protocol/line";
import { Schema } from "effect";

import { NetworkConfiguration } from "../configuration.ts";
import { CapName } from "../ids.ts";
import { printItem } from "./transcript.ts";

/** The parts of a Configuration a scenario may set. Everything else has a default. */
export type Overrides = { readonly [K in keyof NetworkConfiguration]?: NetworkConfiguration[K] };

const decodeConfiguration = Schema.decodeUnknownSync(NetworkConfiguration);

/**
 * A base Configuration: `iirc` on `irc.test:6697` over TLS, enabled, in no Channels,
 * with no login and nothing declined. `!! configure` items change it as a scenario goes.
 * @param overrides - What to set instead.
 * @returns The Configuration, decoded, so a bad override fails here.
 */
export const configured = (overrides: Overrides = {}): NetworkConfiguration =>
  decodeConfiguration({
    channels: [],
    declined: [],
    enabled: true,
    fallbackEncoding: "windows-1252",
    ircds: [{ host: "irc.test", port: 6697, tls: true }],
    login: { _tag: "None" },
    nicks: ["iirc"],
    realname: "iirc",
    username: "iirc",
    ...overrides,
  });

/** ISUPPORT tokens a prelude sends when a scenario names none. */
export const floorIsupport: readonly string[] = [
  "CASEMAPPING=rfc1459",
  "CHANTYPES=#",
  "NETWORK=iirc-test",
  "PREFIX=(ov)@+",
];

/** What `registered` may be told. */
export interface Registration {
  /**
   * Caps the Ircd offers in `CAP LS`, with their values, such as `multi-prefix` or
   * `sasl=PLAIN`. None means the floor, which answers `CAP` with `421`.
   */
  readonly offered?: readonly string[];
  /**
   * The caps the Client is expected to `CAP REQ`, by name, which the Ircd acknowledges.
   * The real Client asks only for caps it has a Feature for, less those the Owner
   * declined. Left out, every cap offered, which keeps a simple scenario short. Empty,
   * the Client ends negotiation at once.
   */
  readonly requested?: readonly string[];
  /** ISUPPORT tokens, sent 13 to a `005`. */
  readonly isupport?: readonly string[];
  /** The Ircd's name. */
  readonly server?: string;
}

// Writes a Line the Client sends exactly as `encode` writes it, so the prelude and the
// Client agree on such things as when a trailing colon is needed.
const sent = (line: OutboundLine | Rejected): string => {
  const bytes = isRejected(line) ? line : encode(line);

  if (isRejected(bytes)) {
    throw new TypeError(`a prelude built a Line that cannot be sent: ${bytes.reason}`);
  }

  return printItem({ _tag: "Sent", bytes: bytes.subarray(0, -2) });
};

const lines = (...rows: readonly string[]): string => rows.map((row) => `${row}\n`).join("");

const chunked = (tokens: readonly string[], size: number): readonly (readonly string[])[] =>
  Array.from({ length: Math.ceil(tokens.length / size) }, (_unused, index) =>
    tokens.slice(index * size, (index + 1) * size)
  );

const capName = (cap: string): string => cap.split("=")[0] ?? cap;

const sasl = (
  configuration: NetworkConfiguration,
  requested: readonly string[],
  server: string
) => {
  const { login } = configuration;

  if (login._tag !== "Sasl" || !requested.includes("sasl")) {
    return [];
  }

  return [
    sent(authenticate("PLAIN")),
    "<< AUTHENTICATE +",
    `>> {AuthenticatePlain credential=${login.credential} authcid=${login.account} authzid=${login.account}}`,
    `<< :${server} 900 * * ${login.account} :You are now logged in as ${login.account}`,
    `<< :${server} 903 * :SASL authentication successful`,
  ];
};

/**
 * Writes a Session's start, from the first `!! configure` to the last `005`. The first
 * `Configured` dials the first Ircd at once, and the Client sends `CAP LS 302`, `PASS`
 * if it has one, `NICK` and `USER`. When the Ircd offers caps, the Client requests
 * `requested`, which the Ircd acknowledges, SASL `PLAIN` logs in when the Configuration
 * has a login and `sasl` is requested, and `CAP END` follows. When it requests
 * none, `CAP END` follows `LS` at once. When the Ircd offers none, it is the floor and answers `CAP`
 * with `421`. Then `001` to `005`.
 * @param configuration - The scenario's Configuration, which names the Ircd and Self.
 * @param registration - The caps the Ircd offers, those the Client requests, and the
 * ISUPPORT tokens the Ircd sends.
 * @returns The transcript text.
 */
export const registered = (
  configuration: NetworkConfiguration,
  { offered = [], requested, isupport = floorIsupport, server = "irc.test" }: Registration = {}
): string => {
  const [ircd] = configuration.ircds;
  const [nick] = configuration.nicks;
  const names = offered.map(capName);
  const asked = requested ?? names;
  const unoffered = asked.filter((name) => !names.includes(name));

  if (unoffered.length > 0) {
    throw new TypeError(`a prelude requests caps the Ircd does not offer: ${unoffered.join(" ")}`);
  }

  const request =
    asked.length === 0
      ? []
      : [
          sent(cap("REQ", asked.join(" "))),
          `<< :${server} CAP * ACK :${asked.join(" ")}`,
          ...sasl(configuration, asked, server),
        ];

  const negotiation =
    offered.length === 0
      ? [`<< :${server} 421 * CAP :Unknown command`]
      : [`<< :${server} CAP * LS :${offered.join(" ")}`, ...request, sent(cap("END"))];

  return lines(
    "!! configure",
    `-> dial ${ircd.host}:${ircd.port}${ircd.tls ? " tls" : ""}`,
    "== opened",
    sent(cap("LS", "302")),
    ...(configuration.password === undefined
      ? []
      : [`>> {Pass credential=${configuration.password}}`]),
    sent(nickLine(nick)),
    sent(user(configuration.username, configuration.realname)),
    ...negotiation,
    `<< :${server} 001 ${nick} :Welcome to the iirc-test Network ${nick}`,
    `<< :${server} 002 ${nick} :Your host is ${server}, running version test-1`,
    `<< :${server} 003 ${nick} :This server was created at the epoch`,
    `<< :${server} 004 ${nick} ${server} test-1 iow beIklmnostv`,
    ...chunked(isupport, 13).map(
      (tokens) => `<< :${server} 005 ${nick} ${tokens.join(" ")} :are supported by this server`
    )
  );
};

/** What `joined` may be told. */
export interface Joining {
  /** Self's nick, if registration changed it. */
  readonly nick?: string;
  /** The Ircd's name. */
  readonly server?: string;
}

/**
 * Writes Self joining a Channel: the Owner wants it, the Client sends `JOIN`, the Ircd
 * echoes it, the Client asks its modes with `MODE`, the Ircd lists the members with `353`
 * and `366`, and then answers with `324`: `+nt`. Self is listed first, unless
 * `names` already lists it.
 * @param configuration - The scenario's Configuration, which names Self.
 * @param channel - The Channel, such as `#iirc`.
 * @param names - The other members, with their prefixes, such as `@peer`.
 * @param joining - Self's nick and the Ircd's name, if not the defaults.
 * @returns The transcript text.
 */
export const joined = (
  configuration: NetworkConfiguration,
  channel: string,
  names: readonly string[] = [],
  { nick = configuration.nicks[0], server = "irc.test" }: Joining = {}
): string => {
  const listed = names.some((name) => name.replace(/^[^A-Za-z[\]\\`_^{|}]+/u, "") === nick)
    ? names
    : [nick, ...names];

  return lines(
    `!! configure +${channel}`,
    sent(join([channel])),
    `<< :${nick}!~${configuration.username}@iirc.test JOIN ${channel}`,
    sent(mode(channel)),
    `<< :${server} 353 ${nick} = ${channel} :${listed.join(" ")}`,
    `<< :${server} 366 ${nick} ${channel} :End of /NAMES list.`,
    `<< :${server} 324 ${nick} ${channel} +nt`
  );
};

/**
 * The sets of caps to run one scenario across: none, each cap alone, and every pair.
 * Each set is in the order given.
 * @param caps - The caps under test.
 * @returns The sets, smallest first.
 */
export const across = (caps: readonly string[]): readonly (readonly CapName[])[] => {
  const named = [...new Set(caps)].map((cap) => CapName.make(cap));

  const pairs = named.flatMap((first, index) =>
    named.slice(index + 1).map((second) => [first, second])
  );

  return [[], ...named.map((cap) => [cap]), ...pairs];
};
