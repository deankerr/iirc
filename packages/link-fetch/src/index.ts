/**
 * The link fetch port, and the address policy its adapters are built with.
 *
 * @packageDocumentation
 */
export {
  LinkFetch,
  LinkRefused,
  LinkTimedOut,
  LinkTooLarge,
  LinkUnreachable,
  LinkWrongType,
  limits,
} from "./link-fetch.ts";

export type {
  BodyFailure,
  Fetched,
  LinkFetchFailure,
  LinkFetchService,
  Purpose,
  StreamRange,
} from "./link-fetch.ts";

export { makePacer, pacing } from "./pacer.ts";

export type { Pacer, Precedence, Turn } from "./pacer.ts";

export { admit, fixedPolicy, parseLink, readAddress, writeAddress } from "./policy.ts";

export type { Address, Admitted, LinkPolicy, Target } from "./policy.ts";
