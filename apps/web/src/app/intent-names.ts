/**
 * How the runtime names the intents it asks the Daemon under, since the core makes no
 * randomness: a Say, an Act, and a Lookup each get one, unique across the whole Journal, so
 * the API's recovery by intent holds.
 *
 * @packageDocumentation
 */
import { CallerIntent } from "@iirc/api";
import { Context, Schema } from "effect";

/** Names each intent, unique across the whole Journal: a test makes them predictable. */
export class IntentNames extends Context.Reference<() => string>("@iirc/web/IntentNames", {
  defaultValue: () => () => `web-${crypto.randomUUID()}`,
}) {}

/** An intent's name, read as the API's own. */
export const decodeIntent = Schema.decodeSync(CallerIntent);
