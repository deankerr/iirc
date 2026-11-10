/**
 * The handlers of {@link DaemonApi}: each operation, over the Runtime and the Vault, with
 * its errors mapped to the contract's, plus the key and sign-in check, signing a browser
 * in and out, request validation, and the body limit.
 *
 * @packageDocumentation
 */
import {
  Authorization,
  Caller,
  ConfigurationChanged,
  CrossOrigin,
  DaemonApi,
  InvalidRequest,
  JournalFailed,
  NetworkId as WireNetworkId,
  NetworkStopped,
  NotAChannel,
  NotInChannel,
  RequestValidation,
  Sequence as WireSequence,
  SignInsFailed,
  signInCookie,
  TimelinesFailed,
  Unauthorized,
  UnknownNetwork,
  UnknownTimeline,
  VaultFailed,
  windowLimit,
} from "@iirc/api";
import type { NewsEvent, TimelineChangesEvent, WindowQuery } from "@iirc/api";
import { IntentId } from "@iirc/client";
import { Runtime } from "@iirc/runtime";
import type { NetworkStopped as RuntimeNetworkStopped } from "@iirc/runtime";
import { NetworkId, Sequence } from "@iirc/runtime/journal";
import type { JournalFailed as RuntimeJournalFailed } from "@iirc/runtime/journal";
import { Vault } from "@iirc/runtime/vault";
import type { VaultFailed as RuntimeVaultFailed } from "@iirc/runtime/vault";
import { TimelineStore } from "@iirc/timeline-store";
import type { Anchor, Changed, TimelineStoreFailed, Window } from "@iirc/timeline-store";
import type { TimelineId } from "@iirc/timelines";
import {
  ByteSize,
  Context,
  Duration,
  Effect,
  Layer,
  Option,
  Predicate,
  Random,
  Redacted,
  Schedule,
  SchemaIssue,
  Stream,
} from "effect";
import {
  HttpEffect,
  HttpIncomingMessage,
  HttpRouter,
  HttpServerError,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import { HttpApiBuilder, HttpApiMiddleware } from "effect/http-api";

import { ApiKeys } from "./keys.ts";
import { membersPage, rankOrder } from "./members.ts";
import { Projector } from "./projector.ts";
import type { Progress } from "./projector.ts";
import { SignIns } from "./sign-ins.ts";
import type { SignInsUnwritable } from "./sign-ins.ts";
import {
  channelHeader,
  gap,
  happened,
  knowledge,
  member,
  networkInspection,
  networkStatus,
  projection,
  throughOf,
  timeline,
  timelineItem,
  tombstone,
  versionOf,
  windowGap,
} from "./wire.ts";

/** The largest request body the API reads. Anything larger is refused before it is read. */
export const maxBodySize = ByteSize.mebibytes(1);

/** How often the News stream says it is alive while nothing happens. */
export class Heartbeat extends Context.Reference<Duration.Duration>("@iirc/daemon/Heartbeat", {
  defaultValue: () => Duration.seconds(15),
}) {}

const networkStopped = (network: WireNetworkId, error: RuntimeNetworkStopped, intent?: IntentId) =>
  new NetworkStopped({
    network,
    outcome: "Uncertain",
    reason: error.reason,
    ...(intent !== undefined && { intent }),
  });

const journalFailed = (error: RuntimeJournalFailed) => new JournalFailed({ reason: error.reason });

const vaultFailed = (error: RuntimeVaultFailed) => new VaultFailed({ reason: error.reason });

const signInsFailed = (error: SignInsUnwritable) => new SignInsFailed({ reason: error.reason });

const unknownNetwork = (error: { readonly network: NetworkId }) =>
  new UnknownNetwork({ network: error.network });

const timelinesFailed = (error: TimelineStoreFailed) =>
  new TimelinesFailed({ reason: error.reason });

// 128 bits from Effect's Random, as hex. An intent id is unique, not secret. The Daemon
// names it rather than the Runtime, so a `NetworkStopped` can say which to ask `said` about.
const intentId = Effect.map(
  Effect.all(Array.from({ length: 8 }, () => Random.nextIntBetween(0, 0xff_ff))),
  (parts) => IntentId.make(parts.map((part) => part.toString(16).padStart(4, "0")).join(""))
);

// Messages that never quote what was sent, since a request can carry a Credential's value.
const leafHook: SchemaIssue.LeafHook = (issue) =>
  Predicate.hasProperty(issue, "input")
    ? {
        Forbidden: "Forbidden operation",
        InvalidType: "Has the wrong type",
        InvalidValue: "Is not a valid value",
        MissingKey: "Missing key",
        OneOf: "Expected exactly one member to match",
        UnexpectedKey: "Expected no excess property",
      }[issue._tag]
    : SchemaIssue.defaultLeafHook(issue);

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1({ leafHook });

const segment = (part: PropertyKey | { readonly key: PropertyKey }): string | number => {
  const key = Predicate.hasProperty(part, "key") ? part.key : part;

  return Predicate.isNumber(key) ? key : String(key);
};

// Only what a Frontend sent can be a bad request. A response that will not encode is the
// Daemon's fault, and keeps its 500.
const requestValidation = HttpApiMiddleware.layerSchemaErrorTransform(RequestValidation, (error) =>
  error.kind === "Body" || error.kind === "ResponseHeaders"
    ? Effect.fail(error)
    : Effect.fail(
        new InvalidRequest({
          issues: formatIssues(error.cause.issue).issues.map((issue) => ({
            message: issue.message,
            path: [error.kind.toLowerCase(), ...(issue.path ?? []).map(segment)],
          })),
        })
      )
);

/** How long a browser keeps its sign-in's cookie: 400 days, the most a browser allows. */
const signInLifetime = Duration.days(400);

/** The methods that change nothing, which another site may send with the cookie. */
const safeMethods: ReadonlySet<string> = new Set(["GET", "HEAD"]);

/**
 * Whether a browser says a request came from the Daemon's own origin: `Sec-Fetch-Site`,
 * or, from a browser that does not send it, `Origin` against the request's own host. A
 * request with neither did not come from a browser, which presents a bearer key instead.
 * @param request - The request.
 * @returns Whether it is same-origin.
 */
const fromOwnOrigin = (request: HttpServerRequest.HttpServerRequest): boolean => {
  const { host, origin, "sec-fetch-site": site } = request.headers;

  if (site !== undefined) {
    return site === "same-origin";
  }

  return (
    host !== undefined && origin !== undefined && URL.parse(origin)?.host === host.toLowerCase()
  );
};

/**
 * Whether a request reached the Owner's reverse proxy over TLS, as it says in
 * `X-Forwarded-Proto`. The API listens on loopback only, so the header comes from the
 * Owner's own software (ADR 0006). The first value is the hop nearest the browser.
 * @param request - The request.
 * @returns Whether the browser's connection was TLS.
 */
const overTls = (request: HttpServerRequest.HttpServerRequest): boolean =>
  request.headers["x-forwarded-proto"]?.split(",")[0]?.trim().toLowerCase() === "https";

// `Secure` only over TLS: WebKit refuses a `Secure` cookie over http://localhost.
const cookieOptions = (request: HttpServerRequest.HttpServerRequest) =>
  ({ httpOnly: true, path: "/api", sameSite: "strict", secure: overTls(request) }) as const;

// A bearer key wins when both come, and is never checked for its origin: only a browser
// sends a cookie on its own.
const authorization = Layer.effect(
  Authorization,
  Effect.gen(function* () {
    const keys = yield* ApiKeys;
    const signIns = yield* SignIns;

    return {
      bearer: (handler, { credential }) =>
        Effect.gen(function* () {
          const found = yield* keys.verify(credential);

          if (Option.isNone(found)) {
            return yield* new Unauthorized();
          }

          return yield* Effect.provideService(handler, Caller, { key: found.value.name });
        }),
      signIn: (handler, { credential }) =>
        Effect.gen(function* () {
          const found = yield* signIns.verify(credential);

          if (Option.isNone(found)) {
            return yield* new Unauthorized();
          }

          const request = yield* HttpServerRequest.HttpServerRequest;

          if (!safeMethods.has(request.method) && !fromOwnOrigin(request)) {
            return yield* new CrossOrigin();
          }

          return yield* Effect.provideService(handler, Caller, { key: found.value });
        }),
    };
  })
);

/**
 * Refuses a request a browser did not send from the Daemon's own origin.
 * @param request - The request.
 * @returns An Effect that fails with {@link CrossOrigin} unless it is same-origin.
 */
const requireOwnOrigin = (request: HttpServerRequest.HttpServerRequest) =>
  fromOwnOrigin(request) ? Effect.void : Effect.fail(new CrossOrigin());

// Signing in and out are checked for their origin like any request the cookie carries, so
// another site can neither sign a browser in to a key of its choosing nor sign it out.
const signIn = HttpApiBuilder.group(
  DaemonApi,
  "signIn",
  Effect.fn(function* (handlers) {
    const keys = yield* ApiKeys;
    const signIns = yield* SignIns;

    return handlers
      .handle("signIn", ({ payload, request }) =>
        Effect.gen(function* () {
          yield* requireOwnOrigin(request);

          const key = yield* keys.verify(payload.key).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.fail(new Unauthorized()),
                onSome: Effect.succeed,
              })
            )
          );

          const token = yield* signIns.start(key).pipe(Effect.mapError(signInsFailed));

          yield* HttpApiBuilder.securitySetCookie(Authorization.security.signIn, token, {
            ...cookieOptions(request),
            maxAge: signInLifetime,
          });
          yield* Effect.logInfo("Signed a browser in", { key: key.name });
        })
      )
      .handle("signOut", ({ request }) =>
        Effect.gen(function* () {
          yield* requireOwnOrigin(request);

          const presented = request.cookies[signInCookie];

          if (presented !== undefined) {
            const ended = yield* signIns
              .end(Redacted.make(presented))
              .pipe(Effect.mapError(signInsFailed));

            if (Option.isSome(ended)) {
              yield* Effect.logInfo("Signed a browser out", { key: ended.value });
            }
          }

          yield* HttpEffect.appendPreResponseHandler((_, response) =>
            Effect.orDie(
              HttpServerResponse.expireCookie(response, signInCookie, cookieOptions(request))
            )
          );
        })
      );
  })
);

const networks = HttpApiBuilder.group(
  DaemonApi,
  "networks",
  Effect.fn(function* (handlers) {
    const runtime = yield* Runtime;

    return handlers
      .handle("list", () =>
        runtime.networks.pipe(
          Effect.map((all) =>
            Array.from(all, ([network, status]) => ({ network, status: networkStatus(status) }))
          )
        )
      )
      .handle("configure", ({ params, payload, query }) =>
        runtime
          .configure(
            NetworkId.make(params.network),
            payload,
            query.ifSequence === undefined || query.ifSequence === 0
              ? query.ifSequence
              : Sequence.make(query.ifSequence)
          )
          .pipe(
            Effect.map((sequence) => ({ sequence })),
            Effect.catchTags({
              ConfigurationChanged: (error) =>
                Effect.fail(
                  new ConfigurationChanged({ network: params.network, sequence: error.sequence })
                ),
              NetworkStopped: (error) => Effect.fail(networkStopped(params.network, error)),
            })
          )
      )
      .handle("configuration", ({ params }) =>
        runtime.configuration(NetworkId.make(params.network)).pipe(Effect.mapError(unknownNetwork))
      )
      .handle("say", ({ params, payload }) =>
        Effect.gen(function* () {
          const intent = payload.intent ?? (yield* intentId);

          return yield* runtime
            .say(NetworkId.make(params.network), {
              intent,
              kind: payload.kind,
              target: payload.target,
              text: payload.text,
            })
            .pipe(
              Effect.catchTags({
                NetworkStopped: (error) =>
                  Effect.fail(networkStopped(params.network, error, intent)),
                UnknownNetwork: (error) => Effect.fail(unknownNetwork(error)),
              })
            );
        })
      )
      .handle("said", ({ params }) =>
        runtime.said(NetworkId.make(params.network), params.intent).pipe(
          Effect.map(
            Option.match({
              onNone: () => ({ _tag: "NotJournaled" }) as const,
              onSome: (sequence) => ({ _tag: "Journaled", sequence }) as const,
            })
          ),
          Effect.mapError(journalFailed)
        )
      )
      .handle("read", ({ params, payload }) =>
        runtime
          .read(NetworkId.make(params.network), { read: payload.read, target: payload.target })
          .pipe(
            Effect.map((sequence) => ({ sequence })),
            Effect.catchTags({
              NetworkStopped: (error) => Effect.fail(networkStopped(params.network, error)),
              UnknownNetwork: (error) => Effect.fail(unknownNetwork(error)),
            })
          )
      )
      .handle("retry", ({ params }) =>
        runtime.retry(NetworkId.make(params.network)).pipe(
          Effect.map((sequence) => ({ sequence })),
          Effect.catchTags({
            NetworkStopped: (error) => Effect.fail(networkStopped(params.network, error)),
            UnknownNetwork: (error) => Effect.fail(unknownNetwork(error)),
          })
        )
      )
      .handle("known", ({ params }) =>
        runtime
          .known(NetworkId.make(params.network))
          .pipe(Effect.map(knowledge), Effect.mapError(unknownNetwork))
      )
      .handle("inspect", ({ params }) =>
        runtime
          .inspect(NetworkId.make(params.network))
          .pipe(Effect.map(networkInspection), Effect.mapError(unknownNetwork))
      );
  })
);

const news = HttpApiBuilder.group(
  DaemonApi,
  "news",
  Effect.fn(function* (handlers) {
    const runtime = yield* Runtime;

    return handlers.handle("follow", ({ headers, query }) =>
      Effect.gen(function* () {
        const every = yield* Heartbeat;
        // A reconnecting `EventSource` sends `Last-Event-ID` with the URL it first used,
        // so the header is the later place and wins.
        const after = headers["last-event-id"] ?? query.after ?? 0;

        const happenings = runtime.news(after === 0 ? {} : { after: Sequence.make(after) }).pipe(
          Stream.map((one): NewsEvent => ({
            data: happened(one),
            event: "happened",
            id: one.sequence,
          })),
          Stream.mapError(journalFailed)
        );

        const heartbeats = Stream.fromSchedule(Schedule.spaced(every)).pipe(
          Stream.map((): NewsEvent => ({ data: {}, event: "heartbeat" }))
        );

        return Stream.merge(happenings, heartbeats, { haltStrategy: "left" });
      })
    );
  })
);

/**
 * How many things one event of the Timelines' changes holds at most: a page of whole steps,
 * or one step bigger than that given as overflowed.
 */
export class ChangesPage extends Context.Reference<number>("@iirc/daemon/ChangesPage", {
  defaultValue: () => 500,
}) {}

/**
 * Where a window is read from: the one place a query gives, or the latest without one.
 * @param query - The window's query, which gives at most one place.
 * @returns The anchor.
 */
const anchorOf = (query: WindowQuery): Anchor => {
  if (query.around !== undefined) {
    return { _tag: "Around", position: query.around };
  }

  if (query.after !== undefined) {
    return { _tag: "After", position: query.after };
  }

  return { _tag: "Before", position: query.before };
};

/**
 * The positions a window spans, open on a side with nothing more beyond it, so the Gaps
 * read with it include one before its first item or after its last, split at its items.
 * A window read before or after a cursor reaches the cursor on that side, so it gives the
 * run of Gaps between its items and the cursor too: those that ended before the cursor, or
 * began after it, since one that reaches the cursor is the window's holding the cursor's
 * item.
 * @param window - The window.
 * @param anchor - Where it was read from.
 * @returns The range of positions to find Gaps in, the items' positions, and the cursor.
 */
const spanOf = (window: Window, anchor: Anchor) => {
  const at = window.items.map((item) => item.position);
  const first = window.items[0]?.position;
  const last = window.items.at(-1)?.position;

  if (anchor._tag === "Before" && anchor.position !== undefined && window.later) {
    return {
      at,
      endedBefore: anchor.position,
      from: window.earlier ? (first ?? anchor.position) : undefined,
    };
  }

  if (anchor._tag === "After" && window.earlier) {
    return {
      at,
      beganAfter: anchor.position,
      to: window.later ? (last ?? anchor.position) : undefined,
    };
  }

  return {
    at,
    from: window.earlier ? (first ?? anchor.position) : undefined,
    to: window.later ? (last ?? anchor.position) : undefined,
  };
};

/**
 * Whether something was last changed by a step.
 * @param sequence - The step.
 * @returns Whether a thing's last change was that step.
 */
const at =
  (sequence: number) =>
  ({ changed }: { readonly changed: number }) =>
    changed === sequence;

/**
 * What changed, one event for each step, in order, each list in the order the store gives,
 * or the one step too big for a page, as overflowed.
 * @param changed - What the store says changed.
 * @param version - The projection version it was folded by.
 * @returns The events.
 */
const eventsOf = (changed: Changed, version: number): readonly TimelineChangesEvent[] => {
  if (changed.overflowed !== undefined) {
    const { sequence, timelines: touched } = changed.overflowed;

    return [
      {
        data: { sequence: WireSequence.make(sequence), timelines: touched ?? null },
        event: "overflowed",
        id: { sequence, version },
      },
    ];
  }

  const sequences = [
    ...new Set(
      [...changed.timelines, ...changed.items, ...changed.merged, ...changed.gaps].map(
        (each) => each.changed
      )
    ),
  ].toSorted((left, right) => left - right);

  return sequences.map((sequence): TimelineChangesEvent => ({
    data: {
      gaps: changed.gaps.filter(at(sequence)).map(gap),
      items: changed.items.filter(at(sequence)).map(timelineItem),
      merged: changed.merged.filter(at(sequence)).map(tombstone),
      sequence: WireSequence.make(sequence),
      timelines: changed.timelines.filter(at(sequence)).map(timeline),
    },
    event: "changed",
    id: { sequence, version },
  }));
};

/**
 * Where a follower of the changes is: the projection version it holds, or `undefined` when
 * it holds nothing yet, the last sequence it has, whether it has read all there was, and
 * the projector's progress it last woke on, or `undefined` before it has waited.
 */
interface Place {
  readonly version: number | undefined;
  readonly after: number;
  readonly wait: boolean;
  readonly seen: Progress | undefined;
}

const timelines = HttpApiBuilder.group(
  DaemonApi,
  "timelines",
  Effect.fn(function* (handlers) {
    const runtime = yield* Runtime;
    const store = yield* TimelineStore;
    const projector = yield* Projector;
    const page = yield* ChangesPage;

    const known = (network: WireNetworkId) =>
      runtime.networks.pipe(
        Effect.flatMap((all) =>
          all.has(NetworkId.make(network))
            ? Effect.void
            : Effect.fail(new UnknownNetwork({ network }))
        )
      );

    // A Channel's Timeline, and the Channel as the Client knows it now, found by the
    // Timeline's name folded with the Connection's casemapping, or none when the Client
    // holds no such Channel.
    const channelOf = (id: TimelineId) =>
      Effect.gen(function* () {
        const found = yield* store.timeline(id).pipe(Effect.mapError(timelinesFailed));

        if (Option.isNone(found)) {
          return yield* new UnknownTimeline({ timeline: id });
        }

        const timeline = found.value;

        if (timeline.kind !== "Channel") {
          return yield* new NotAChannel({ kind: timeline.kind, timeline: timeline.id });
        }

        const view = yield* runtime
          .channel(NetworkId.make(timeline.network), timeline.name)
          .pipe(Effect.catchTag("UnknownNetwork", () => Effect.succeedNone));

        return { timeline, view };
      });

    // Waits until the projector says anything other than what was last seen: a step folded,
    // or the store reset to a version, whatever its sequence. It never polls the store.
    const progressSince = (seen: Progress | undefined) =>
      projector.folded.pipe(
        Stream.filter(
          (now) =>
            seen === undefined || now.version !== seen.version || now.through !== seen.through
        ),
        Stream.runHead,
        Effect.map(Option.getOrUndefined)
      );

    // Each page is read in one transaction, with the version and `through` it was read at.
    // A place this projection cannot resume from, of another version or ahead of what was
    // folded, is reset to where the store is. With nothing more to read, it waits until the
    // projector says anything new, a step folded or a reset, and reads again, so a reset the
    // store's sequence never passes again is still seen.
    const changesFrom = (first: Place) =>
      Stream.paginate(first, (place: Place) =>
        Effect.gen(function* () {
          const seen = place.wait ? yield* progressSince(place.seen) : place.seen;

          const read = yield* store.consistent(store.changedAfter(place.after, page));
          const version = versionOf(read.version);
          const through = read.through ?? 0;

          if (place.version !== undefined && (place.version !== version || place.after > through)) {
            const reset: TimelineChangesEvent = {
              data: { through: throughOf(read.through), version },
              event: "reset",
            };

            return [[reset], Option.some({ after: through, seen, version, wait: false })] as const;
          }

          const changed = read.value;

          return [
            eventsOf(changed, version),
            Option.some({
              after: changed.through ?? place.after,
              seen,
              version,
              wait: !changed.more,
            }),
          ] as const;
        })
      );

    return handlers
      .handle("list", ({ params, query }) =>
        Effect.gen(function* () {
          yield* known(params.network);

          const status = yield* projector.status;
          const limit = query.limit ?? windowLimit.default;

          // One more than the page, to say whether more follow.
          const read = yield* store
            .consistent(store.timelines(params.network, { after: query.after, limit: limit + 1 }))
            .pipe(Effect.mapError(timelinesFailed));

          return {
            more: read.value.length > limit,
            projection: projection(status),
            through: throughOf(read.through),
            timelines: read.value.slice(0, limit).map(timeline),
            version: versionOf(read.version),
          };
        })
      )
      .handle("window", ({ params, query }) =>
        Effect.gen(function* () {
          const anchor = anchorOf(query);

          const read = yield* store
            .consistent(
              store.window(params.timeline, anchor, query.limit ?? windowLimit.default).pipe(
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.succeedNone,
                    onSome: (window) =>
                      store
                        .collapsedGaps(window.network, spanOf(window, anchor))
                        .pipe(Effect.map((gaps) => Option.some({ gaps, window }))),
                  })
                )
              )
            )
            .pipe(Effect.mapError(timelinesFailed));

          if (Option.isNone(read.value)) {
            return yield* new UnknownTimeline({ timeline: params.timeline });
          }

          const { gaps, window } = read.value.value;

          return {
            earlier: window.earlier,
            gaps: gaps.map(windowGap),
            items: window.items.map(timelineItem),
            later: window.later,
            network: WireNetworkId.make(window.network),
            through: throughOf(read.through),
            timeline: window.timeline,
            version: versionOf(read.version),
          };
        })
      )
      .handle("channel", ({ params }) =>
        Effect.map(channelOf(params.timeline), ({ timeline, view }) =>
          channelHeader(timeline, Option.getOrUndefined(view))
        )
      )
      .handle("members", ({ params, query }) =>
        Effect.gen(function* () {
          const { timeline, view } = yield* channelOf(params.timeline);
          const known = Option.getOrUndefined(view);

          if (known?.channel.standing !== "Joined") {
            return yield* new NotInChannel({
              standing: known?.channel.standing ?? null,
              timeline: timeline.id,
            });
          }

          const page = membersPage(known, {
            after: query.after,
            limit: query.limit ?? windowLimit.default,
            prefix: query.prefix,
          });

          const order = rankOrder(known);

          return {
            members: page.members.map((one) => member(one, order)),
            more: page.next !== undefined,
            network: WireNetworkId.make(timeline.network),
            next: page.next ?? null,
            timeline: timeline.id,
          };
        })
      )
      .handle("locate", ({ params, query }) =>
        Effect.gen(function* () {
          yield* known(params.network);

          const limit = query.limit ?? windowLimit.default;

          // One more than the page, to say whether more follow.
          const read = yield* store
            .consistent(
              store.locate(params.network, params.sequence, {
                after: query.after,
                limit: limit + 1,
              })
            )
            .pipe(Effect.mapError(timelinesFailed));

          const items = read.value.slice(0, limit);
          const last = items.at(-1);
          const more = read.value.length > limit && last !== undefined;

          return {
            items: items.map(timelineItem),
            more,
            next: more ? { position: last.position, timeline: last.timeline } : null,
            through: throughOf(read.through),
            version: versionOf(read.version),
          };
        })
      )
      .handle("changes", ({ headers, query }) =>
        Effect.gen(function* () {
          const every = yield* Heartbeat;
          // As for News, the header comes with the URL first used, so it wins.
          const resume = headers["last-event-id"] ?? query.after;

          const first: Place =
            resume === undefined
              ? { after: 0, seen: undefined, version: undefined, wait: false }
              : { after: resume.sequence, seen: undefined, version: resume.version, wait: false };

          const changes = changesFrom(first).pipe(Stream.mapError(timelinesFailed));

          const heartbeats = Stream.fromSchedule(Schedule.spaced(every)).pipe(
            Stream.map((): TimelineChangesEvent => ({ data: {}, event: "heartbeat" }))
          );

          return Stream.merge(changes, heartbeats, { haltStrategy: "left" });
        })
      );
  })
);

// A value arrives `Redacted` and goes straight to the Vault, and nothing comes back but
// names.
const credentials = HttpApiBuilder.group(
  DaemonApi,
  "credentials",
  Effect.fn(function* (handlers) {
    const vault = yield* Vault;

    return handlers
      .handle("list", () =>
        vault.names.pipe(
          Effect.map((names) => ({ names: [...names].toSorted() })),
          Effect.mapError(vaultFailed)
        )
      )
      .handle("set", ({ params, payload }) =>
        vault.hold(params.name, payload.value).pipe(
          Effect.tap(() => Effect.logInfo("Held a Credential", { credential: params.name })),
          Effect.mapError(vaultFailed)
        )
      )
      .handle("delete", ({ params }) =>
        vault.forget(params.name).pipe(
          Effect.tap(() => Effect.logInfo("Forgot a Credential", { credential: params.name })),
          Effect.mapError(vaultFailed)
        )
      );
  })
);

// A body over the limit is refused unread, and Bun's graceful stop waits for a client
// still sending one, so the 413 closes its Connection rather than hold up the Daemon's
// shutdown. The limit's error reaches here as a defect.
const bodyLimit = HttpRouter.middleware(
  (app) =>
    app.pipe(
      Effect.provideService(HttpIncomingMessage.MaxBodySize, maxBodySize),
      Effect.catchDefect((defect) =>
        defect instanceof HttpServerError.HttpServerError &&
        defect.reason._tag === "RequestParseError" &&
        defect.reason.reason === "BodyTooLarge"
          ? Effect.succeed(
              HttpServerResponse.empty({ headers: { connection: "close" }, status: 413 })
            )
          : Effect.die(defect)
      )
    ),
  { global: true }
);

/**
 * The handler groups, with the key and sign-in check and request validation, needing the
 * Runtime, the Vault, the Timeline store and its projector, the keys, and the sign-ins.
 */
export const ApiHandlers = Layer.mergeAll(signIn, networks, news, timelines, credentials).pipe(
  Layer.provideMerge(Layer.mergeAll(requestValidation, authorization))
);

/** The API, as routes on the enclosing `HttpRouter`, with the body limit. */
export const ApiRoutes = HttpApiBuilder.layer(DaemonApi).pipe(
  Layer.provide(ApiHandlers),
  Layer.merge(bodyLimit)
);
