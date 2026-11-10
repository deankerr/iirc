/**
 * The pure IRC client for one Network: its inputs, outputs, and what it reports.
 *
 * @packageDocumentation
 */
export type { Client, Inspection, Step, StsPolicy } from "./client.ts";

export { client } from "./core.ts";

/** The real Client's State: opaque, plain data, and rebuilt by replaying the Journal. */
export type { State as ClientState } from "./state.ts";

export { IrcdAddress, Login, NetworkConfiguration, WantedChannel } from "./configuration.ts";

export {
  CapName,
  ConnectionId,
  FeatureName,
  Instant,
  IntentId,
  MessageId,
  TimerId,
} from "./ids.ts";

export { CloseReason, Input, SayKind, UnfilledReason, UnsentLine } from "./input.ts";

export type {
  Activity,
  EndReason,
  IgnoredReason,
  ModeChange,
  News,
  Ours,
  RefusedReason,
} from "./news.ts";

export { Output, timers } from "./output.ts";

export type { TimerTable } from "./output.ts";
