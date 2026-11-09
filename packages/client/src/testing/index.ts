/**
 * Test helpers for code that drives a Client: the transcript test kit and the scripted
 * Client. Production code never imports this. `README.md` beside it is the kit's
 * written interface.
 *
 * @packageDocumentation
 */
export { describeNews, describeOutput } from "./describe.ts";

export { replayFresh, FreshReplayMismatchError } from "./fresh.ts";

export type { ClientModule } from "./fresh.ts";

export { deactivates, inert, LawBrokenError, refines, replays } from "./laws.ts";

export type { Deactivation, LawFeature, Subject } from "./laws.ts";

export { impurity } from "./plain.ts";

export {
  checkReplay,
  play,
  replay,
  ReplayMismatchError,
  ScenarioError,
  TranscriptMismatchError,
} from "./play.ts";

export type { Played, Scenario } from "./play.ts";

export { across, configured, floorIsupport, joined, registered } from "./preludes.ts";

export type { Joining, Overrides, Registration } from "./preludes.ts";

export { scripted } from "./scripted.ts";

export type { Scripted, ScriptedState } from "./scripted.ts";

export { epoch, parse, print, printItem, writeInstant } from "./transcript.ts";

export type { Change, Item, Owner, ParseError } from "./transcript.ts";
