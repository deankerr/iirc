/**
 * What other packages' end-to-end runs share with the Daemon's: private Ircds and a private
 * MinIO on loopback ports the kernel picks, a raw IRC connection as another User, the
 * guard admitting a loopback fixture site, and an old Upload seeded while the Daemon is
 * stopped.
 *
 * @packageDocumentation
 */
export { startErgo, startNgircd } from "./ircd.ts";

export type { Ircd } from "./ircd.ts";

export { freePort, loopback } from "./children.ts";

export { layerLoopbackLinkFetch } from "./links.ts";

export { startMinio } from "./minio.ts";

export type { Minio } from "./minio.ts";

export { connectPeer } from "./peer.ts";

export type { Peer } from "./peer.ts";

export { holdsBytes, loseBytes, seedUpload } from "./uploads.ts";
