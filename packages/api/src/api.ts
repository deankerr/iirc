/**
 * The contract every Frontend drives the Daemon through. Every route is under `/api`, and
 * every one but signing a browser in and out, and asking whether the Daemon is well,
 * needs a key or a sign-in.
 *
 * @packageDocumentation
 */
import { NetworkConfiguration } from "@iirc/client";
import { TimelineId } from "@iirc/timelines";
import { Context, Schema } from "effect";
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSchema,
  HttpApiSecurity,
  OpenApi,
} from "effect/http-api";

import {
  ConfigurationChanged,
  CrossOrigin,
  InvalidRequest,
  JournalFailed,
  LifeChanged,
  NetworkStopped,
  NotAChannel,
  NotInChannel,
  PreviewsText,
  NotWaiting,
  PreviewsOff,
  SignInsFailed,
  TimelinesFailed,
  TimelinesKept,
  OptionsChanged,
  UiChanged,
  Unauthorized,
  UnknownNetwork,
  UnknownMessage,
  UnknownTimeline,
  StreamFailed,
  UnknownImage,
  UnknownStream,
  UnknownUpload,
  UploadTooLarge,
  UploadUnreadable,
  UploadsOff,
  StoreFull,
  StoreUnavailable,
  VaultFailed,
} from "./errors.ts";
import { Unwell, Well } from "./health.ts";
import { OwnerInForce, OwnerOptionName } from "./options.ts";
import {
  ImageHash,
  MessagePreviews,
  PressRequest,
  PreviewItem,
  PreviewsEvent,
  PreviewId,
  PreviewsRequest,
  StreamQuery,
} from "./previews.ts";
import {
  Acted,
  ActRequest,
  After,
  CallerIntent,
  ChannelHeader,
  Closed,
  CloseRequest,
  ConfigurationInForce,
  CredentialNames,
  CredentialPathName,
  CredentialValue,
  ExportQuery,
  IfSequence,
  Journaled,
  Knowledge,
  ListQuery,
  LocateQuery,
  Located,
  Looked,
  LookedAnswer,
  LookQuery,
  LookRequest,
  MemberPage,
  MembersQuery,
  NetworkEntry,
  NetworkId,
  NetworkInspection,
  NewsEvent,
  ProjectionEvent,
  ReadRequest,
  Removed,
  RemoveQuery,
  Resume,
  Said,
  SaidAnswer,
  SayRequest,
  SearchQuery,
  SearchResults,
  SequenceFromString,
  SignInRequest,
  TimelineChangesEvent,
  TimelineList,
  TimelineWindow,
  OptionValue,
  OptionsEvent,
  UiEvent,
  UiValue,
  WindowQuery,
} from "./schemas.ts";
import { TailEvent, TailRead } from "./tail.ts";
import { UiInForce, UiOptionName } from "./ui.ts";
import {
  Upload,
  UploadId,
  UploadPage,
  UploadQuery,
  UploadRename,
  UploadsEvent,
  UploadsQuery,
  UploadsStatus,
} from "./uploads.ts";

/**
 * How the API parses a request: a key nothing reads, such as a misspelt field of a
 * Configuration, is an issue at its path, never a setting silently left out.
 */
export const requestParseOptions = { onExcessProperty: "error" } as const;

/**
 * The name of the key a request came with, or that its sign-in was made with,
 * which its handler acts for.
 */
export class Caller extends Context.Service<Caller, { readonly key: string }>()(
  "@iirc/api/Caller"
) {}

/** The cookie a sign-in travels in. It names the sign-in, never a key. */
export const signInCookie = "iirc_sign_in";

/**
 * Checks the key in `Authorization: Bearer`, or else the sign-in in the
 * {@link signInCookie} cookie, and provides {@link Caller} either way. A request the
 * cookie carries that changes something must come from the Daemon's own origin, or it is
 * {@link CrossOrigin}.
 */
// oxlint-disable-next-line effecttsgo/leaking-requirements -- A security middleware runs inside the request, which it may read, as Effect's own `HttpApiMiddlewareSecurity` type says.
export class Authorization extends HttpApiMiddleware.Service<Authorization, { provides: Caller }>()(
  "@iirc/api/Authorization",
  {
    error: [Unauthorized, CrossOrigin],
    requiredForClient: true,
    security: {
      bearer: HttpApiSecurity.bearer,
      signIn: HttpApiSecurity.apiKey({ in: "cookie", key: signInCookie }),
    },
  }
) {}

/** Turns a request that fails to decode into an {@link InvalidRequest}. */
export class RequestValidation extends HttpApiMiddleware.Service<RequestValidation>()(
  "@iirc/api/RequestValidation",
  { error: InvalidRequest }
) {}

const NetworkPath = { network: NetworkId };

/** Networks: their Configuration, what they are told to say and have read, and what they know. */
export class NetworksGroup extends HttpApiGroup.make("networks")
  .add(
    HttpApiEndpoint.get("list", "/networks", { success: Schema.Array(NetworkEntry) }),
    HttpApiEndpoint.put("configure", "/networks/:network", {
      error: [NetworkStopped, ConfigurationChanged, TimelinesKept],
      params: NetworkPath,
      payload: NetworkConfiguration,
      query: { ifSequence: Schema.optionalKey(IfSequence) },
      success: Journaled,
    }),
    HttpApiEndpoint.delete("remove", "/networks/:network", {
      error: [UnknownNetwork, LifeChanged, NetworkStopped, JournalFailed, VaultFailed],
      params: NetworkPath,
      query: RemoveQuery,
      success: Removed,
    }),
    HttpApiEndpoint.get("configuration", "/networks/:network/configuration", {
      error: UnknownNetwork,
      params: NetworkPath,
      success: ConfigurationInForce,
    }),
    HttpApiEndpoint.post("say", "/networks/:network/say", {
      error: [UnknownNetwork, NetworkStopped],
      params: NetworkPath,
      payload: SayRequest,
      success: Said,
    }),
    HttpApiEndpoint.post("act", "/networks/:network/act", {
      error: [UnknownNetwork, NetworkStopped],
      params: NetworkPath,
      payload: ActRequest,
      success: Acted,
    }),
    HttpApiEndpoint.get("said", "/networks/:network/said/:intent", {
      error: JournalFailed,
      params: { intent: CallerIntent, network: NetworkId },
      success: SaidAnswer,
    }),
    HttpApiEndpoint.post("look", "/networks/:network/lookups", {
      error: [UnknownNetwork, NetworkStopped],
      params: NetworkPath,
      payload: LookRequest,
      query: LookQuery,
      success: Looked,
    }),
    HttpApiEndpoint.get("looked", "/networks/:network/lookups/:intent", {
      error: JournalFailed,
      params: { intent: CallerIntent, network: NetworkId },
      query: LookQuery,
      success: LookedAnswer,
    }),
    HttpApiEndpoint.post("read", "/networks/:network/read", {
      error: [UnknownNetwork, NetworkStopped],
      params: NetworkPath,
      payload: ReadRequest,
      success: Journaled,
    }),
    HttpApiEndpoint.post("close", "/networks/:network/close", {
      error: [UnknownNetwork, NetworkStopped],
      params: NetworkPath,
      payload: CloseRequest,
      success: Closed,
    }),
    HttpApiEndpoint.post("retry", "/networks/:network/retry", {
      error: [UnknownNetwork, NetworkStopped],
      params: NetworkPath,
      success: Journaled,
    }),
    HttpApiEndpoint.get("known", "/networks/:network/known", {
      error: UnknownNetwork,
      params: NetworkPath,
      success: Knowledge,
    }),
    HttpApiEndpoint.get("inspect", "/networks/:network/inspect", {
      error: UnknownNetwork,
      params: NetworkPath,
      success: NetworkInspection,
    })
  )
  .middleware(Authorization) {}

/**
 * The News of every Network, as Server-Sent Events, from just after `after`, or the
 * `Last-Event-ID` header when a reconnecting `EventSource` sends it, and then live.
 */
export class NewsGroup extends HttpApiGroup.make("news")
  .add(
    HttpApiEndpoint.get("follow", "/news", {
      headers: { "last-event-id": Schema.optionalKey(After) },
      query: { after: Schema.optionalKey(After) },
      success: HttpApiSchema.StreamSse({ error: JournalFailed, events: NewsEvent }),
    })
  )
  .middleware(Authorization) {}

/**
 * Timelines, as the Daemon folds them from News, so a Frontend never folds News itself:
 * a Network's Timelines, a page at a time, a window of one, the items a step made, and what
 * changed, as Server-Sent Events from just after `after` or `Last-Event-ID`, and then live.
 * Each read says the projection version and the last step folded into what it gave, to
 * follow the changes after. A Channel's Timeline also gives its head and its members, a
 * page at a time, as the Client knows them now. A search finds Messages by their text, a
 * page at a time, newest first. A Timeline, or a range of time in it, is exported as plain
 * text, one line an item, read from the store as it is sent. Whether the Timelines are being folded at all is followed
 * as Server-Sent Events too, since a failure stops the folding until the Daemon restarts.
 */
export class TimelinesGroup extends HttpApiGroup.make("timelines")
  .add(
    HttpApiEndpoint.get("list", "/networks/:network/timelines", {
      error: [UnknownNetwork, TimelinesFailed],
      params: NetworkPath,
      query: ListQuery,
      success: TimelineList,
    }),
    HttpApiEndpoint.get("changes", "/timelines/changes", {
      headers: { "last-event-id": Schema.optionalKey(Resume) },
      query: { after: Schema.optionalKey(Resume) },
      success: HttpApiSchema.StreamSse({ error: TimelinesFailed, events: TimelineChangesEvent }),
    }),
    HttpApiEndpoint.get("projection", "/timelines/projection", {
      success: HttpApiSchema.StreamSse({ events: ProjectionEvent }),
    }),
    HttpApiEndpoint.get("window", "/timelines/:timeline", {
      error: [UnknownTimeline, TimelinesFailed],
      params: { timeline: TimelineId },
      query: WindowQuery,
      success: TimelineWindow,
    }),
    HttpApiEndpoint.get("channel", "/timelines/:timeline/channel", {
      error: [UnknownTimeline, NotAChannel, TimelinesFailed],
      params: { timeline: TimelineId },
      success: ChannelHeader,
    }),
    HttpApiEndpoint.get("members", "/timelines/:timeline/members", {
      error: [UnknownTimeline, NotAChannel, NotInChannel, TimelinesFailed],
      params: { timeline: TimelineId },
      query: MembersQuery,
      success: MemberPage,
    }),
    HttpApiEndpoint.get("locate", "/networks/:network/at/:sequence", {
      error: [UnknownNetwork, TimelinesFailed],
      params: { network: NetworkId, sequence: SequenceFromString },
      query: LocateQuery,
      success: Located,
    }),
    HttpApiEndpoint.get("export", "/timelines/:timeline/export", {
      error: [UnknownTimeline, TimelinesFailed],
      params: { timeline: TimelineId },
      query: ExportQuery,
      success: HttpApiSchema.StreamUint8Array({ contentType: "text/plain; charset=utf-8" }),
    }),
    HttpApiEndpoint.get("search", "/search", {
      error: [UnknownNetwork, UnknownTimeline, TimelinesFailed],
      query: SearchQuery,
      success: SearchResults,
    })
  )
  .middleware(Authorization) {}

// A change of an option names the sequence it was made from, under `ui` or elsewhere.
const UiQuery = { ifSequence: Schema.optionalKey(IfSequence) };

/**
 * The options under `ui`, which belong to the Owner rather than to any Network and are
 * shared by every device: read whole, set or unset one at a time, made from the options
 * read, and followed as Server-Sent Events, the options whole each time they change.
 */
export class UiGroup extends HttpApiGroup.make("ui")
  .add(
    HttpApiEndpoint.get("read", "/ui", { success: UiInForce }),
    HttpApiEndpoint.get("changes", "/ui/changes", {
      headers: { "last-event-id": Schema.optionalKey(After) },
      query: { after: Schema.optionalKey(After) },
      success: HttpApiSchema.StreamSse({ error: JournalFailed, events: UiEvent }),
    }),
    HttpApiEndpoint.put("set", "/ui/:option", {
      error: [UiChanged, JournalFailed],
      params: { option: UiOptionName },
      payload: UiValue,
      query: UiQuery,
      success: Journaled,
    }),
    HttpApiEndpoint.delete("unset", "/ui/:option", {
      error: [UiChanged, JournalFailed],
      params: { option: UiOptionName },
      query: UiQuery,
      success: Journaled,
    })
  )
  .middleware(Authorization) {}

/**
 * The Owner's options beyond `ui`, each by its full name, such as
 * `store.s3.bucket`, as the `ui` group's are: read whole, set or unset one at a time, made
 * from the options read, and followed as Server-Sent Events, the options whole each time
 * they change.
 */
export class OptionsGroup extends HttpApiGroup.make("options")
  .add(
    HttpApiEndpoint.get("read", "/options", { success: OwnerInForce }),
    HttpApiEndpoint.get("changes", "/options/changes", {
      headers: { "last-event-id": Schema.optionalKey(After) },
      query: { after: Schema.optionalKey(After) },
      success: HttpApiSchema.StreamSse({ error: JournalFailed, events: OptionsEvent }),
    }),
    HttpApiEndpoint.put("set", "/options/:option", {
      error: [OptionsChanged, JournalFailed],
      params: { option: OwnerOptionName },
      payload: OptionValue,
      query: UiQuery,
      success: Journaled,
    }),
    HttpApiEndpoint.delete("unset", "/options/:option", {
      error: [OptionsChanged, JournalFailed],
      params: { option: OwnerOptionName },
      query: UiQuery,
      success: Journaled,
    })
  )
  .middleware(Authorization) {}

/**
 * Uploads: a file's bytes as the raw body, with no multipart, whatever its `Content-Type`,
 * which is never read, kept and recorded, and answered with its record and link; the
 * Uploads, newest first, a page at a time; one Upload by its id, and its bytes, on the
 * API's own origin with the link's safety headers; renaming and deleting one; whether
 * Uploads are on; and their Changes, as Server-Sent Events from just after `after` or `Last-Event-ID`, and then live.
 */
export class UploadsGroup extends HttpApiGroup.make("uploads")
  .add(
    HttpApiEndpoint.post("upload", "/uploads", {
      error: [
        UploadsOff,
        UploadTooLarge,
        UploadUnreadable,
        StoreFull,
        StoreUnavailable,
        JournalFailed,
      ],
      payload: HttpApiSchema.StreamUint8Array({ contentType: "application/octet-stream" }),
      query: UploadQuery,
      success: Upload,
    }),
    HttpApiEndpoint.get("list", "/uploads", {
      error: TimelinesFailed,
      query: UploadsQuery,
      success: UploadPage,
    }),
    HttpApiEndpoint.get("status", "/uploads/status", { success: UploadsStatus }),
    HttpApiEndpoint.get("changes", "/uploads/changes", {
      headers: { "last-event-id": Schema.optionalKey(After) },
      query: { after: Schema.optionalKey(After) },
      success: HttpApiSchema.StreamSse({
        error: Schema.Union([JournalFailed, TimelinesFailed]),
        events: UploadsEvent,
      }),
    }),
    HttpApiEndpoint.get("read", "/uploads/:id", {
      error: [UnknownUpload, TimelinesFailed],
      params: { id: UploadId },
      success: Upload,
    }),
    HttpApiEndpoint.get("content", "/uploads/:id/content", {
      error: [UnknownUpload, StoreUnavailable],
      params: { id: UploadId },
      success: HttpApiSchema.StreamUint8Array({ contentType: "application/octet-stream" }),
    }),
    HttpApiEndpoint.patch("rename", "/uploads/:id", {
      error: [UnknownUpload, JournalFailed, TimelinesFailed],
      params: { id: UploadId },
      payload: UploadRename,
      success: Upload,
    }),
    HttpApiEndpoint.delete("delete", "/uploads/:id", {
      error: [UnknownUpload, JournalFailed, TimelinesFailed],
      params: { id: UploadId },
      success: Upload,
    })
  )
  .middleware(Authorization) {}

/**
 * Previews: a Message's, asked for by its place in its Timeline, which starts fetching any
 * of its links not yet fetched, and each change of a Preview's state, as Server-Sent
 * Events, live. It is beside News, not in it, since a Preview is never journaled. A press
 * fetches one link of a Direct Message that waits for it. Asking and pressing are each a
 * `POST`, so one carried by a cookie must come from the Daemon's own origin, and another
 * site cannot make the Daemon fetch.
 */
export class PreviewsGroup extends HttpApiGroup.make("previews")
  .add(
    HttpApiEndpoint.post("ask", "/timelines/:timeline/previews", {
      error: [UnknownTimeline, UnknownMessage, PreviewsOff, TimelinesFailed],
      params: { timeline: TimelineId },
      payload: PreviewsRequest,
      success: MessagePreviews,
    }),
    HttpApiEndpoint.post("press", "/timelines/:timeline/previews/press", {
      error: [UnknownTimeline, UnknownMessage, PreviewsOff, NotWaiting, TimelinesFailed],
      params: { timeline: TimelineId },
      payload: PressRequest,
      success: PreviewItem,
    }),
    HttpApiEndpoint.get("changes", "/previews/changes", {
      success: HttpApiSchema.StreamSse({ events: PreviewsEvent }),
    }),
    HttpApiEndpoint.get("images", "/previews/images/:hash", {
      error: [UnknownImage, StoreUnavailable],
      params: { hash: ImageHash },
      success: HttpApiSchema.StreamUint8Array({ contentType: "application/octet-stream" }),
    }),
    HttpApiEndpoint.get("stream", "/previews/:id/stream", {
      error: [
        UnknownTimeline,
        UnknownMessage,
        PreviewsOff,
        PreviewsText,
        UnknownStream,
        StreamFailed,
        TimelinesFailed,
      ],
      params: { id: PreviewId },
      query: StreamQuery,
      success: HttpApiSchema.StreamUint8Array({ contentType: "application/octet-stream" }),
    })
  )
  .middleware(Authorization) {}

/**
 * The Tail: the most recent of what the Daemon logged, held in its memory, read whole,
 * oldest first, and followed as Server-Sent Events, each line after `after` or
 * `Last-Event-ID` as it is logged, or every line held without either, then live.
 */
export class TailGroup extends HttpApiGroup.make("tail")
  .add(
    HttpApiEndpoint.get("read", "/tail", { success: TailRead }),
    HttpApiEndpoint.get("changes", "/tail/changes", {
      headers: { "last-event-id": Schema.optionalKey(After) },
      query: { after: Schema.optionalKey(After) },
      success: HttpApiSchema.StreamSse({ events: TailEvent }),
    })
  )
  .middleware(Authorization) {}

/** Credentials, by name. A value goes in, and only names come out. */
export class CredentialsGroup extends HttpApiGroup.make("credentials")
  .add(
    HttpApiEndpoint.get("list", "/credentials", { error: VaultFailed, success: CredentialNames }),
    HttpApiEndpoint.put("set", "/credentials/:name", {
      error: VaultFailed,
      params: { name: CredentialPathName },
      payload: CredentialValue,
      success: HttpApiSchema.NoContent,
    }),
    HttpApiEndpoint.delete("delete", "/credentials/:name", {
      error: VaultFailed,
      params: { name: CredentialPathName },
      success: HttpApiSchema.NoContent,
    })
  )
  .middleware(Authorization) {}

/**
 * A browser signs in: it gives a key once, for a sign-in in an `HttpOnly`
 * cookie, since a browser never holds a key in script and an `EventSource` cannot send
 * `Authorization`. Neither route needs the key check, since this is where a browser gets
 * what it presents.
 */
export class SignInGroup extends HttpApiGroup.make("signIn").add(
  HttpApiEndpoint.post("signIn", "/sign-in", {
    error: [Unauthorized, CrossOrigin, SignInsFailed],
    payload: SignInRequest,
    success: HttpApiSchema.NoContent,
  }),
  HttpApiEndpoint.delete("signOut", "/sign-in", {
    error: [CrossOrigin, SignInsFailed],
    success: HttpApiSchema.NoContent,
  })
) {}

/**
 * Whether the Daemon is well, for a health check or a service manager on its machine,
 * with no key or sign-in, since it says nothing a Frontend reads but that a part stopped.
 */
export class HealthGroup extends HttpApiGroup.make("health").add(
  HttpApiEndpoint.get("health", "/health", { error: Unwell, success: Well })
) {}

/** The Daemon's API. */
export class DaemonApi extends HttpApi.make("iirc")
  .add(HealthGroup)
  .add(SignInGroup)
  .add(NetworksGroup)
  .add(NewsGroup)
  .add(TimelinesGroup)
  .add(UiGroup)
  .add(OptionsGroup)
  .add(UploadsGroup)
  .add(PreviewsGroup)
  .add(CredentialsGroup)
  .add(TailGroup)
  .middleware(RequestValidation)
  .annotate(HttpApi.PayloadParseOptions, requestParseOptions)
  .prefix("/api")
  .annotateMerge(OpenApi.annotations({ title: "iirc Daemon" })) {}
