/**
 * The Frontend's one Effect runtime. Every atom that reaches the Daemon runs in it, and a
 * test replaces its Layer through `runtime.layer`.
 *
 * @packageDocumentation
 */
import { Atom } from "effect/reactivity";

import { layerDaemonClient } from "./daemon-client.ts";

/** The runtime, providing the Daemon's client against the page's own origin. */
export const runtime = Atom.runtime(layerDaemonClient());
