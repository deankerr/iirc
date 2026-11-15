/**
 * What other packages' end-to-end runs share with the Daemon's: private Ircds and a private
 * MinIO on loopback ports the kernel picks, and a raw IRC connection as another User.
 *
 * @packageDocumentation
 */
export { startErgo, startNgircd } from "./ircd.ts";

export type { Ircd } from "./ircd.ts";

export { startMinio } from "./minio.ts";

export type { Minio } from "./minio.ts";

export { connectPeer } from "./peer.ts";

export type { Peer } from "./peer.ts";
