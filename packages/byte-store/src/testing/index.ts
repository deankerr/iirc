/**
 * The in-memory byte store, and the laws every byte store adapter keeps. Production code
 * never imports this.
 *
 * @packageDocumentation
 */
export { byteStoreLaws } from "./laws.ts";

export { makeMemoryByteStore } from "./memory-store.ts";

export type { ByteStoreHarness } from "./memory-store.ts";
