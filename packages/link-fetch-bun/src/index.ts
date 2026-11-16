/**
 * The guard: fetches a stranger's link on Bun, pinned to the addresses it checked.
 *
 * @packageDocumentation
 */
export { layerBunLinkFetch, makeBunLinkFetch, systemResolver } from "./link-fetch-bun.ts";

export type { BunLinkFetchOptions, Resolver } from "./link-fetch-bun.ts";

export { sniff, sniffed } from "./content.ts";
