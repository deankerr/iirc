/**
 * The guard as an end-to-end run builds the Daemon with it: the real link fetch, admitting
 * one loopback fixture site beside every public address.
 *
 * @packageDocumentation
 */
import type { LinkFetch } from "@iirc/link-fetch";
import { layerBunLinkFetch } from "@iirc/link-fetch-bun";
import { loopbackPolicy } from "@iirc/link-fetch/testing";
import type { Layer } from "effect";

/**
 * The guard under the loopback policy, for `DaemonOptions.linkFetch`: it fetches from the
 * fixture site at `127.0.0.1:<port>` as well as any public address, and nothing else.
 * @param port - The fixture site's port, which the kernel picked.
 * @param version - iirc's version, for the user agent.
 * @returns The link fetch.
 */
export const layerLoopbackLinkFetch = (port: number, version = "0.0.0"): Layer.Layer<LinkFetch> =>
  layerBunLinkFetch({ policy: loopbackPolicy(port), version });
