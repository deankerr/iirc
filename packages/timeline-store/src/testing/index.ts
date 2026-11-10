/**
 * The in-memory Timeline store, and the laws every Timeline store adapter keeps.
 * Production code never imports this.
 *
 * @packageDocumentation
 */
export { timelineStoreLaws } from "./laws.ts";

export { makeMemoryTimelineStore } from "./memory-store.ts";
