/**
 * What the web frontend's tests share: a fake Daemon at the `fetch` level, a registry whose
 * runtime reaches it, and ways to wait on a command and to look for a secret.
 *
 * @packageDocumentation
 */
import { ConfigurationInForce, UiOptionName, UiOptions, uiDefaults } from "@iirc/api";
import type {
  ChannelHeader,
  Knowledge,
  Member,
  MemberPage,
  Located,
  NetworkEntry,
  Timeline,
  TimelineChangesEvent,
  TimelineItem,
  TimelineList,
  SearchResults,
  TimelineWindow,
  WindowGap,
  UiInForce,
} from "@iirc/api";
import { importTheme } from "@iirc/frontend/theme-import";
import { Effect, Layer, Redacted, Result, Schema } from "effect";
import { Base64Url } from "effect/encoding";
import { FetchHttpClient } from "effect/http";
import { AtomRegistry } from "effect/reactivity";
import type { Atom } from "effect/reactivity";

import { layerDaemonClient } from "../app/daemon-client.ts";
import { runtime } from "../app/runtime.ts";
import { IntentNames } from "../composer/atoms.ts";
import { Notifier } from "../notifications/notifier.ts";
import type { NotifierPort } from "../notifications/notifier.ts";
import { writeChoice } from "../page/device.ts";
import { ThemeReader } from "../theme/reader.ts";
import type { ThemeReaderPort } from "../theme/reader.ts";
import { layoutKey, Waits } from "../timelines/atoms.ts";
import type { WaitTimes } from "../timelines/atoms.ts";
import { testNotifier } from "./notifier.ts";

/** A reader of themes that reads in the page at once, as no Worker runs in happy-dom. */
export const instantThemeReader: ThemeReaderPort = {
  read: (text) => Effect.sync(() => importTheme(text)),
};

export const theKey = "iirc_the-key";

/** What the Daemon answers with, as the wire carries it. */
type Answer =
  | Readonly<Record<string, string>>
  | (typeof NetworkEntry.Encoded)[]
  | typeof Knowledge.Encoded
  | typeof TimelineList.Encoded
  | typeof TimelineWindow.Encoded
  | typeof Located.Encoded
  | typeof ChannelHeader.Encoded
  | typeof MemberPage.Encoded
  | { readonly _tag: "NotInChannel"; readonly standing: string | null; readonly timeline: string }
  | { readonly _tag: "Said"; readonly intent: string; readonly sequence: number }
  | {
      readonly _tag: "Refused";
      readonly intent: string;
      readonly sequence: number;
      readonly reason: { readonly _tag: "Offline" | "Unsendable" };
    }
  | { readonly _tag: "Journaled"; readonly sequence: number }
  | typeof ConfigurationInForce.Encoded
  | { readonly sequence: number }
  | { readonly names: readonly string[] }
  | {
      readonly _tag: "ConfigurationChanged";
      readonly network: string;
      readonly sequence: number | null;
    }
  | { readonly _tag: "UnknownNetwork"; readonly network: string }
  | typeof UiInForce.Encoded
  | { readonly _tag: "UiChanged"; readonly sequence: number };

const json = (status: number, body: Answer) => Response.json(body, { status });

/** A Channel the fake holds behind a Channel Timeline: its head, and its members in rank order. */
export interface FakeChannel {
  header: typeof ChannelHeader.Encoded;
  members: (typeof Member.Encoded)[];
}

/**
 * Text in lower case, as the fake compares nicks.
 * @param text - The text.
 * @returns It, in lower case.
 */
const lower = (text: string) => text.toLowerCase();

/**
 * A page of a Channel's members, as the Daemon would give it: those after `after`, whose
 * nick starts with `prefix` in any ASCII case, up to `limit`, with where the next begins.
 * @param held - The Channel.
 * @param query - The query.
 * @param timeline - The Timeline it was read by.
 * @returns The page.
 */
const membersOf = (
  held: FakeChannel,
  query: URLSearchParams,
  timeline: string
): typeof MemberPage.Encoded => {
  const prefix = lower(query.get("prefix") ?? "");
  const limit = Number(query.get("limit") ?? "100");
  const after = query.get("after");

  const afterKey =
    after === null
      ? undefined
      : Result.getOrUndefined(Base64Url.decodeString(after.slice(after.indexOf(".") + 1)));

  const matching = held.members.filter((member) => lower(member.nick).startsWith(prefix));

  const from =
    afterKey === undefined
      ? 0
      : matching.findIndex((member) => lower(member.nick) === afterKey) + 1;

  const members = matching.slice(from, from + limit);
  const last = members.at(-1);
  const more = from + limit < matching.length;

  return {
    members,
    more,
    network: held.header.network,
    next: more && last !== undefined ? `0.${Base64Url.encode(lower(last.nick))}` : null,
    timeline,
  };
};

/** A Timeline the fake holds: its description, and its items in position order. */
export interface FakeTimeline {
  readonly timeline: typeof Timeline.Encoded;
  items: (typeof TimelineItem.Encoded)[];
  gaps: (typeof WindowGap.Encoded)[];
}

/** One follower of the changes stream: where it asked to follow from, and its stream. */
interface Follower {
  readonly after: string | undefined;
  readonly lastEventId: string | undefined;
  readonly controller: ReadableStreamDefaultController<Uint8Array>;
}

const encoder = new TextEncoder();

/**
 * Its window of a Timeline, as the Daemon would give it: the latest, the last before a
 * cursor, the first after one, or as many from a cursor on as before it, up to a limit,
 * with every Gap it holds. A cursor compares as its position does.
 * @param held - The Timeline.
 * @param query - The query.
 * @param through - The last step folded.
 * @returns The window.
 */
const windowOf = (
  held: FakeTimeline,
  query: URLSearchParams,
  through: number
): typeof TimelineWindow.Encoded => {
  const before = query.get("before");
  const after = query.get("after");
  const around = query.get("around");
  const limit = Number(query.get("limit") ?? "100");
  const edges = { gaps: held.gaps, network: held.timeline.network, through, version: 1 };

  if (around !== null) {
    const at = held.items.findIndex((item) => item.position >= around);
    const from = Math.max(0, (at === -1 ? held.items.length : at) - Math.floor(limit / 2));
    const items = held.items.slice(from, from + limit);

    return {
      ...edges,
      earlier: from > 0,
      items,
      later: from + items.length < held.items.length,
      timeline: held.timeline.id,
    };
  }

  if (after !== null) {
    const candidates = held.items.filter((item) => item.position > after);
    const items = candidates.slice(0, limit);

    return {
      ...edges,
      earlier: true,
      items,
      later: candidates.length > items.length,
      timeline: held.timeline.id,
    };
  }

  const candidates =
    before === null ? held.items : held.items.filter((item) => item.position < before);

  const items = candidates.slice(-limit);

  return {
    earlier: candidates.length > items.length,
    gaps: held.gaps,
    items,
    later: before !== null,
    network: held.timeline.network,
    through,
    timeline: held.timeline.id,
    version: 1,
  };
};

/**
 * What the fake finds for a search, as the Daemon would: the Messages whose text holds
 * `text`, lower-cased as ASCII, which is all a test searches, kept to a Network, a
 * Timeline, and a sender when given, latest first and at one position by Timeline id, last
 * first, a page at a time from just after `after`.
 * @param timelines - Every Timeline it holds.
 * @param query - The query.
 * @param through - The last step folded.
 * @returns The page.
 */
const searchOf = (
  timelines: readonly FakeTimeline[],
  query: URLSearchParams,
  through: number
): typeof SearchResults.Encoded => {
  const text = (query.get("text") ?? "").toLowerCase();
  const from = query.get("from")?.toLowerCase();
  const network = query.get("network");
  const timeline = query.get("timeline");
  const [afterAt, afterTimeline = ""] = (query.get("after") ?? "").split(".");
  const limit = Number(query.get("limit") ?? "100");

  const found = timelines
    .filter(
      (held) =>
        (network === null || held.timeline.network === network) &&
        (timeline === null || held.timeline.id === timeline)
    )
    .flatMap((held) => held.items)
    .filter(
      (item) =>
        item.content._tag === "Message" &&
        item.content.text.toLowerCase().includes(text) &&
        (from === undefined || item.content.sender.toLowerCase() === from)
    )
    .toSorted(
      (left, right) =>
        right.position.localeCompare(left.position) || right.timeline.localeCompare(left.timeline)
    )
    .filter(
      (item) =>
        afterAt === undefined ||
        afterAt === "" ||
        item.position < afterAt ||
        (item.position === afterAt && item.timeline < afterTimeline)
    );

  const items = found.slice(0, limit);
  const last = items.at(-1);
  const more = found.length > items.length;

  return {
    items,
    more,
    next: more && last !== undefined ? `${last.position}.${last.timeline}` : null,
    through,
    version: 1,
  };
};

const SignInBody = Schema.fromJsonString(Schema.Struct({ key: Schema.String }));

const ActBody = Schema.fromJsonString(
  Schema.Struct({ action: Schema.Unknown, intent: Schema.String })
);

const SayBody = Schema.fromJsonString(
  Schema.Struct({
    intent: Schema.String,
    kind: Schema.String,
    target: Schema.String,
    text: Schema.String,
  })
);

/** A Network's Configuration, as the wire carries it. */
type ConfigurationOnWire = (typeof ConfigurationInForce.Encoded)["configuration"];

const ConfigurationBody = Schema.fromJsonString(
  Schema.toEncoded(ConfigurationInForce.fields.configuration)
);

const CredentialBody = Schema.fromJsonString(Schema.Struct({ value: Schema.String }));

/** The `ui` options before any Change: each at its default. */
const noUiChange: typeof UiInForce.Encoded = { options: uiDefaults, sequence: 0 };

/** A value for one `ui` option, as the fake takes it: whatever the options' Schema does. */
const UiBody = Schema.fromJsonString(Schema.Struct({ value: Schema.Json }));

const ReadBody = Schema.fromJsonString(
  Schema.Struct({ read: Schema.Finite, target: Schema.NullOr(Schema.String) })
);

/** The Configuration the fake's Network `libera` starts with. */
export const liberaConfiguration: ConfigurationOnWire = {
  channels: [{ name: "#iirc" }],
  declined: [],
  enabled: true,
  fallbackEncoding: "windows-1252",
  highlights: [],
  ircds: [{ host: "irc.libera.chat", port: 6697, tls: true }],
  login: { _tag: "None" },
  nicks: ["iirc"],
  realname: "iirc",
  username: "iirc",
};

/** A `say` the fake was asked for, as its body said it. */
type SaidToFake = typeof SayBody.Type;

/**
 * How the fake answers a `say`: journaled at the next step, said or refused there as
 * `Offline`, one of the API's errors, no answer and never journaled (`Down`), or no answer
 * and journaled late, only after the next `said` has answered (`Lost`).
 */
type SayAnswer =
  | "Said"
  | "Offline"
  | "NetworkStopped"
  | "NetworkStoppedJournaled"
  | "UnknownNetwork"
  | "Down"
  | "Lost";

/**
 * Whether a redacted value still holds its value.
 * @param redacted - The value.
 * @returns `false` once it was wiped.
 */
export const hasValue = (redacted: Redacted.Redacted<unknown>) => {
  try {
    Redacted.value(redacted);

    return true;
  } catch {
    return false;
  }
};

/**
 * A Daemon's sign-in routes and Network list as the wire carries them, with one key and
 * the one cookie a browser would hold. It can be down, answer through a gateway that
 * cannot reach it, or fail to write its sign-ins.
 * @returns What the fake holds, which a test may change, and its `fetch`.
 */
export const fakeDaemon = () => {
  const keysSent: string[] = [];

  const followers: Follower[] = [];
  const says: SaidToFake[] = [];
  const acts: (typeof ActBody.Type)[] = [];
  const journaled = new Map<string, number>();
  const answers: SayAnswer[] = [];
  const late: string[] = [];
  const locatesRead: number[] = [];
  const locatesHeld: (() => void)[] = [];
  const windowsRead: string[] = [];
  const searchesRead: string[] = [];
  const hung: string[] = [];
  const networksHeld: (() => void)[] = [];
  const puts: { readonly network: string; readonly ifSequence: string | null }[] = [];
  const reads: (typeof ReadBody.Type)[] = [];
  const channelsRead: string[] = [];
  const channelsHeld: (() => void)[] = [];
  const membersHeld: (() => void)[] = [];
  const knownHeld: (() => void)[] = [];
  const membersRead: string[] = [];
  const uiFollowers: Follower[] = [];
  const uiChanges: { readonly route: string; readonly ifSequence: string | null }[] = [];

  const daemon = {
    /** How many requests that never began their answer were given up. */
    abandoned: 0,
    /** Each `act` asked for, in order, refused or not, answered as `say`s are. */
    acts,
    /** Each Channel behind a Channel Timeline, by its id, which `channel` and `members` read. */
    channels: new Map<string, FakeChannel>(),
    /** Each read of a Channel's head, by its Timeline. */
    channelsRead,
    /** Each Network's Configuration in force, and the sequence that set it. */
    configurations: new Map<string, { configuration: ConfigurationOnWire; sequence: number }>([
      ["libera", { configuration: liberaConfiguration, sequence: 1 }],
    ]),
    /** The Credentials held, with their values, as a Vault would hold them. */
    credentials: new Map<string, string>(),
    down: false,
    followers,
    gatewayOnly: false,
    /** Whether a request to follow the changes never begins its answer. */
    hangChanges: false,
    /** Releases each read held: of a Channel's head, of its members, or of `known`. */
    held: { channel: channelsHeld, known: knownHeld, members: membersHeld },
    /** Whether each read of a Channel's head waits until released. */
    holdChannels: false,
    /** Whether each read of `known` waits until released. */
    holdKnown: false,
    /** Whether each `at/{sequence}` read waits until released. */
    holdLocates: false,
    /** Whether each read of a Channel's members waits until released. */
    holdMembers: false,
    /** Whether each request for the Network list waits until released. */
    holdNetworks: false,
    /** Where each request that never began its answer asked to follow from. */
    hung,
    /**
     * How many of the next `PUT`s of Configuration find that another Frontend changed the
     * Network's `realname` just before their turn.
     */
    interject: 0,
    /** Each intent journaled, and its sequence, which `said` answers from. */
    journaled,
    keysSent,
    /** What each Network's Ircd declared, as `known` gives it: none until a test says. */
    known: new Map<
      string,
      {
        readonly chantypes: string | null;
        readonly declared: (typeof Knowledge.Encoded)["declared"];
      }
    >(),
    /** Whether `known` gets no answer. */
    knownDown: false,
    /** Says whose request got no answer, journaled only after the next `said`. */
    late,
    /** How many of the next `at/{sequence}` reads get no answer. */
    locateFailures: 0,
    /** Releases each `at/{sequence}` read held, in the order they came. */
    locatesHeld,
    /** Each `at/{sequence}` read, by its sequence, failed or held ones included. */
    locatesRead,
    /** Each read of a Channel's members, by its query. */
    membersRead,
    /** Releases each request for the Network list held, in the order they came. */
    networksHeld,
    /** The sequence the next `say` is journaled at. */
    nextSequence: 10,
    /** The items each step placed, which `at/{sequence}` answers with. */
    placed: new Map<number, (typeof TimelineItem.Encoded)[]>(),
    /** Each `PUT` of Configuration, with the sequence it was made from. */
    puts,
    /** How many of the next marks read get no answer. */
    readFailures: 0,
    /** Each Timeline marked read, as its body said it, in order. */
    reads,
    /** Whether `said` answers at all. */
    saidDown: false,
    /** How the next `say`s are answered, first to last; past them, each is said. */
    sayAnswers: answers,
    /** Each `say` asked for, in order, refused or not. */
    says,
    /** Each page of a search read, by its query, for a test to look at. */
    searchesRead,
    /** Self on each Network, as `known` gives it: none until a test says. */
    selves: new Map<string, (typeof Knowledge.Encoded)["self"]>(),
    /** Each Network's connection, as `known` gives it. */
    sessions: new Map<string, (typeof Knowledge.Encoded)["session"]>([
      ["libera", { _tag: "Registered", ircd: "ircd.test", since: 1 }],
    ]),
    signInsFail: false,
    signedIn: false,
    /** The last step folded, which every Timeline read gives as `through`. */
    through: 1,
    /** The Timelines of each Network, in the order they opened. */
    timelines: new Map<string, FakeTimeline[]>([["libera", []]]),
    /** The `ui` options in force, as the wire carries them, and the sequence of the last Change. */
    ui: noUiChange,
    /** Each change of a `ui` option asked for, as `PUT` or `DELETE` and its option, and its `ifSequence`. */
    uiChanges,
    /** Each follower of the `ui` options. */
    uiFollowers,
    /** Each read of a window, by its query, for a test to look at. */
    windowsRead,
  };

  /**
   * A stream of Server-Sent Events, kept in a list of followers while it is open.
   * @param list - The followers.
   * @param url - The request's URL.
   * @param headers - Its headers.
   * @param init - The request.
   * @returns The response.
   */
  const following = (list: Follower[], url: URL, headers: Headers, init: RequestInit) => {
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const follower = {
          after: url.searchParams.get("after") ?? undefined,
          controller,
          lastEventId: headers.get("last-event-id") ?? undefined,
        };

        list.push(follower);

        // A follower that stops following is gone, as its connection would be.
        init.signal?.addEventListener("abort", () => {
          list.splice(list.indexOf(follower), 1);
        });
      },
    });

    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  };

  /**
   * Sends one event to every follower of the changes stream.
   * @param sent - The event, as the wire carries it.
   */
  const send = (sent: typeof TimelineChangesEvent.Encoded) => {
    const id = "id" in sent ? `id: ${sent.id}\n` : "";
    const text = `event: ${sent.event}\n${id}data: ${sent.data}\n\n`;

    for (const follower of followers) {
      follower.controller.enqueue(encoder.encode(text));
    }
  };

  /** Ends every follower's stream, as a Daemon that restarts does. */
  const endStreams = () => {
    for (const follower of followers.splice(0)) {
      follower.controller.close();
    }
  };

  const signedInOnly = (answer: () => Response) =>
    daemon.signedIn ? answer() : json(401, { _tag: "Unauthorized" });

  /**
   * `said`, and the items a step placed, or nothing for any other route.
   * @param url - The request's URL.
   * @returns The answer, or nothing.
   */
  const stepRoute = (url: URL): Response | undefined => {
    const said = /^\/api\/networks\/(?<network>[^/]+)\/said\/(?<intent>[^/]+)$/u.exec(
      url.pathname
    )?.groups;

    if (said?.intent !== undefined) {
      const { intent } = said;
      const sequence = daemon.journaled.get(intent);

      if (daemon.saidDown) {
        throw new TypeError("fetch failed");
      }

      // A request that got no answer was still appending, and commits only now, after
      // this answer: the race that makes `NotJournaled` unknown after a lost response.
      for (const late of daemon.late.splice(0)) {
        daemon.journaled.set(late, daemon.nextSequence);
        daemon.nextSequence += 1;
      }

      return signedInOnly(() =>
        json(
          200,
          sequence === undefined ? { _tag: "NotJournaled" } : { _tag: "Journaled", sequence }
        )
      );
    }

    const at = /^\/api\/networks\/(?<network>[^/]+)\/at\/(?<sequence>\d+)$/u.exec(
      url.pathname
    )?.groups;

    if (at?.sequence !== undefined) {
      const items = daemon.placed.get(Number(at.sequence)) ?? [];

      daemon.locatesRead.push(Number(at.sequence));

      return signedInOnly(() =>
        json(200, { items, more: false, next: null, through: daemon.through, version: 1 })
      );
    }

    return undefined;
  };

  /**
   * A `PUT` of Configuration, refused when made from another than the one in force.
   * @param network - The Network.
   * @param url - The request's URL.
   * @param init - The request.
   * @returns The answer.
   */
  const put = async (network: string, url: URL, init: RequestInit) => {
    const configuration = Schema.decodeSync(ConfigurationBody)(
      await new Response(init.body).text()
    );

    const ifSequence = url.searchParams.get("ifSequence");
    const before = daemon.configurations.get(network);

    daemon.puts.push({ ifSequence, network });

    if (daemon.interject > 0 && before !== undefined) {
      daemon.interject -= 1;
      daemon.configurations.set(network, {
        configuration: { ...before.configuration, realname: "changed elsewhere" },
        sequence: daemon.nextSequence,
      });
      daemon.nextSequence += 1;
    }

    const inForce = daemon.configurations.get(network);

    if (ifSequence !== null && Number(ifSequence) !== (inForce?.sequence ?? 0)) {
      return json(409, {
        _tag: "ConfigurationChanged",
        network,
        sequence: inForce?.sequence ?? null,
      });
    }

    const sequence = daemon.nextSequence;

    daemon.nextSequence += 1;
    daemon.configurations.set(network, { configuration, sequence });

    if (!daemon.timelines.has(network)) {
      daemon.timelines.set(network, []);
    }

    return json(200, { sequence });
  };

  /**
   * A Network's Configuration and the Credentials, or nothing for any other route.
   * @param url - The request's URL.
   * @param init - The request.
   * @returns The answer, or nothing.
   */
  const configurationRoute = async (url: URL, init: RequestInit): Promise<Response | undefined> => {
    const method = init.method ?? "GET";
    const read = /^\/api\/networks\/(?<network>[^/]+)\/configuration$/u.exec(url.pathname)?.groups;
    const whole = /^\/api\/networks\/(?<network>[^/]+)$/u.exec(url.pathname)?.groups;
    const credential = /^\/api\/credentials\/(?<name>[^/]+)$/u.exec(url.pathname)?.groups;

    const ours =
      read !== undefined ||
      whole !== undefined ||
      credential !== undefined ||
      url.pathname === "/api/credentials";

    if (!daemon.signedIn && ours) {
      return json(401, { _tag: "Unauthorized" });
    }

    if (read?.network !== undefined) {
      const inForce = daemon.configurations.get(read.network);

      return inForce === undefined
        ? json(404, { _tag: "UnknownNetwork", network: read.network })
        : json(200, inForce);
    }

    if (method === "PUT" && whole?.network !== undefined) {
      return await put(whole.network, url, init);
    }

    if (url.pathname === "/api/credentials") {
      return json(200, { names: [...daemon.credentials.keys()].toSorted() });
    }

    if (method === "PUT" && credential?.name !== undefined) {
      const { value } = Schema.decodeSync(CredentialBody)(await new Response(init.body).text());

      daemon.credentials.set(credential.name, value);

      return new Response(null, { status: 204 });
    }

    return undefined;
  };

  /**
   * A Channel's head, or a page of its members, as the Daemon answers them.
   * @param timeline - The Timeline's id.
   * @param what - `channel` or `members`.
   * @param url - The request's URL.
   * @returns The answer.
   */
  const channelRoute = (timeline: string, what: string | undefined, url: URL) => {
    const held = daemon.channels.get(timeline);

    const listed = [...daemon.timelines.values()]
      .flat()
      .find((one) => one.timeline.id === timeline);

    if (listed === undefined) {
      return json(404, { _tag: "UnknownTimeline", timeline });
    }

    if (held === undefined) {
      return json(404, { _tag: "NotAChannel", kind: listed.timeline.kind, timeline });
    }

    if (what === "channel") {
      daemon.channelsRead.push(timeline);

      return json(200, held.header);
    }

    daemon.membersRead.push(url.search);

    const { standing } = held.header;

    return standing === "Joined"
      ? json(200, membersOf(held, url.searchParams, timeline))
      : json(409, { _tag: "NotInChannel", standing, timeline });
  };

  const timelineRoute = (url: URL, init: RequestInit): Response | undefined => {
    const headers = new Headers(init.headers);

    const list = /^\/api\/networks\/(?<network>[^/]+)\/timelines$/u.exec(url.pathname)?.groups;
    const known = /^\/api\/networks\/(?<network>[^/]+)\/known$/u.exec(url.pathname)?.groups;
    const window = /^\/api\/timelines\/(?<timeline>[0-9a-f-]+)$/u.exec(url.pathname)?.groups;

    const channel = /^\/api\/timelines\/(?<timeline>[0-9a-f-]+)\/(?<what>channel|members)$/u.exec(
      url.pathname
    )?.groups;

    const stepped = stepRoute(url);

    if (stepped !== undefined) {
      return stepped;
    }

    if (url.pathname === "/api/timelines/changes") {
      return signedInOnly(() => following(followers, url, headers, init));
    }

    if (url.pathname === "/api/search") {
      const held = [...daemon.timelines.values()].flat();
      const timeline = url.searchParams.get("timeline");

      daemon.searchesRead.push(url.search);

      return signedInOnly(() =>
        timeline !== null && !held.some((one) => one.timeline.id === timeline)
          ? json(404, { _tag: "UnknownTimeline", timeline })
          : json(200, searchOf(held, url.searchParams, daemon.through))
      );
    }

    if (list?.network !== undefined) {
      const { network } = list;

      return signedInOnly(() =>
        json(200, {
          more: false,
          projection: { _tag: "Running" },
          through: daemon.through,
          timelines: (daemon.timelines.get(network) ?? []).map((held) => held.timeline),
          version: 1,
        })
      );
    }

    if (known?.network !== undefined) {
      const session = daemon.sessions.get(known.network) ?? { _tag: "Offline", since: null };

      const { chantypes, declared } = daemon.known.get(known.network) ?? {
        chantypes: null,
        declared: null,
      };

      return signedInOnly(() =>
        json(200, {
          casemapping: declared ?? "rfc1459",
          channels: [],
          chantypes,
          declared,
          self: daemon.selves.get(known.network ?? "") ?? null,
          session,
          users: [],
        })
      );
    }

    if (channel?.timeline !== undefined) {
      return signedInOnly(() => channelRoute(channel.timeline ?? "", channel.what, url));
    }

    if (window?.timeline !== undefined) {
      const id = window.timeline;
      const held = [...daemon.timelines.values()].flat().find((one) => one.timeline.id === id);

      daemon.windowsRead.push(url.search);

      return signedInOnly(() =>
        held === undefined
          ? json(404, { _tag: "UnknownTimeline", timeline: id })
          : json(200, windowOf(held, url.searchParams, daemon.through))
      );
    }

    return undefined;
  };

  /**
   * Marks a Timeline read, kept for a test to look at, or gets no answer as a test asks.
   * @param init - The request.
   * @returns The answer.
   */
  const markRead = async (init: RequestInit) => {
    if (!daemon.signedIn) {
      return json(401, { _tag: "Unauthorized" });
    }

    if (daemon.readFailures > 0) {
      daemon.readFailures -= 1;
      throw new TypeError("fetch failed");
    }

    daemon.reads.push(Schema.decodeSync(ReadBody)(await new Response(init.body).text()));
    daemon.nextSequence += 1;

    return json(200, { sequence: daemon.nextSequence - 1 });
  };

  /**
   * Sends the `ui` options in force to every follower of them, as one `changed` event.
   */
  const sendUi = () => {
    const text = `event: changed\nid: ${daemon.ui.sequence}\ndata: ${JSON.stringify(daemon.ui)}\n\n`;

    for (const follower of uiFollowers) {
      follower.controller.enqueue(encoder.encode(text));
    }
  };

  /**
   * The `ui` options: read, changed one at a time made from a sequence, and followed, the
   * options in force first, or nothing for any other route.
   * @param url - The request's URL.
   * @param init - The request.
   * @returns The answer, or nothing.
   */
  const uiRoute = async (url: URL, init: RequestInit): Promise<Response | undefined> => {
    const method = init.method ?? "GET";

    const one = /^\/api\/ui\/(?<option>activity|colours|theme|themes|time)$/u.exec(
      url.pathname
    )?.groups;

    if (url.pathname === "/api/ui" && method === "GET") {
      return signedInOnly(() => json(200, daemon.ui));
    }

    if (url.pathname === "/api/ui/changes") {
      return signedInOnly(() => {
        const response = following(uiFollowers, url, new Headers(init.headers), init);

        queueMicrotask(sendUi);

        return response;
      });
    }

    if (one?.option === undefined || !daemon.signedIn) {
      return one === undefined ? undefined : json(401, { _tag: "Unauthorized" });
    }

    const ifSequence = url.searchParams.get("ifSequence");

    uiChanges.push({ ifSequence, route: `${method} ${one.option}` });

    if (ifSequence !== null && Number(ifSequence) !== daemon.ui.sequence) {
      return json(409, { _tag: "UiChanged", sequence: daemon.ui.sequence });
    }

    const option = Schema.decodeUnknownSync(UiOptionName)(one.option);

    const { value } =
      method === "PUT"
        ? Schema.decodeSync(UiBody)(await new Response(init.body).text())
        : { value: uiDefaults[option] };

    daemon.ui = {
      options: Schema.decodeSync(UiOptions)({ ...daemon.ui.options, [option]: value }),
      sequence: daemon.nextSequence,
    };
    daemon.nextSequence += 1;
    sendUi();

    return json(200, { sequence: daemon.ui.sequence });
  };

  const elsewhere = async (url: URL, init: RequestInit) =>
    (await uiRoute(url, init)) ??
    (await configurationRoute(url, init)) ??
    timelineRoute(url, init) ??
    new Response(null, { status: 404 });

  /**
   * Answers a `say` or an `act` as the next of `sayAnswers` says: journaled at the next
   * step and done there or refused as `Offline`, one of the API's errors, or no answer.
   * @param intent - Its intent.
   * @param done - What it answers when done: `Said` or `Acted`.
   * @returns The answer.
   */
  const stepped = (intent: string, done: "Said" | "Acted"): Response => {
    const answered = daemon.sayAnswers.shift() ?? "Said";

    if (answered === "Down" || answered === "Lost") {
      if (answered === "Lost") {
        daemon.late.push(intent);
      }

      throw new TypeError("fetch failed");
    }

    if (answered === "UnknownNetwork") {
      return json(404, { _tag: "UnknownNetwork", network: "libera" });
    }

    if (answered !== "NetworkStopped") {
      daemon.journaled.set(intent, daemon.nextSequence);
      daemon.nextSequence += 1;
    }

    const sequence = daemon.nextSequence - 1;

    if (answered === "Said") {
      return json(200, { _tag: done, intent, sequence });
    }

    if (answered === "Offline") {
      return json(200, { _tag: "Refused", intent, reason: { _tag: "Offline" }, sequence });
    }

    return json(503, {
      _tag: "NetworkStopped",
      intent,
      network: "libera",
      outcome: "Uncertain",
      reason: "stopped",
    });
  };

  const answer = async (url: URL, init: RequestInit = {}): Promise<Response> => {
    const route = `${init.method ?? "GET"} ${url.pathname}`;

    switch (route) {
      case "POST /api/sign-in": {
        const { key } = Schema.decodeSync(SignInBody)(await new Response(init.body).text());

        daemon.keysSent.push(key);

        if (key !== theKey) {
          return json(401, { _tag: "Unauthorized" });
        }

        if (daemon.signInsFail) {
          return json(503, { _tag: "SignInsFailed", reason: "disk full" });
        }

        daemon.signedIn = true;

        return new Response(null, { status: 204 });
      }

      case "DELETE /api/sign-in": {
        if (daemon.signInsFail) {
          return json(503, { _tag: "SignInsFailed", reason: "disk full" });
        }

        daemon.signedIn = false;

        return new Response(null, { status: 204 });
      }

      case "GET /api/networks": {
        return signedInOnly(() =>
          json(
            200,
            [...daemon.timelines.keys()].map((network) => ({
              network,
              status: { _tag: "Running" },
            }))
          )
        );
      }

      case "POST /api/networks/libera/read": {
        return await markRead(init);
      }

      case "POST /api/networks/libera/act": {
        if (!daemon.signedIn) {
          return json(401, { _tag: "Unauthorized" });
        }

        const body = Schema.decodeSync(ActBody)(await new Response(init.body).text());

        daemon.acts.push(body);

        return stepped(body.intent, "Acted");
      }

      case "POST /api/networks/libera/say": {
        if (!daemon.signedIn) {
          return json(401, { _tag: "Unauthorized" });
        }

        const body = Schema.decodeSync(SayBody)(await new Response(init.body).text());

        daemon.says.push(body);

        return stepped(body.intent, "Said");
      }

      default: {
        return await elsewhere(url, init);
      }
    }
  };

  /**
   * A read of a Channel's head, its members, or `known`, which gets no answer or waits
   * until a test releases it, as the test asks, or nothing for any other.
   * @param url - The request's URL.
   * @param init - The request.
   * @returns The answer, or nothing.
   */
  const held = (url: URL, init: RequestInit | undefined): Promise<Response> | undefined => {
    const kind = /\/(?<what>channel|members|known)$/u.exec(url.pathname)?.groups?.what;

    if (kind === "known" && daemon.knownDown) {
      return Promise.reject(new TypeError("fetch failed"));
    }

    const lists = new Map([
      ["channel", { holding: daemon.holdChannels, list: channelsHeld }],
      ["known", { holding: daemon.holdKnown, list: knownHeld }],
      ["members", { holding: daemon.holdMembers, list: membersHeld }],
    ]);

    const holding = kind === undefined ? undefined : lists.get(kind);

    if (holding === undefined || !holding.holding) {
      return undefined;
    }

    const { promise, resolve } = Promise.withResolvers<undefined>();

    holding.list.push(() => {
      resolve(undefined);
    });

    return promise.then(async () => await answer(url, init));
  };

  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    if (daemon.down) {
      throw new TypeError("fetch failed");
    }

    const url = new URL(input instanceof Request ? input.url : input);

    const isLocate = /\/at\/\d+$/u.test(url.pathname);

    if (isLocate && daemon.locateFailures > 0) {
      daemon.locateFailures -= 1;
      daemon.locatesRead.push(Number(url.pathname.split("/").at(-1)));
      throw new TypeError("fetch failed");
    }

    // A Daemon that holds each read of a step's items until a test releases it.
    if (isLocate && daemon.holdLocates) {
      const { promise, resolve } = Promise.withResolvers<undefined>();

      daemon.locatesHeld.push(() => {
        resolve(undefined);
      });
      await promise;

      return await answer(url, init);
    }

    const read = held(url, init);

    if (read !== undefined) {
      return await read;
    }

    // A Daemon that holds each request for the Network list until a test releases it, and
    // then answers with the Networks it holds by then.
    if (daemon.holdNetworks && url.pathname === "/api/networks") {
      const { promise, resolve } = Promise.withResolvers<undefined>();

      daemon.networksHeld.push(() => {
        resolve(undefined);
      });
      await promise;

      return await answer(url, init);
    }

    // A Daemon that takes a follower's request and never begins its answer, until the
    // request is given up.
    if (daemon.hangChanges && url.pathname === "/api/timelines/changes") {
      const { promise, reject } = Promise.withResolvers<Response>();

      daemon.hung.push(url.searchParams.get("after") ?? "");
      init?.signal?.addEventListener("abort", () => {
        daemon.abandoned += 1;
        reject(new DOMException("aborted", "AbortError"));
      });

      return await promise;
    }

    return daemon.gatewayOnly ? new Response(null, { status: 502 }) : await answer(url, init);
  };

  return { daemon, endStreams, fetch, send, sendUi };
};

/**
 * A registry whose runtime reaches the fake Daemon through `fetch`.
 * @param fetch - The fake's `fetch`.
 * @param waits - Waits other than a test's defaults, such as how long the changes stream
 * may give nothing before it is followed again.
 * @param notifier - The notifications' host, a test's, which shows none by default.
 * @param reader - The reader of themes, which reads at once, in the page, by default.
 * @returns The registry.
 */
export const registryFor = (
  fetch: typeof globalThis.fetch,
  waits: Partial<WaitTimes> = {},
  notifier: NotifierPort = testNotifier().port,
  reader: ThemeReaderPort = instantThemeReader
) => {
  let named = 0;

  // A page on a device that kept no layout, whatever an earlier test's page kept.
  writeChoice(layoutKey, undefined);

  return AtomRegistry.make({
    initialValues: [
      [
        runtime.layer,
        Layer.mergeAll(
          layerDaemonClient("http://daemon.test"),
          Layer.succeed(FetchHttpClient.Fetch, fetch),
          // Waits short enough for a test to see a retry or a reconnect.
          Layer.succeed(Waits, {
            complete: "10 millis",
            debounce: "30 millis",
            idle: "2 seconds",
            interval: "100 millis",
            longest: "50 millis",
            reconnect: "10 millis",
            retry: "10 millis",
            settle: "50 millis",
            ...waits,
          }),
          Layer.succeed(Notifier, notifier),
          Layer.succeed(ThemeReader, reader),
          // Intents named in order, web-1, web-2, and on, so a test can name them.
          Layer.succeed(IntentNames, () => {
            named += 1;

            return `web-${named}`;
          })
        ),
      ],
    ],
  });
};

/**
 * Sets a command and waits until it has finished.
 * @param registry - The registry.
 * @param command - The command.
 * @param argument - Its argument.
 */
export const run = async <W, A, E>(
  registry: AtomRegistry.AtomRegistry,
  command: Atom.AtomResultFn<W, A, E>,
  argument: W
) => {
  registry.set(command, argument);
  await Effect.runPromise(
    AtomRegistry.getResult(registry, command, { suspendOnWaiting: true }).pipe(Effect.ignore)
  );
};

/**
 * The values of an object's own enumerable properties, whatever they are.
 * @param value - The object.
 * @returns Its values.
 */
// oxlint-disable-next-line anti-slop/no-object-parameters -- the walk below takes values of any shape on purpose.
const ownValues = (value: object): readonly unknown[] =>
  // oxlint-disable-next-line anti-slop/no-reflect-get, anti-slop/no-unknown-returns -- a walk over values of any shape, looking for a secret, reads properties it cannot name.
  Object.keys(value).map((key): unknown => Reflect.get(value, key));

/**
 * Whether anything reachable from a value holds a secret: a string containing it, or a
 * redacted value that still holds one containing it. It follows every own property, and
 * `Map` and `Set` entries. A DOM node is followed only through what React keeps on it, so
 * the walk stays inside React's own state and props.
 * @param from - Where to start, such as a React root or an atom registry.
 * @param secret - The secret.
 * @returns Whether it was found.
 */
// oxlint-disable-next-line anti-slop/no-object-parameters -- it starts from a React root or a registry, whose shapes are their own.
export const holds = (from: object, secret: string): boolean => {
  const seen = new Set<object>();
  const pending: unknown[] = [from];

  while (pending.length > 0) {
    const next = pending.pop();

    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- this walks values of any shape on purpose, looking for a string.
    if (typeof next === "string") {
      if (next.includes(secret)) {
        return true;
      }
    } else if (next instanceof Object && !seen.has(next)) {
      seen.add(next);

      if (Redacted.isRedacted(next)) {
        pending.push(hasValue(next) ? Redacted.value(next) : undefined);
      } else if (next instanceof Node) {
        pending.push(
          ...Object.keys(next)
            .filter((key) => key.startsWith("__react"))
            // oxlint-disable-next-line anti-slop/no-reflect-get, anti-slop/no-unknown-returns -- a walk over values of any shape, looking for a secret, reads properties it cannot name.
            .map((key): unknown => Reflect.get(next, key))
        );
      } else {
        pending.push(...ownValues(next));

        if (next instanceof Map || next instanceof Set) {
          pending.push(...next.keys(), ...next.values());
        }
      }
    }
  }

  return false;
};

/**
 * Waits until an atom's value holds, reading it each time it changes.
 * @param registry - The registry.
 * @param atom - The atom.
 * @param holds - What must hold.
 * @returns The value that held, or a rejection after two seconds.
 */
export const until = async <A>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<A>,
  holds: (value: A) => boolean
): Promise<A> => {
  const { promise, reject, resolve } = Promise.withResolvers<A>();

  const look = (value: A) => {
    if (holds(value)) {
      resolve(value);
    }
  };

  const stop = registry.subscribe(atom, look, { immediate: true });

  const timer = setTimeout(() => {
    reject(new Error("the atom never held"));
  }, 2000);

  try {
    return await promise;
  } finally {
    clearTimeout(timer);
    stop();
  }
};

/**
 * Waits until something the fake holds is so, looking every few milliseconds.
 * @param holds - What must hold.
 * @returns Once it does, or a rejection after two seconds.
 */
export const eventually = async (holds: () => boolean): Promise<void> => {
  for (let waited = 0; waited < 2000; waited += 5) {
    if (holds()) {
      return;
    }

    // oxlint-disable-next-line no-await-in-loop -- looking again until it holds
    await Effect.runPromise(Effect.sleep("5 millis"));
  }

  throw new Error("it never held");
};
