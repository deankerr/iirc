/**
 * The iirc Daemon: the composition root of the Runtime, the production adapters, and the
 * API, and the handlers of the API's contract.
 *
 * @packageDocumentation
 */
export { defaultListen, layerDaemon, layerLogger } from "./daemon.ts";

export type { Beside, DaemonOptions, Listen } from "./daemon.ts";

export { ApiHandlers, ApiRoutes, ChangesPage, Heartbeat, maxBodySize } from "./handlers.ts";

export { ApiKeys, createKey, KeyExists, KeyName, KeysUnreadable, KeysUnwritable } from "./keys.ts";

export type { HeldKey } from "./keys.ts";

export { SignIns, SignInsUnreadable, SignInsUnwritable } from "./sign-ins.ts";

export { Projector, layerProjector } from "./projector.ts";

export type { Progress, ProjectorStatus } from "./projector.ts";

export { DataDirectoryFailed, DataDirectoryLocked, holdDataDirectory } from "./lock.ts";
