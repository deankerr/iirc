/**
 * The Networks the Daemon runs, with whether each is running.
 *
 * @packageDocumentation
 */
import { useAtomValue } from "@effect/atom-react";
import type { NetworkStatus } from "@iirc/api";
import type { Atom } from "effect/reactivity";

import { networks } from "./atoms.ts";

import styles from "./network-list.module.css";

const Status = ({ status }: { readonly status: NetworkStatus }) =>
  status._tag === "Running" ? (
    <span className={styles.running}>running</span>
  ) : (
    <span className={styles.stopped}>stopped: {status.reason}</span>
  );

/**
 * The list once it is read, or what stands in for it.
 * @param props - The read.
 * @returns The list, or a line saying where the read stands.
 */
const Listing = ({ read }: { readonly read: Atom.Type<typeof networks> }) => {
  switch (read._tag) {
    case "Initial": {
      return <p className={styles.muted}>Reading the Networks…</p>;
    }

    case "Failure": {
      return <p className={styles.muted}>The Networks could not be read.</p>;
    }

    case "Success": {
      return read.value.length === 0 ? (
        <p className={styles.muted}>No Networks are configured yet.</p>
      ) : (
        <ul className={styles.list}>
          {read.value.map(({ network, status }) => (
            <li className={styles.network} key={network}>
              <span>{network}</span>
              <Status status={status} />
            </li>
          ))}
        </ul>
      );
    }

    default: {
      return read satisfies never;
    }
  }
};

/**
 * Lists each Network by its id.
 * @returns The list, with its heading.
 */
export const NetworkList = () => (
  <section aria-labelledby="networks" className={styles.networks}>
    <h2 className={styles.heading} id="networks">
      Networks
    </h2>
    <Listing read={useAtomValue(networks)} />
  </section>
);
