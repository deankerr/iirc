/**
 * The test policy, which admits one loopback server, and the fake link fetch. Production
 * code never imports this.
 *
 * @packageDocumentation
 */
import { fixedPolicy } from "../policy.ts";
import type { LinkPolicy } from "../policy.ts";

export { makeFakeLinkFetch } from "./fake.ts";

export type { Answer, Asked, FakeLinkFetch, FakeOptions, Recorded } from "./fake.ts";

/**
 * The fixed policy, admitting also one loopback address on one port, where a test's server
 * listens. Nothing else special is admitted, and no other port.
 * @param port - The server's port, which the kernel picked.
 * @param address - The server's address.
 * @returns The policy.
 */
export const loopbackPolicy = (port: number, address = "127.0.0.1"): LinkPolicy => ({
  ...fixedPolicy,
  admitted: [{ address, port }],
});
