import { Effect } from "effect";

import { serveReader } from "./reader-server.ts";

// The reader's Worker. `LogReader` starts it by this file's URL, and a compiled binary
// carries it as a second entrypoint, under the same name, at the root of its files.
Effect.runFork(serveReader());
