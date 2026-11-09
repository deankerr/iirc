/**
 * The production adapter of the Transport port, over TCP and TLS on Bun.
 *
 * @packageDocumentation
 */
export { layer, makeBunTransport } from "./transport.ts";

export type { BunTransportOptions, Destination } from "./transport.ts";
