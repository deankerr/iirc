/**
 * The pure IRC client for one Network: its inputs, outputs, and what it reports.
 *
 * @packageDocumentation
 */
export type { Client, Inspection, Step, StsPolicy } from "./client.ts";

export { client } from "./core.ts";

/** The real Client's State: opaque, plain data, and rebuilt by replaying the Journal. */
export type { State as ClientState } from "./state.ts";

export {
  IrcdAddress,
  Login,
  NetworkConfiguration,
  startsAsFirstNick,
  WantedChannel,
} from "./configuration.ts";

export {
  CapName,
  ConnectionId,
  FeatureName,
  Instant,
  IntentId,
  MessageId,
  TimerId,
} from "./ids.ts";

export {
  Action,
  CloseReason,
  Input,
  Lookup,
  ModeRequest,
  SayKind,
  UnfilledReason,
  UnsentLine,
} from "./input.ts";

export type {
  ActionWhere,
  Activity,
  Attempted,
  EndReason,
  IgnoredReason,
  LookResult,
  Marked,
  ModeChange,
  Named,
  News,
  OtherReply,
  Ours,
  PartialReason,
  Profile,
  ProfileChannel,
  RefusedAction,
  RefusedReason,
  Where,
} from "./news.ts";

export { Output, timers } from "./output.ts";

export type { TimerTable } from "./output.ts";
