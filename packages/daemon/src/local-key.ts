import { KeyExists, localKeyName } from "@iirc/api";
import type { KeyScope } from "@iirc/api";
import { Log, StorageFailed } from "@iirc/log";
import type { DataDirectoryLocked } from "@iirc/log";
import { Recorder } from "@iirc/session/recorder";
import { Effect } from "effect";

import { hashKey, newKey } from "./keys.ts";
import { readConfiguration, recordChange } from "./recorded.ts";
import type { UndecodableChange } from "./recorded.ts";

/** Where to create the first key, and what to call it. */
export interface LocalKeyOptions {
  readonly dataDir: string;
  readonly name: string;
  readonly scope: KeyScope;
}

/**
 * Creates a key straight into the Log, which is how the first one comes to exist, since a
 * fresh Daemon can authenticate nobody (AUTH-4). It holds the data directory while it
 * works, so it fails at once with `DataDirectoryLocked` while a Daemon runs, rather than
 * wait. It records the Change as `local` and nothing else: no Daemon starts or stops.
 * @param options - The data directory, and the key's name and scope.
 * @returns The key, which nothing keeps, so it is shown once.
 */
export const createLocalKey = ({
  dataDir,
  name,
  scope,
}: LocalKeyOptions): Effect.Effect<
  string,
  DataDirectoryLocked | KeyExists | StorageFailed | UndecodableChange
> =>
  Effect.gen(function* () {
    const { record } = yield* Recorder;
    const configuration = yield* readConfiguration(yield* Log);

    if (configuration.keys.has(name)) {
      return yield* new KeyExists({ keyName: name });
    }

    const key = newKey();

    yield* recordChange(record, configuration, localKeyName, {
      _tag: "KeyCreated",
      hash: hashKey(key),
      name,
      scope,
    }).pipe(Effect.mapError(({ cause }) => new StorageFailed({ cause })));

    return key;
  }).pipe(Effect.provide(Log.layer({ dataDir })));
