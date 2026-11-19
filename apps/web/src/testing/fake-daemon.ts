/**
 * What the web frontend's tests share: a fake Daemon at the `fetch` level, a registry whose
 * runtime reaches it, and ways to wait on a command and to look for a secret.
 *
 * @packageDocumentation
 */
import {
  ConfigurationInForce,
  OwnerOptionName,
  OwnerOptions,
  ownerDefaults,
  ownerOptionNames,
  ownerValueKept,
  UiOptionName,
  UiOptions,
  uiDefaults,
  uiOptionNames,
  UploadRename,
} from "@iirc/api";
import type {
  ChannelHeader,
  Closed,
  Knowledge,
  LookResult,
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
  OwnerInForce,
  PreviewItem,
  Projection,
  UiInForce,
  Upload,
  UploadsStatus,
} from "@iirc/api";
import { importTheme } from "@iirc/frontend/theme-import";
import { Clock, Effect, Layer, Redacted, Result, Schema, Scope } from "effect";
import { Base64Url } from "effect/encoding";
import { FetchHttpClient } from "effect/http";
import { AtomRegistry } from "effect/reactivity";
import type { Atom } from "effect/reactivity";
import { TestClock } from "effect/testing";

import { layerDaemonClient } from "../app/daemon-client.ts";
import { IntentNames } from "../app/intent-names.ts";
import { runtime } from "../app/runtime.ts";
import { Uploader } from "../composer/uploader.ts";
import type { UploaderPort } from "../composer/uploader.ts";
import { Notifier } from "../notifications/notifier.ts";
import type { NotifierPort } from "../notifications/notifier.ts";
import { writeChoice } from "../page/device.ts";
import { ThemeReader } from "../theme/reader.ts";
import type { ThemeReaderPort } from "../theme/reader.ts";
import { layoutKey, Waits } from "../timelines/atoms.ts";
import type { WaitTimes } from "../timelines/atoms.ts";
import { testNotifier } from "./notifier.ts";
import { testUploader } from "./uploader.ts";

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
  | typeof Closed.Encoded
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
  | { readonly _tag: "LifeChanged"; readonly life: number; readonly network: string }
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
  | { readonly _tag: "UiChanged"; readonly sequence: number }
  | {
      readonly _tag: "LookedUp";
      readonly intent: string;
      readonly result: typeof LookResult.Encoded;
      readonly sequence: number;
    }
  | { readonly _tag: "Pending"; readonly intent: string; readonly sequence: number }
  | { readonly _tag: "NotJournaled" };

const json = (status: number, body: Answer) => Response.json(body, { status });

const decodeRename = Schema.decodeUnknownSync(Schema.fromJsonString(UploadRename));

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
    answers: Schema.optionalKey(Schema.String),
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
/** The route of one option under `ui`, for each option the contract has. */
const uiOptionRoute = new RegExp(`^/api/ui/(?<option>${uiOptionNames.join("|")})$`, "u");

const UiBody = Schema.fromJsonString(Schema.Struct({ value: Schema.Json }));

/** The options under `store`, `uploads`, and `previews` before any Change: each at its default, if any. */
const noOwnerChange: typeof OwnerInForce.Encoded = { options: ownerDefaults, sequence: 0 };

/** The route of one option under `store`, `uploads`, or `previews`, for each option the contract has. */
const ownerOptionRoute = new RegExp(
  `^/api/options/(?<option>${ownerOptionNames.map((name) => name.replaceAll(".", String.raw`\.`)).join("|")})$`,
  "u"
);

const ReadBody = Schema.fromJsonString(
  Schema.Struct({ read: Schema.Finite, target: Schema.NullOr(Schema.String) })
);

const CloseBody = Schema.fromJsonString(Schema.Struct({ target: Schema.String }));

const PreviewsBody = Schema.fromJsonString(Schema.Struct({ position: Schema.String }));

const PressBody = Schema.fromJsonString(
  Schema.Struct({ link: Schema.Int, position: Schema.String })
);

/** The Configuration the fake's Network `libera` starts with. */
export const liberaConfiguration: ConfigurationOnWire = {
  answerCtcp: true,
  channels: [{ name: "#iirc" }],
  declined: [],
  enabled: true,
  fallbackEncoding: "windows-1252",
  highlights: [],
  ignores: [],
  ircds: [{ host: "irc.libera.chat", port: 6697, tls: true }],
  lines: [],
  login: { _tag: "None" },
  nicks: ["iirc"],
  oper: { _tag: "None" },
  realname: "iirc",
  userModes: "",
  username: "iirc",
  whoOnJoin: true,
};

const LookBody = Schema.fromJsonString(
  Schema.Struct({
    intent: Schema.optionalKey(Schema.String),
    lookup: Schema.Union([
      Schema.Struct({ _tag: Schema.Literals(["Whois", "Whowas"]), nick: Schema.String }),
      Schema.Struct({
        _tag: Schema.Literals(["Bans", "Exceptions", "Invitations"]),
        channel: Schema.String,
      }),
    ]),
  })
);

/**
 * How the fake answers a `look`: journaled and `LookedUp` at once, journaled and `Pending`,
 * `NetworkStopped` journaled or not, `UnknownNetwork`, or journaled and no answer (`Lost`).
 * Asked after by intent, it answers `Pending` `pending` times, then `LookedUp` with
 * `result`.
 */
export interface LookScript {
  readonly answer:
    | "LookedUp"
    | "Pending"
    | "NetworkStopped"
    | "NetworkStoppedJournaled"
    | "UnknownNetwork"
    | "Lost";
  readonly result: typeof LookResult.Encoded;
  readonly pending: number;
}

/**
 * A User as a Lookup's reply describes them, with nothing said but what a test gives.
 * @param fields - What the reply said.
 * @returns The User, as the wire carries them.
 */
export const profileOf = (
  fields: Partial<(typeof LookResult.Encoded & { readonly _tag: "Found" })["profiles"][number]>
): (typeof LookResult.Encoded & { readonly _tag: "Found" })["profiles"][number] => ({
  account: null,
  actual: null,
  away: null,
  channels: [],
  host: null,
  idle: null,
  modes: null,
  nick: "peer",
  operator: false,
  other: [],
  realname: null,
  secure: false,
  server: null,
  signon: null,
  user: null,
  ...fields,
});

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
 * Waits until a test releases a request, or the request is given up, which aborts it.
 * @param releases - Where its release goes.
 * @param init - The request.
 * @returns Once released.
 */
const heldUntilReleased = async (releases: (() => void)[], init: RequestInit) => {
  const { promise, reject, resolve } = Promise.withResolvers<undefined>();

  releases.push(() => {
    resolve(undefined);
  });
  init.signal?.addEventListener("abort", () => {
    reject(new DOMException("aborted", "AbortError"));
  });

  await promise;
};

/**
 * Uploads on, with `uploads.maxSize` at its default, as a function's answer, so the field it
 * starts takes every status, not this one alone.
 * @returns The status.
 */
/**
 * The projection while the Timelines are folded.
 * @returns It, as the wire carries it.
 */
const folding = (): typeof Projection.Encoded => ({ _tag: "Running" });

const uploadsOn = (): typeof UploadsStatus.Encoded => ({
  _tag: "On",
  maxSize: 100 * 1024 * 1024,
});

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
  const listsHeld: (() => void)[] = [];
  const puts: { readonly network: string; readonly ifSequence: string | null }[] = [];
  const removals: { readonly network: string; readonly keep: boolean }[] = [];
  const reads: (typeof ReadBody.Type)[] = [];
  const closes: { readonly network: string; readonly target: string }[] = [];
  const channelsRead: string[] = [];
  const channelsAsked: string[] = [];
  const channelsHeld: (() => void)[] = [];
  const membersHeld: (() => void)[] = [];
  const knownHeld: (() => void)[] = [];
  const saysHeld: (() => void)[] = [];
  const closesHeld: (() => void)[] = [];
  const membersRead: string[] = [];
  const uiFollowers: Follower[] = [];
  const uiReadsHeld: (() => void)[] = [];
  const uiFollowsHeld: (() => void)[] = [];
  const statusesHeld: (() => void)[] = [];
  const uiChanges: { readonly route: string; readonly ifSequence: string | null }[] = [];
  const ownerFollowers: Follower[] = [];
  const ownerChanges: { readonly route: string; readonly ifSequence: string | null }[] = [];
  const uploads: (typeof Upload.Encoded)[] = [];
  const uploadFollowers: Follower[] = [];
  const uploadsMissing: string[] = [];
  const uploadPagesRead: (string | undefined)[] = [];
  const uploadPagesHeld: (() => void)[] = [];
  // Each Upload `upload` made, as its event, at its Change's sequence, oldest first.
  const uploadChanges: { readonly sequence: number; readonly text: string }[] = [];
  const uploadsSent: { readonly name: string | null; readonly size: number }[] = [];
  const uploadRefusals: { readonly status: number; readonly body: object }[] = [];

  const uploadEdits: { readonly method: string; readonly id: string; readonly name?: string }[] =
    [];

  const uploadEditRefusals: { readonly status: number; readonly body: object }[] = [];
  const previewAsks: { readonly timeline: string; readonly position: string }[] = [];
  const previewFollowers: Follower[] = [];
  const projectionFollowers: Follower[] = [];

  const presses: {
    readonly timeline: string;
    readonly position: string;
    readonly link: number;
  }[] = [];

  const looks: (typeof LookBody.Type & { readonly network: string })[] = [];
  const lookScripts: LookScript[] = [];
  const looked: string[] = [];
  const lookedHeld: (() => void)[] = [];
  const looksHeld: (() => void)[] = [];
  const actsHeld: (() => void)[] = [];

  const lookups = new Map<
    string,
    { pending: number; result: typeof LookResult.Encoded; sequence: number }
  >();

  const daemon = {
    /** How many requests that never began their answer were given up. */
    abandoned: 0,
    /** Each `act` asked for, in order, refused or not, answered as `say`s are. */
    acts,
    /** The release of each `act` held, in order. */
    actsHeld,
    /** Each Channel behind a Channel Timeline, by its id, which `channel` and `members` read. */
    channels: new Map<string, FakeChannel>(),
    /** Each read of a Channel's head as it is asked, held or not, by its Timeline. */
    channelsAsked,
    /** Each read of a Channel's head answered, by its Timeline. */
    channelsRead,
    /** Each close asked for, joined or not, in order. */
    closes,
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
    /** Whether a request to follow the `ui` options never begins its answer. */
    hangUiChanges: false,
    /**
     * Releases each request held: a read of a Channel's head, its members, or `known`, a
     * `say`, or a `close`.
     */
    held: {
      channel: channelsHeld,
      closes: closesHeld,
      known: knownHeld,
      members: membersHeld,
      says: saysHeld,
    },
    /** Whether each `act` waits, once taken, until released or given up. */
    holdActs: false,
    /** Whether each read of a Channel's head waits until released. */
    holdChannels: false,
    /** Whether each `close`, once stepped, waits until released before it is answered. */
    holdCloses: false,
    /** Whether each read of `known` waits until released. */
    holdKnown: false,
    /** Whether each read of a Network's Timelines waits until released. */
    holdLists: false,
    /** Whether each `at/{sequence}` read waits until released. */
    holdLocates: false,
    /** Whether each `GET` of a Lookup by its intent waits until released. */
    holdLooked: false,
    /** Whether each `look` waits, once journaled, until released. */
    holdLooks: false,
    /** Whether each read of a Channel's members waits until released. */
    holdMembers: false,
    /** Whether each request for the Network list waits until released. */
    holdNetworks: false,
    /** Whether each `say` waits, before it is answered as `sayAnswers` says, until released. */
    holdSays: false,
    /** Whether each request to follow the `ui` options waits until released, then answers with the ones in force then. */
    holdUiFollows: false,
    /** Whether each read of the `ui` options waits until released, then answers as they were when asked. */
    holdUiReads: false,
    /** Whether each page of the Uploads, taken as it is asked for, waits until released to answer. */
    holdUploadPages: false,
    /** Whether each read of whether Uploads are on waits until released, then answers as they are then. */
    holdUploadsStatus: false,
    /** Where each request that never began its answer asked to follow from. */
    hung,
    /**
     * How many of the next `PUT`s of Configuration find that another Frontend changed the
     * Network's `realname` just before their turn.
     */
    interject: 0,
    /**
     * The Channels Self is in on each Network, by name, as `known` gives them: none until a
     * test says. A `close` of one is refused as `Joined`, as the Client ignores it.
     */
    joined: new Map<string, readonly string[]>(),
    /** Each intent journaled, and its sequence, which `said` answers from. */
    journaled,
    /** The Networks removed with their Timelines kept, which still hold them. */
    kept: new Set<string>(),
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
    /** Releases each read of a Network's Timelines held, in the order they came. */
    listsHeld,
    /** Each Network's life, the step that began it: 1 unless it was added again. */
    lives: new Map<string, number>(),
    /** How many of the next `at/{sequence}` reads get no answer. */
    locateFailures: 0,
    /** Releases each `at/{sequence}` read held, in the order they came. */
    locatesHeld,
    /** Each `at/{sequence}` read, by its sequence, failed or held ones included. */
    locatesRead,
    /** How the next `look`s are answered, first to last; past them, `LookedUp` not found. */
    lookScripts,
    /** Each `GET` of a Lookup by its intent, in order. */
    looked,
    /** Releases each `GET` of a Lookup held, in the order they came. */
    lookedHeld,
    /** Each `look` asked for, in order, with its Network. */
    looks,
    /** Releases each `look` held, in the order they came. */
    looksHeld,
    /** Each Lookup journaled, by its intent: how many asks it answers `Pending`, and its result. */
    lookups,
    /** Each read of a Channel's members, by its query. */
    membersRead,
    /** Releases each request for the Network list held, in the order they came. */
    networksHeld,
    /** The sequence the next `say` is journaled at. */
    nextSequence: 10,
    /** The options under `store`, `uploads`, and `previews` in force, as the wire carries them, and the sequence of the last Change. */
    owner: noOwnerChange,
    /** Each change of an option under `store`, `uploads`, or `previews` asked for, as `PUT` or `DELETE` and its option, and its `ifSequence`. */
    ownerChanges,
    /** Each follower of the options under `store`, `uploads`, and `previews`. */
    ownerFollowers,
    /** The items each step placed, which `at/{sequence}` answers with. */
    placed: new Map<number, (typeof TimelineItem.Encoded)[]>(),
    /** Each press of a link waiting for one, by its Timeline, its place, and its index, refused or not. */
    presses,
    /** Each ask for a Message's Previews, by its Timeline and its place, refused or not. */
    previewAsks,
    /** Each follower of the stream of Previews. */
    previewFollowers,
    /**
     * Each Message's Previews, by its place, which an ask answers with while `ui.previews`
     * is not `off`; a Message with none is unknown.
     */
    previews: new Map<string, (typeof PreviewItem.Encoded)[]>(),
    /** Whether the Timelines are folded, as the projection's stream says it as it opens. */
    projection: folding(),
    /** Each follower of whether the Timelines are folded. */
    projectionFollowers,
    /** Each `PUT` of Configuration, with the sequence it was made from. */
    puts,
    /** How many of the next marks read get no answer. */
    readFailures: 0,
    /** Each Timeline marked read, as its body said it, in order. */
    reads,
    /** Each removal of a Network, with whether its Timelines were kept. */
    removals,
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
      ["libera", { _tag: "Registered", ircd: "ircd.test", since: 1, tags: false }],
    ]),
    signInsFail: false,
    signedIn: false,
    /** The release of each read of whether Uploads are on held, in the order asked. */
    statusesHeld,
    /** Each `GET /api/uploads/status` asked. */
    statusesRead: 0,
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
    /** Releases each request to follow the `ui` options held, in the order they came. */
    uiFollowsHeld,
    /** Releases each read of the `ui` options held, in the order they came. */
    uiReadsHeld,
    /**
     * How the next renames and deletes of an Upload are refused, first to last, as the API's
     * errors on the wire; past them, each is done.
     */
    uploadEditRefusals,
    /** Each rename and delete of an Upload asked for, as `PATCH` or `DELETE`, in order. */
    uploadEdits,
    /** Each follower of the Uploads' Changes. */
    uploadFollowers,
    /** Releases each page of the Uploads held, in the order they came. */
    uploadPagesHeld,
    /** Each page of the Uploads read, by the `after` it was read from. */
    uploadPagesRead,
    /**
     * How the next uploads are refused, first to last, as the API's errors on the wire;
     * past them, each is kept.
     */
    uploadRefusals,
    /** The Uploads held, newest first, deleted ones too, as the wire carries them. */
    uploads,
    /** The ids of the live Uploads whose bytes are gone, which the Uploads' stream says first and whenever they change. */
    uploadsMissing,
    /** How many Uploads a page holds when its request gives no `limit`. */
    uploadsPage: 50,
    /** Each file sent to `POST /api/uploads`, by the name its query gave and its size. */
    uploadsSent,
    /** Whether Uploads are on, as `GET /api/uploads/status` answers. */
    uploadsStatus: uploadsOn(),
    /** Each read of a window, by its query, for a test to look at. */
    windowsRead,
  };

  /**
   * A stream of Server-Sent Events, kept in a list of followers while it is open, which
   * sends what is replayed first.
   * @param list - The followers.
   * @param url - The request's URL.
   * @param headers - Its headers.
   * @param init - The request.
   * @param replayed - The events sent before any live one, as the wire carries them.
   * @returns The response.
   */
  const following = (
    list: Follower[],
    url: URL,
    headers: Headers,
    init: RequestInit,
    replayed: readonly string[] = []
  ) => {
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        for (const text of replayed) {
          controller.enqueue(encoder.encode(text));
        }

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

  /**
   * Whether the Timelines are folded, as one event of the projection's stream.
   * @returns The event, as the wire carries it.
   */
  const projectionEvent = () => `event: projection\ndata: ${JSON.stringify(daemon.projection)}\n\n`;

  /**
   * Stops the projection, as a failure does, and says so to every follower of it.
   * @param reason - Why.
   */
  const stopProjection = (reason: string) => {
    daemon.projection = { _tag: "Stopped", reason };

    for (const follower of projectionFollowers) {
      follower.controller.enqueue(encoder.encode(projectionEvent()));
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

    if (daemon.kept.has(network)) {
      return json(409, { _tag: "TimelinesKept", network });
    }

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

    // A Network added again after it was removed begins a new life, at this step.
    if (!daemon.timelines.has(network)) {
      daemon.timelines.set(network, []);
      daemon.lives.set(network, sequence);
    }

    return json(200, { sequence });
  };

  /**
   * Removes a Network, as the Daemon does: its Configuration goes, and its Timelines are
   * flagged removed and kept, or dropped, which the changes stream says in one step. One
   * removed with them kept is removed again to drop them.
   * @param network - The Network.
   * @param keep - Whether its Timelines are kept.
   * @param asked - The life of it the removal was made from, which must be the one held.
   * @returns The answer.
   */
  const remove = (network: string, keep: boolean, asked: number) => {
    const held = daemon.timelines.get(network);

    if (held === undefined && !daemon.configurations.has(network)) {
      return json(404, { _tag: "UnknownNetwork", network });
    }

    const holding = daemon.lives.get(network) ?? 1;

    if (asked !== holding) {
      return json(409, { _tag: "LifeChanged", life: holding, network });
    }

    daemon.removals.push({ keep, network });

    const sequence = daemon.nextSequence;
    const timelines = held ?? [];
    const life = daemon.lives.get(network) ?? 1;

    daemon.nextSequence += 1;
    daemon.through = sequence;
    daemon.configurations.delete(network);

    // Kept again changes nothing.
    if (keep && daemon.kept.has(network)) {
      return json(200, { life, sequence });
    }

    const change = {
      dropped: keep
        ? []
        : timelines.map((one) => ({ changed: sequence, id: one.timeline.id, life, network })),
      gaps: [],
      items: [],
      merged: [],
      removals: [{ changed: sequence, keep, life, network }],
      sequence,
      timelines: keep
        ? timelines.map((one) => ({ ...one.timeline, changed: sequence, removed: true }))
        : [],
    };

    if (keep) {
      daemon.kept.add(network);

      for (const one of timelines) {
        Object.assign(one, { timeline: { ...one.timeline, changed: sequence, removed: true } });
      }
    } else {
      daemon.kept.delete(network);
      daemon.timelines.delete(network);
    }

    send({ data: JSON.stringify(change), event: "changed", id: `1.${sequence}` });

    return json(200, { life, sequence });
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

    if (url.pathname === "/api/timelines/projection") {
      return signedInOnly(() =>
        following(projectionFollowers, url, headers, init, [projectionEvent()])
      );
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

      const channels = (daemon.joined.get(known.network) ?? []).map((name) => ({
        key: lower(name),
        members: [],
        modes: { _tag: "Unknown" } as const,
        name,
        standing: "Joined" as const,
        topic: { _tag: "Unknown" } as const,
        wanted: true,
      }));

      return signedInOnly(() =>
        json(200, {
          casemapping: declared ?? "rfc1459",
          channels,
          chantypes,
          declared,
          life: daemon.lives.get(known.network ?? "") ?? 1,
          partners: [],
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
   * Closes a Timeline, as the Daemon does: a Channel Self is in is refused as `Joined`, and
   * otherwise the Timeline named, in any ASCII case, is `closed`, which the changes stream
   * says in one step, and stays so until something arrives in it. The answer waits while
   * `holdCloses` says, though the close was already stepped.
   * @param network - The Network.
   * @param init - The request.
   * @returns The answer.
   */
  const close = async (network: string, init: RequestInit) => {
    if (!daemon.signedIn) {
      return json(401, { _tag: "Unauthorized" });
    }

    const { target: typed } = Schema.decodeSync(CloseBody)(await new Response(init.body).text());
    // The Client resolves a Target as it does a `Read`'s, so a status prefix names the Channel
    // without it, and that is what a refusal names.
    const target = typed.replace(/^[~&@%+]+(?=[#&])/u, "");
    const sequence = daemon.nextSequence;

    daemon.closes.push({ network, target: typed });
    daemon.nextSequence += 1;
    daemon.through = sequence;

    const joined = (daemon.joined.get(network) ?? []).some((name) => lower(name) === lower(target));

    const held = (daemon.timelines.get(network) ?? []).find(
      (one) => one.timeline.kind !== "Network" && lower(one.timeline.name) === lower(target)
    );

    if (!joined && held !== undefined) {
      Object.assign(held, { timeline: { ...held.timeline, changed: sequence, closed: true } });

      send({
        data: JSON.stringify({
          dropped: [],
          gaps: [],
          items: [],
          merged: [],
          removals: [],
          sequence,
          timelines: [held.timeline],
        }),
        event: "changed",
        id: `1.${sequence}`,
      });
    }

    if (daemon.holdCloses) {
      const { promise, resolve } = Promise.withResolvers<undefined>();

      closesHeld.push(() => {
        resolve(undefined);
      });
      await promise;
    }

    const closed: typeof Closed.Encoded = joined
      ? { _tag: "Refused", reason: { _tag: "Joined", channel: target }, sequence }
      : { _tag: "Closed", sequence };

    return json(200, closed);
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

    const one = uiOptionRoute.exec(url.pathname)?.groups;

    if (url.pathname === "/api/ui" && method === "GET") {
      const asked = daemon.ui;
      const answered = signedInOnly(() => json(200, asked));

      if (daemon.holdUiReads) {
        await heldUntilReleased(uiReadsHeld, init);
      }

      return answered;
    }

    // A Daemon that takes a follower of the `ui` options and never begins its answer, until
    // the request is given up.
    if (url.pathname === "/api/ui/changes" && daemon.hangUiChanges) {
      return await heldUntilReleased([], init).then(() => new Response(null, { status: 502 }));
    }

    if (url.pathname === "/api/ui/changes") {
      if (daemon.holdUiFollows) {
        await heldUntilReleased(uiFollowsHeld, init);
      }

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

  /**
   * Sends the options under `store`, `uploads`, and `previews` in force to every follower of them, as one
   * `changed` event.
   */
  const sendOwner = () => {
    const text = `event: changed\nid: ${daemon.owner.sequence}\ndata: ${JSON.stringify(daemon.owner)}\n\n`;

    for (const follower of ownerFollowers) {
      follower.controller.enqueue(encoder.encode(text));
    }
  };

  /**
   * The options under `store`, `uploads`, and `previews`: read, changed one at a time made from a
   * sequence, a value their Schema refuses refused, and followed, the options in force
   * first, or nothing for any other route.
   * @param url - The request's URL.
   * @param init - The request.
   * @returns The answer, or nothing.
   */
  const ownerRoute = async (url: URL, init: RequestInit): Promise<Response | undefined> => {
    const method = init.method ?? "GET";
    const one = ownerOptionRoute.exec(url.pathname)?.groups;

    if (url.pathname === "/api/options" && method === "GET") {
      return signedInOnly(() => json(200, daemon.owner));
    }

    if (url.pathname === "/api/options/changes") {
      return signedInOnly(() => {
        const response = following(ownerFollowers, url, new Headers(init.headers), init);

        queueMicrotask(sendOwner);

        return response;
      });
    }

    if (one?.option === undefined || !daemon.signedIn) {
      return one === undefined ? undefined : json(401, { _tag: "Unauthorized" });
    }

    const ifSequence = url.searchParams.get("ifSequence");

    ownerChanges.push({ ifSequence, route: `${method} ${one.option}` });

    if (ifSequence !== null && Number(ifSequence) !== daemon.owner.sequence) {
      return json(409, { _tag: "OptionsChanged", sequence: daemon.owner.sequence });
    }

    const option = Schema.decodeUnknownSync(OwnerOptionName)(one.option);

    const { value } =
      method === "PUT"
        ? Schema.decodeSync(UiBody)(await new Response(init.body).text())
        : { value: undefined };

    if (value !== undefined && ownerValueKept(option, value) === undefined) {
      return Response.json(
        {
          _tag: "InvalidRequest",
          issues: [{ message: "refused by its Schema", path: ["payload", "value"] }],
        },
        { status: 400 }
      );
    }

    // Unset, an option is back to its default, or absent with none.
    const kept = new Map<string, unknown>([
      ...Object.entries(ownerDefaults),
      ...Object.entries(daemon.owner.options).filter(([name]) => name !== option),
    ]);

    if (value !== undefined) {
      kept.set(option, value);
    }

    daemon.owner = {
      options: Schema.encodeSync(OwnerOptions)(
        Schema.decodeUnknownSync(OwnerOptions)(Object.fromEntries(kept))
      ),
      sequence: daemon.nextSequence,
    };
    daemon.nextSequence += 1;
    sendOwner();

    return json(200, { sequence: daemon.owner.sequence });
  };

  /**
   * Sends an Upload whole, as it is now, to every follower of the Uploads' Changes, at the
   * next sequence, which a follower resuming before it is sent too.
   * @param added - The Upload, as the wire carries it.
   */
  const changedUpload = (added: typeof Upload.Encoded) => {
    const sequence = daemon.nextSequence;
    const text = `event: changed\nid: ${sequence}\ndata: ${JSON.stringify(added)}\n\n`;

    uploadChanges.push({ sequence, text });
    daemon.nextSequence += 1;

    for (const follower of uploadFollowers) {
      follower.controller.enqueue(encoder.encode(text));
    }
  };

  /**
   * The event that says which Uploads' bytes are gone, whole, as the wire carries it.
   * @returns The event.
   */
  const missingText = () =>
    `event: missing\ndata: ${JSON.stringify({ uploads: daemon.uploadsMissing })}\n\n`;

  /**
   * Says which Uploads' bytes are gone, as the Daemon does when a read finds one gone, or
   * finds one back: to every follower of the Uploads' stream, whole, with no sequence.
   * @param ids - The ids of every Upload gone.
   */
  const lose = (...ids: readonly string[]) => {
    daemon.uploadsMissing.splice(0, daemon.uploadsMissing.length, ...ids);

    for (const follower of uploadFollowers) {
      follower.controller.enqueue(encoder.encode(missingText()));
    }
  };

  /**
   * Holds a new Upload, newest of all, and sends it to every follower of the Uploads'
   * Changes, as another device's upload would, at the next sequence, which a follower
   * resuming before it is sent too.
   * @param added - The Upload, as the wire carries it.
   */
  const upload = (added: typeof Upload.Encoded) => {
    uploads.unshift(added);
    changedUpload(added);
  };

  /**
   * Expires an Upload held, as the Daemon does once it is old: marked deleted, why
   * `expired`, with no link, and sent to every follower of the Uploads' Changes as it is now.
   * @param id - The Upload's id.
   */
  const expire = (id: string) => {
    const at = uploads.findIndex((held) => held.id === id && held.deleted === undefined);
    const was = uploads[at];

    if (was === undefined) {
      throw new Error(`no live Upload ${id}`);
    }

    const now: typeof Upload.Encoded = {
      ...was,
      deleted: { at: 1_700_000_002_000, why: "expired" },
      link: null,
    };

    uploads[at] = now;
    changedUpload(now);
  };

  /**
   * A file sent to be kept: refused as the next of `uploadRefusals` says, or kept as an
   * Upload, newest of all, its link made from `uploads.publicUrl` in force, or `null`
   * without one.
   * @param url - The request's URL.
   * @param init - The request.
   * @returns The answer.
   */
  const uploaded = async (url: URL, init: RequestInit): Promise<Response> => {
    if (!daemon.signedIn) {
      return json(401, { _tag: "Unauthorized" });
    }

    const name = url.searchParams.get("name");
    const { size } = await new Response(init.body).blob();

    uploadsSent.push({ name, size });

    const refusal = uploadRefusals.shift();

    if (refusal !== undefined) {
      return Response.json(refusal.body, { status: refusal.status });
    }

    const id = String(daemon.nextSequence).padStart(16, "0");
    const safeName = name ?? "file.bin";
    const publicUrl = daemon.owner.options["uploads.publicUrl"];

    const added: typeof Upload.Encoded = {
      at: 1_700_000_000_000,
      hash: "0".repeat(64),
      id,
      link: publicUrl === undefined ? null : `${publicUrl}/${id}/${safeName}`,
      safeName,
      said: [],
      size,
      type: "image/png",
    };

    const named = name === null ? added : { ...added, name };

    upload(named);

    return Response.json(named);
  };

  /**
   * A rename or a delete of an Upload: refused as the next of `uploadEditRefusals` says, or
   * `UnknownUpload` for one not held or deleted, and otherwise done, its name and safe name
   * the one given, or marked deleted by the Owner with no link, and sent to every follower
   * of the Uploads' Changes as it is now.
   * @param method - `PATCH` or `DELETE`.
   * @param id - The Upload's id.
   * @param init - The request.
   * @returns The answer.
   */
  const editedUpload = async (
    method: "PATCH" | "DELETE",
    id: string,
    init: RequestInit
  ): Promise<Response> => {
    if (!daemon.signedIn) {
      return json(401, { _tag: "Unauthorized" });
    }

    const name =
      method === "PATCH" ? decodeRename(await new Response(init.body).text()).name : undefined;

    uploadEdits.push(name === undefined ? { id, method } : { id, method, name });

    const refusal = uploadEditRefusals.shift();

    if (refusal !== undefined) {
      return Response.json(refusal.body, { status: refusal.status });
    }

    const at = uploads.findIndex((held) => held.id === id && held.deleted === undefined);
    const was = uploads[at];

    if (was === undefined) {
      return json(404, { _tag: "UnknownUpload", id });
    }

    const publicUrl = daemon.owner.options["uploads.publicUrl"];

    const now: typeof Upload.Encoded =
      name === undefined
        ? { ...was, deleted: { at: 1_700_000_001_000, why: "owner" }, link: null }
        : {
            ...was,
            link: publicUrl === undefined ? null : `${publicUrl}/${id}/${name}`,
            name,
            renamedAt: 1_700_000_001_000,
            safeName: name,
          };

    uploads[at] = now;
    changedUpload(now);

    return Response.json(now);
  };

  /**
   * One Upload, as held, or 404 for an id none has, or nothing for any other route.
   * @param url - The request's URL.
   * @param init - The request.
   * @returns The answer, or nothing.
   */
  const uploadRoute = (url: URL, init: RequestInit): Response | undefined => {
    const id = /^\/api\/uploads\/(?<id>[0-9a-z]{16})$/u.exec(url.pathname)?.groups?.id;

    if ((init.method ?? "GET") !== "GET" || id === undefined) {
      return undefined;
    }

    return signedInOnly(() => {
      const held = uploads.find((each) => each.id === id);

      return held === undefined ? json(404, { _tag: "UnknownUpload", id }) : Response.json(held);
    });
  };

  /**
   * The Uploads: a page of them, newest first, from just after one, refusing a cursor that
   * names none held, through the last Change `upload` made, or `0`; their Changes, each
   * `upload` made after `Last-Event-ID` or `after`, then live, or live from now with
   * neither; and an Upload's bytes, or nothing for any other route. Uploads a test holds
   * from the start were made before any Change the fake replays.
   * @param url - The request's URL.
   * @param init - The request.
   * @returns The answer, or nothing.
   */
  const uploadsRoute = async (url: URL, init: RequestInit): Promise<Response | undefined> => {
    const method = init.method ?? "GET";
    const content = /^\/api\/uploads\/(?<id>[^/]+)\/content$/u.exec(url.pathname)?.groups;
    const one = /^\/api\/uploads\/(?<id>[0-9a-z]{16})$/u.exec(url.pathname)?.groups;

    if (method === "POST" && url.pathname === "/api/uploads") {
      return await uploaded(url, init);
    }

    if ((method === "PATCH" || method === "DELETE") && one?.id !== undefined) {
      return await editedUpload(method, one.id, init);
    }

    if (method !== "GET") {
      return undefined;
    }

    if (url.pathname === "/api/uploads/status") {
      daemon.statusesRead += 1;

      if (daemon.holdUploadsStatus) {
        await heldUntilReleased(daemon.statusesHeld, init);
      }

      return signedInOnly(() => Response.json(daemon.uploadsStatus));
    }

    if (url.pathname === "/api/uploads/changes") {
      const headers = new Headers(init.headers);
      const after = headers.get("last-event-id") ?? url.searchParams.get("after");

      const replayed =
        after === null
          ? []
          : uploadChanges.flatMap((one) => (one.sequence > Number(after) ? [one.text] : []));

      return signedInOnly(() =>
        following(uploadFollowers, url, headers, init, [missingText(), ...replayed])
      );
    }

    if (url.pathname === "/api/uploads") {
      // The page is taken as the request arrives, and a held one is only delivered late, so
      // what is made meanwhile is in no page and reaches the list only by the stream.
      const answer = signedInOnly(() => {
        const after = url.searchParams.get("after") ?? undefined;
        const limit = Number(url.searchParams.get("limit") ?? daemon.uploadsPage);

        const live = uploads.filter(
          (one) => url.searchParams.get("deleted") === "true" || one.deleted === undefined
        );

        const start = after === undefined ? 0 : live.findIndex((one) => one.id === after) + 1;

        uploadPagesRead.push(after);

        if (start === 0 && after !== undefined) {
          return Response.json({ _tag: "InvalidRequest", issues: [] }, { status: 400 });
        }

        const page = live.slice(start, start + limit);
        const more = start + limit < live.length;

        return Response.json({
          more,
          next: more ? (page.at(-1)?.id ?? null) : null,
          through: uploadChanges.at(-1)?.sequence ?? 0,
          uploads: page,
        });
      });

      if (daemon.holdUploadPages) {
        await heldUntilReleased(uploadPagesHeld, init);
      }

      return answer;
    }

    if (content?.id !== undefined) {
      const { id } = content;

      return signedInOnly(() =>
        uploads.some((one) => one.id === id && one.deleted === undefined)
          ? new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
              headers: { "content-type": "application/octet-stream" },
            })
          : json(404, { _tag: "UnknownUpload", id })
      );
    }

    return undefined;
  };

  /**
   * A Lookup asked after by its intent: `Pending` as many times as it was given, then
   * `LookedUp`, or `NotJournaled` for one never journaled. It waits until a test releases it
   * when `holdLooked` says.
   * @param intent - Its intent.
   * @param init - The request.
   * @returns The answer.
   */
  const askedAfter = async (intent: string, init: RequestInit) => {
    daemon.looked.push(intent);

    if (daemon.holdLooked) {
      await heldUntilReleased(daemon.lookedHeld, init);
    }

    const held = daemon.lookups.get(intent);

    if (held === undefined) {
      return json(200, { _tag: "NotJournaled" });
    }

    if (held.pending > 0) {
      held.pending -= 1;

      return json(200, { _tag: "Pending", intent, sequence: held.sequence });
    }

    return json(200, { _tag: "LookedUp", intent, result: held.result, sequence: held.sequence });
  };

  /**
   * A `look`, answered as the next of `lookScripts` says, and a Lookup asked after by its
   * intent, or nothing for any other route.
   * @param url - The request's URL.
   * @param init - The request.
   * @returns The answer, or nothing.
   */
  const lookupRoute = async (url: URL, init: RequestInit): Promise<Response | undefined> => {
    const method = init.method ?? "GET";

    const one = /^\/api\/networks\/(?<network>[^/]+)\/lookups(?:\/(?<intent>[^/]+))?$/u.exec(
      url.pathname
    )?.groups;

    if (one?.network === undefined) {
      return undefined;
    }

    if (!daemon.signedIn) {
      return json(401, { _tag: "Unauthorized" });
    }

    const { intent, network } = one;

    if (method === "GET" && intent !== undefined) {
      return await askedAfter(intent, init);
    }

    const body = Schema.decodeSync(LookBody)(await new Response(init.body).text());
    const named = body.intent ?? `daemon-${daemon.nextSequence}`;

    const script = daemon.lookScripts.shift() ?? {
      answer: "LookedUp",
      pending: 0,
      result: { _tag: "NotFound", notes: [], reply: "401" },
    };

    daemon.looks.push({ ...body, network });

    if (script.answer === "UnknownNetwork") {
      return json(404, { _tag: "UnknownNetwork", network });
    }

    const sequence = daemon.nextSequence;

    if (script.answer !== "NetworkStopped") {
      daemon.lookups.set(named, { pending: script.pending, result: script.result, sequence });
      daemon.nextSequence += 1;
    }

    // A Daemon that journaled the Lookup and is slow to answer, until a test releases it.
    if (daemon.holdLooks) {
      await heldUntilReleased(daemon.looksHeld, init);
    }

    switch (script.answer) {
      case "Lost": {
        throw new TypeError("fetch failed");
      }

      case "NetworkStopped":
      case "NetworkStoppedJournaled": {
        return json(503, {
          _tag: "NetworkStopped",
          intent: named,
          network,
          outcome: "Uncertain",
          reason: "stopped",
        });
      }

      case "Pending": {
        return json(200, { _tag: "Pending", intent: named, sequence });
      }

      case "LookedUp": {
        return json(200, { _tag: "LookedUp", intent: named, result: script.result, sequence });
      }

      default: {
        return script.answer satisfies never;
      }
    }
  };

  /**
   * Removing a Network, or nothing for any other route.
   * @param url - The request's URL.
   * @param init - The request.
   * @returns The answer, or nothing.
   */
  const removeRoute = (url: URL, init: RequestInit): Response | undefined => {
    const whole = /^\/api\/networks\/(?<network>[^/]+)$/u.exec(url.pathname)?.groups;

    if (init.method !== "DELETE" || whole?.network === undefined) {
      return undefined;
    }

    const { network } = whole;

    return signedInOnly(() =>
      remove(network, url.searchParams.get("keep") === "true", Number(url.searchParams.get("life")))
    );
  };

  /**
   * Sends an item to every follower of the stream of Previews, as one `changed` event.
   * @param item - The item, as the wire carries it.
   */
  const sendPreview = (item: typeof PreviewItem.Encoded) => {
    const text = `event: changed\ndata: ${JSON.stringify(item)}\n\n`;

    for (const follower of previewFollowers) {
      follower.controller.enqueue(encoder.encode(text));
    }
  };

  /**
   * A press of a link waiting for one, which the fake answers as pending, holding it so
   * until a test sends its change, and refuses as `NotWaiting` for any other link.
   * @param timeline - The Message's Timeline.
   * @param init - The request.
   * @returns The answer.
   */
  const pressRoute = async (timeline: string, init: RequestInit): Promise<Response> => {
    const { link, position } = Schema.decodeSync(PressBody)(await new Response(init.body).text());

    daemon.presses.push({ link, position, timeline });

    const items = daemon.previews.get(position);
    const item = items?.[link];

    if (items === undefined || item?.state._tag !== "WaitingForPress") {
      return Response.json({ _tag: "NotWaiting", link, position, timeline }, { status: 409 });
    }

    const fetching = { ...item, state: { _tag: "Pending" } } as const;

    daemon.previews.set(
      position,
      items.map((one, index) => (index === link ? fetching : one))
    );

    return Response.json(fetching);
  };

  /**
   * A Message's Previews asked for, refused while `ui.previews` is `off`, and their stream,
   * or nothing for any other route.
   * @param url - The request's URL.
   * @param init - The request.
   * @returns The answer, or nothing.
   */
  const previewsRoute = async (url: URL, init: RequestInit): Promise<Response | undefined> => {
    const ask = /^\/api\/timelines\/(?<timeline>[0-9a-f-]+)\/previews$/u.exec(url.pathname)?.groups;

    const pressed = /^\/api\/timelines\/(?<timeline>[0-9a-f-]+)\/previews\/press$/u.exec(
      url.pathname
    )?.groups;

    if (init.method === "POST" && pressed?.timeline !== undefined) {
      return daemon.signedIn
        ? await pressRoute(pressed.timeline, init)
        : json(401, { _tag: "Unauthorized" });
    }

    if (url.pathname === "/api/previews/changes") {
      return signedInOnly(() => following(previewFollowers, url, new Headers(init.headers), init));
    }

    if (init.method !== "POST" || ask?.timeline === undefined) {
      return undefined;
    }

    if (!daemon.signedIn) {
      return json(401, { _tag: "Unauthorized" });
    }

    const { timeline } = ask;
    const { position } = Schema.decodeSync(PreviewsBody)(await new Response(init.body).text());

    daemon.previewAsks.push({ position, timeline });

    if (daemon.ui.options.previews === "off") {
      return Response.json({ _tag: "PreviewsOff", timeline }, { status: 409 });
    }

    const previews = daemon.previews.get(position);

    return previews === undefined
      ? Response.json({ _tag: "UnknownMessage", position, timeline }, { status: 404 })
      : Response.json({ previews });
  };

  const elsewhere = async (url: URL, init: RequestInit) =>
    (await previewsRoute(url, init)) ??
    removeRoute(url, init) ??
    (await lookupRoute(url, init)) ??
    (await uiRoute(url, init)) ??
    (await ownerRoute(url, init)) ??
    uploadRoute(url, init) ??
    (await uploadsRoute(url, init)) ??
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
            [...new Set([...daemon.timelines.keys(), ...daemon.kept])].map((network) =>
              daemon.kept.has(network)
                ? { _tag: "Kept", life: daemon.lives.get(network) ?? 1, network }
                : {
                    _tag: "Live",
                    life: daemon.lives.get(network) ?? 1,
                    network,
                    status: { _tag: "Running" },
                  }
            )
          )
        );
      }

      case "POST /api/networks/libera/read": {
        return await markRead(init);
      }

      case "POST /api/networks/libera/close": {
        return await close("libera", init);
      }

      case "POST /api/networks/libera/act": {
        if (!daemon.signedIn) {
          return json(401, { _tag: "Unauthorized" });
        }

        const body = Schema.decodeSync(ActBody)(await new Response(init.body).text());

        daemon.acts.push(body);

        if (daemon.holdActs) {
          await heldUntilReleased(daemon.actsHeld, init);
        }

        return stepped(body.intent, "Acted");
      }

      case "POST /api/networks/libera/say": {
        if (!daemon.signedIn) {
          return json(401, { _tag: "Unauthorized" });
        }

        const body = Schema.decodeSync(SayBody)(await new Response(init.body).text());

        daemon.says.push(body);

        if (daemon.holdSays) {
          const { promise, resolve } = Promise.withResolvers<undefined>();

          saysHeld.push(() => {
            resolve(undefined);
          });
          await promise;
        }

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
    const match = /\/(?<timeline>[^/]+)\/(?<what>channel|members|known)$/u.exec(url.pathname);
    const kind = match?.groups?.what;

    if (kind === "channel") {
      channelsAsked.push(match?.groups?.timeline ?? "");
    }

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

    // A Daemon that holds each read of a Network's Timelines until a test releases it, and
    // then answers with the Timelines it holds by then.
    if (daemon.holdLists && /^\/api\/networks\/[^/]+\/timelines$/u.test(url.pathname)) {
      const { promise, resolve } = Promise.withResolvers<undefined>();

      daemon.listsHeld.push(() => {
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

  return {
    daemon,
    endStreams,
    expire,
    fetch,
    lose,
    send,
    sendPreview,
    sendUi,
    stopProjection,
    upload,
  };
};

/**
 * A registry whose runtime reaches the fake Daemon through `fetch`.
 * @param fetch - The fake's `fetch`.
 * @param waits - Waits other than a test's defaults, such as how long the changes stream
 * may give nothing before it is followed again.
 * @param notifier - The notifications' host, a test's, which shows none by default.
 * @param reader - The reader of themes, which reads at once, in the page, by default.
 * @param uploader - The sender of files, which hands each to `fetch` at once by default.
 * @param clock - The runtime's clock, which is the world's unless a test holds one.
 * @returns The registry.
 */
export const registryFor = (
  fetch: typeof globalThis.fetch,
  waits: Partial<WaitTimes> = {},
  notifier: NotifierPort = testNotifier().port,
  reader: ThemeReaderPort = instantThemeReader,
  uploader: UploaderPort = testUploader(fetch).port,
  clock?: Clock.Clock
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
            lookRequest: "500 millis",
            lookup: "1 second",
            reconnect: "10 millis",
            retry: "10 millis",
            settle: "50 millis",
            ...waits,
          }),
          Layer.succeed(Notifier, notifier),
          Layer.succeed(ThemeReader, reader),
          Layer.succeed(Uploader, uploader),
          clock === undefined ? Layer.empty : Layer.succeed(Clock.Clock, clock),
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
 * A clock that stands still, for a registry's runtime, so that no wait in it ends until the
 * test says time has passed.
 * @returns The clock, at its start.
 */
export const heldClock = () =>
  Effect.runSync(
    // It would print that time stands still, a moment after the first wait.
    TestClock.make({ warningDelay: "1 hour" }).pipe(Scope.provide(Scope.makeUnsafe()))
  );

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

// How long a wait lasts before it is a failure, in milliseconds. It is for a hang, never for
// a slow machine: two runs at once make a test several times slower, and that is no failure.
const waitLimit = 20_000;

/**
 * Waits until an atom's value holds, reading it each time it changes.
 * @param registry - The registry.
 * @param atom - The atom.
 * @param holds - What must hold.
 * @returns The value that held, or a rejection after twenty seconds.
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
  }, waitLimit);

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
 * @returns Once it does, or a rejection after twenty seconds.
 */
export const eventually = async (holds: () => boolean): Promise<void> => {
  for (let waited = 0; waited < waitLimit; waited += 5) {
    if (holds()) {
      return;
    }

    // oxlint-disable-next-line no-await-in-loop -- looking again until it holds
    await Effect.runPromise(Effect.sleep("5 millis"));
  }

  throw new Error("it never held");
};

/**
 * Moves a held clock on, a second at each look, until something the fake holds is so.
 * @param clock - The clock.
 * @param holds - What must hold.
 * @returns Once it does, or a rejection after twenty seconds.
 */
export const passing = async (clock: TestClock.TestClock, holds: () => boolean): Promise<void> => {
  await eventually(() => {
    if (holds()) {
      return true;
    }

    Effect.runFork(clock.adjust("1 second"));

    return false;
  });
};
