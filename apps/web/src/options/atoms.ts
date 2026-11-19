/**
 * The options, as atoms: the view the pure core folds, and what carries out a change of
 * Configuration. A change is read, applied, and sent whole, made from the Configuration it
 * was read at, so the Daemon refuses it if another changed the Network in between. Then it
 * is read again and the same edit applied once more, since an edit is a pure function of
 * the Configuration, and if that is refused too, the conflict is said in words. A
 * Credential's value goes straight from the Owner to the Vault, and is wiped once sent.
 *
 * @packageDocumentation
 */
import { CredentialPathName } from "@iirc/api";
import type { NetworkId } from "@iirc/api";
import { panesOf } from "@iirc/frontend/layout";
import type {
  Asked,
  Edit,
  Naming,
  OptionsEvent,
  Path,
  Configuration,
  Wanted,
} from "@iirc/frontend/options";
import {
  apply,
  credentialFor,
  initialOptions,
  grouped,
  networksReading,
  optionName,
  reduceOptions,
  uiShown,
  unknownNaming,
} from "@iirc/frontend/options";
import { reduce as reduceSignIn } from "@iirc/frontend/sign-in";
import { reduceTimelines, mainOf } from "@iirc/frontend/timelines";
import type { TimelinesEvent } from "@iirc/frontend/timelines";
import { Effect, Option, Redacted, Schema, Semaphore } from "effect";
import { Atom } from "effect/reactivity";
import type { AtomRegistry } from "effect/reactivity";

import { DaemonClient } from "../app/daemon-client.ts";
import { runtime } from "../app/runtime.ts";
import { signedIn, signInState } from "../sign-in/atoms.ts";
import { canvasMeasure, familiesMissing } from "../theme/device-fonts.ts";
import { timelinesState } from "../timelines/atoms.ts";
import { deviceUi } from "./device.ts";

/** The options view, as the core folds it. */
export const optionsState = Atom.make(initialOptions).pipe(Atom.keepAlive);

/** What the focused Pane shows: its open Timeline, or the options with their filter. */
export const mainView = Atom.make((get) => mainOf(get(timelinesState)));

/** The options' filter, as the Pane they show in has it, or none while they show nowhere. */
export const optionsFilter = Atom.make((get) => {
  const main = panesOf(get(timelinesState).layout.root)
    .map((pane) => pane.view.main)
    .find((one) => one._tag === "Options");

  return main?._tag === "Options" ? main.filter : undefined;
});

/**
 * The options the view lists under their headings, filtered as the Pane they show in says,
 * each as it shows with the changes on its way, those under `ui` as they take effect on this
 * device, with a font's family this device lacks said to be.
 */
export const optionGroups = Atom.make((get) => {
  const state = get(optionsState);
  const device = get(deviceUi);
  const missing = familiesMissing([uiShown(state)?.options.font, device.font], canvasMeasure());

  return grouped(state, get(optionsFilter) ?? "", device, missing);
});

/** The Networks whose options the view is still reading, which it draws as a wait. */
export const networksWaited = Atom.make((get) => networksReading(get(optionsState)));

/**
 * Folds one event into the options view.
 * @param registry - The registry.
 * @param event - What happened.
 */
export const happened = (registry: AtomRegistry.AtomRegistry, event: OptionsEvent) => {
  registry.set(optionsState, reduceOptions(registry.get(optionsState), event));
};

/**
 * Carries out a change that shows at once: it is folded in as asked, and let go of once the
 * work, the tries and the read after the last, is over, however it ended, so what the Daemon
 * holds shows then, and nothing shows what was refused.
 * @param registry - The registry.
 * @param change - What is asked for.
 * @param work - What carries it out.
 * @returns What the work came to.
 */
export const onItsWay = <A, E, R>(
  registry: AtomRegistry.AtomRegistry,
  change: Wanted,
  work: Effect.Effect<A, E, R>
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const id = registry.get(optionsState).asked;

      happened(registry, { _tag: "Asked", change });

      return id;
    }),
    () => work,
    (id) =>
      Effect.sync(() => {
        happened(registry, { _tag: "Answered", id });
      })
  );

/**
 * What a change came to: done, why it was not made, in words, or the page signed out.
 */
export type Outcome =
  | { readonly _tag: "Done" }
  | { readonly _tag: "NotDone"; readonly message: string }
  | { readonly _tag: "SignedOut" };

const done: Outcome = { _tag: "Done" };

const notDone = (message: string): Outcome => ({ _tag: "NotDone", message });

/**
 * Why a request failed, in words, from its error's tag, never its text.
 * @param tag - The error's tag.
 * @param network - The Network it was for.
 * @returns The outcome.
 */
const failedWith = (tag: string, network: NetworkId): Outcome => {
  switch (tag) {
    case "Unauthorized": {
      return { _tag: "SignedOut" };
    }

    case "UnknownNetwork": {
      return notDone(`The Daemon has no Network ${network}. Add one with /network add.`);
    }

    case "NetworkStopped": {
      return notDone(
        `${network} has stopped, so whether this was changed is unknown. Look at its options again.`
      );
    }

    case "VaultFailed": {
      return notDone("The Daemon could not write its Credentials, so nothing was held.");
    }

    case "InvalidRequest": {
      return notDone("The Daemon could not read this as a Configuration.");
    }

    case "TimelinesKept": {
      return notDone(
        `${network} was removed with its Timelines kept, so no Network can take its name until they are dropped. /network remove ${network} drops them.`
      );
    }

    case "ConfigurationChanged": {
      return notDone(
        `${network}'s Configuration changed while this was being made, twice, so nothing was changed. Try again.`
      );
    }

    default: {
      return notDone("The Daemon did not answer, so whether this was changed is unknown.");
    }
  }
};

/**
 * Reads a Network's Configuration in force into the view.
 * @param registry - The registry.
 * @param network - The Network.
 * @returns The Configuration and its sequence.
 */
const readConfiguration = (registry: AtomRegistry.AtomRegistry, network: NetworkId) =>
  Effect.gen(function* () {
    const client = yield* DaemonClient;
    const read = yield* client.networks.configuration({ params: { network } });

    happened(registry, {
      _tag: "Read",
      configuration: read.configuration,
      network,
      sequence: read.sequence,
    });

    return read;
  });

/**
 * Signs the page out, when a request was refused for its sign-in.
 * @param registry - The registry.
 */
export const signedOut = (registry: AtomRegistry.AtomRegistry) => {
  registry.set(signInState, reduceSignIn(registry.get(signInState), { _tag: "Refused" }));
};

/**
 * Reads the names of the Credentials the Vault holds into the view. When they cannot be
 * read, whether each is held is not known, never the names last read, and a refusal for
 * the sign-in signs the page out.
 * @param registry - The registry.
 * @returns Once read, or not.
 */
export const readHeld = (registry: AtomRegistry.AtomRegistry) =>
  Effect.gen(function* () {
    const client = yield* DaemonClient;
    const { names } = yield* client.credentials.list();

    happened(registry, { _tag: "Held", names });
  }).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        if (error._tag === "Unauthorized") {
          signedOut(registry);
        } else {
          happened(registry, { _tag: "HeldFailed" });
        }
      })
    )
  );

/**
 * Says in the view that a read it needs failed, or signs the page out when it was refused
 * for its sign-in.
 * @param registry - The registry.
 * @param tag - The error's tag.
 * @param message - What was not read, in words.
 * @param failed - What the view folds in for it.
 */
const readFailed = (
  registry: AtomRegistry.AtomRegistry,
  tag: string,
  message: string,
  failed: () => void
) => {
  if (tag === "Unauthorized") {
    signedOut(registry);

    return;
  }

  failed();

  // The Networks and the names held are read together, so one failure's words never hide
  // the other's.
  const before = registry.get(optionsState).notice;
  const said = `${message} Open the options again to read them.`;

  happened(registry, {
    _tag: "Noticed",
    message: before === undefined ? said : `${before} ${said}`,
  });
};

/**
 * Reads every Network's Configuration into the view. When the Networks cannot be listed,
 * the view says so, and, never having listed them, lists none rather than wait for ever.
 * @param registry - The registry.
 * @returns Once read.
 */
const readNetworks = (registry: AtomRegistry.AtomRegistry) =>
  Effect.gen(function* () {
    const client = yield* DaemonClient;
    const entries = yield* client.networks.list();
    // A Network removed with its Timelines kept has no Configuration to read.
    const networks = entries.flatMap((entry) => (entry._tag === "Live" ? [entry.network] : []));

    happened(registry, { _tag: "Listed", networks });

    yield* Effect.forEach(
      networks,
      (network) =>
        readConfiguration(registry, network).pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              const outcome = failedWith(error._tag, network);

              happened(registry, {
                _tag: "ReadFailed",
                message: outcome._tag === "NotDone" ? outcome.message : "Not read.",
                network,
              });
            })
          )
        ),
      { concurrency: 4, discard: true }
    );
  }).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        readFailed(
          registry,
          error._tag,
          "The Daemon did not list its Networks, so their options are not shown.",
          () => {
            if (registry.get(optionsState).networks === undefined) {
              happened(registry, { _tag: "Listed", networks: [] });
            }
          }
        );
      })
    )
  );

/**
 * Reads the Credentials held into the view, saying so when they cannot be, so a Credential
 * shows as not known rather than wait for ever.
 * @param registry - The registry.
 * @returns Once read.
 */
const readHeldOrSay = (registry: AtomRegistry.AtomRegistry) =>
  Effect.gen(function* () {
    const client = yield* DaemonClient;
    const { names } = yield* client.credentials.list();

    happened(registry, { _tag: "Held", names });
  }).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        readFailed(
          registry,
          error._tag,
          "The Daemon did not say which Credentials it holds, so whether each is held is not known.",
          () => {
            happened(registry, { _tag: "HeldFailed" });
          }
        );
      })
    )
  );

/**
 * Reads every Network's Configuration, and the Credentials held, into the view.
 * @param registry - The registry.
 * @returns Once read.
 */
export const refresh = (registry: AtomRegistry.AtomRegistry) =>
  Effect.all([readNetworks(registry), readHeldOrSay(registry)], {
    concurrency: "unbounded",
    discard: true,
  });

/**
 * What the Daemon reports of a Network that bears on its Channels' names and its ignore
 * masks: the casemapping an Ircd declared, and `CHANTYPES`. A read that fails is taken as
 * knowing neither, so Channels' names are compared exactly and none is prefixed, and masks
 * are folded by `rfc1459`, as before any Ircd declared one.
 * @param network - The Network.
 * @returns What it reports.
 */
const reportedNaming = (network: NetworkId) =>
  Effect.gen(function* () {
    const client = yield* DaemonClient;
    const known = yield* client.networks.known({ params: { network } });

    const naming: Naming = {
      casemapping: known.declared ?? undefined,
      chantypes: known.chantypes ?? undefined,
    };

    return naming;
  }).pipe(Effect.orElseSucceed(() => unknownNaming));

/**
 * What the Daemon reports of a Network, read only for an edit that compares names, of its
 * Channels or its ignore masks.
 * @param network - The Network.
 * @param edit - The edit.
 * @returns What it reports.
 */
const namingOf = (network: NetworkId, edit: Edit) =>
  edit._tag === "Set" || edit._tag === "Unset" || edit._tag === "Point"
    ? Effect.succeed(unknownNaming)
    : reportedNaming(network);

/**
 * A Network's Configuration in force, read into the view, and what the Daemon reports of
 * its Channels' names, which tell whether a Channel is among those it wants.
 * @param registry - The registry.
 * @param network - The Network.
 * @returns The Configuration and the naming, or why they were not read, in words.
 */
export const readChannels = (registry: AtomRegistry.AtomRegistry, network: NetworkId) =>
  Effect.gen(function* () {
    const read = yield* readConfiguration(registry, network);
    const naming = yield* reportedNaming(network);

    return { _tag: "Read", configuration: read.configuration, naming } as const;
  }).pipe(Effect.catch((error) => Effect.succeed(failedWith(error._tag, network))));

/** A conflict: the Configuration in force was not the one the change was made from. */
const conflict = { _tag: "Conflict" } as const;

/**
 * One try at a change: read the Configuration in force, apply the edit, and send the whole
 * of it back, made from the one read. Nothing is sent when the edit changes nothing.
 * @param registry - The registry.
 * @param network - The Network.
 * @param edit - The edit.
 * @returns What it came to, or a conflict to try again.
 */
const tryOnce = (registry: AtomRegistry.AtomRegistry, network: NetworkId, edit: Edit) =>
  Effect.gen(function* () {
    const client = yield* DaemonClient;
    const read = yield* readConfiguration(registry, network);
    const naming = yield* namingOf(network, edit);
    const next = apply(network, read.configuration, edit, naming);

    if (next._tag === "Invalid") {
      return notDone(next.message);
    }

    if (JSON.stringify(next.value) === JSON.stringify(read.configuration)) {
      return done;
    }

    yield* client.networks.configure({
      params: { network },
      payload: next.value,
      query: { ifSequence: read.sequence },
    });
    yield* readConfiguration(registry, network).pipe(Effect.ignore);

    return done;
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed(
        error._tag === "ConfigurationChanged" ? conflict : failedWith(error._tag, network)
      )
    )
  );

/** One turn at a time for each Network's changes, in each registry. */
const turns = new WeakMap<AtomRegistry.AtomRegistry, Map<NetworkId, Semaphore.Semaphore>>();

/**
 * Waits for a Network's earlier changes from this page to be answered before the work reads
 * its Configuration and changes it. Each change is measured against the Configuration in
 * force, so one made while an earlier was unanswered would be measured against what that
 * earlier replaces, and an unset following a set would find nothing to unset and send
 * nothing. Work that reads the Configuration to decide what to change takes the turn around
 * both, and changes it with `configureInTurn`.
 * @param registry - The registry.
 * @param network - The Network.
 * @param work - What reads and changes it.
 * @returns What the work came to.
 */
export const inTurn = <A, E, R>(
  registry: AtomRegistry.AtomRegistry,
  network: NetworkId,
  work: Effect.Effect<A, E, R>
) => {
  const networks = turns.get(registry) ?? new Map<NetworkId, Semaphore.Semaphore>();
  const turn = networks.get(network) ?? Semaphore.makeUnsafe(1);

  networks.set(network, turn);
  turns.set(registry, networks);

  return Semaphore.withPermit(turn)(work);
};

/**
 * The tries at a change: if another changed the Configuration between the read and the
 * write, it is read again and the same edit applied once more, from what is in force.
 * @param registry - The registry.
 * @param network - The Network.
 * @param edit - The edit.
 * @returns What it came to.
 */
const tries = (registry: AtomRegistry.AtomRegistry, network: NetworkId, edit: Edit) =>
  Effect.gen(function* () {
    const first = yield* tryOnce(registry, network, edit);

    if (first._tag !== "Conflict") {
      return first;
    }

    const second = yield* tryOnce(registry, network, edit);

    return second._tag === "Conflict" ? failedWith("ConfigurationChanged", network) : second;
  });

/**
 * Makes a change to a Network's Configuration, which shows at once and until it is answered,
 * once the Network's earlier changes are answered.
 * @param registry - The registry.
 * @param network - The Network.
 * @param edit - The edit.
 * @returns What it came to.
 */
export const configure = (registry: AtomRegistry.AtomRegistry, network: NetworkId, edit: Edit) =>
  onItsWay(
    registry,
    { _tag: "Network", edit, network },
    inTurn(registry, network, tries(registry, network, edit))
  );

/**
 * Makes a change to a Network's Configuration from work that already holds the Network's
 * turn, as `inTurn` gives it.
 * @param registry - The registry.
 * @param network - The Network.
 * @param edit - The edit.
 * @returns What it came to.
 */
export const configureInTurn = (
  registry: AtomRegistry.AtomRegistry,
  network: NetworkId,
  edit: Edit
) => onItsWay(registry, { _tag: "Network", edit, network }, tries(registry, network, edit));

/**
 * Adds a Network, made from none, so a Network already configured is never replaced.
 * @param registry - The registry.
 * @param network - The Network.
 * @param configuration - What it starts with.
 * @returns What it came to.
 */
export const addNetwork = (
  registry: AtomRegistry.AtomRegistry,
  network: NetworkId,
  configuration: Configuration
) =>
  Effect.gen(function* () {
    const client = yield* DaemonClient;

    yield* client.networks.configure({
      params: { network },
      payload: configuration,
      query: { ifSequence: 0 },
    });
    yield* readConfiguration(registry, network).pipe(Effect.ignore);

    return done;
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed(
        error._tag === "ConfigurationChanged"
          ? notDone(
              `${network} is already configured. Change it with /set ${optionName(network, ["*"])}`
            )
          : failedWith(error._tag, network)
      )
    )
  );

const credentialName = Schema.decodeUnknownOption(CredentialPathName);

/**
 * Holds a value for a Credential option, under the Credential it names, or the one the
 * core derives, then points the option at it. The value goes to the Vault in one request,
 * and is wiped once that has answered, whatever it said.
 * @param registry - The registry.
 * @param network - The Network.
 * @param path - The option's path.
 * @param value - The value.
 * @returns What it came to.
 */
const holdCredential = (
  registry: AtomRegistry.AtomRegistry,
  network: NetworkId,
  path: Path,
  value: Redacted.Redacted
) =>
  Effect.gen(function* () {
    const client = yield* DaemonClient;
    const read = yield* readConfiguration(registry, network);
    const named = credentialFor(network, read.configuration, path);

    if (named._tag === "Invalid") {
      return notDone(named.message);
    }

    const name = credentialName(named.value);

    if (Option.isNone(name)) {
      return notDone(`${named.value} cannot name a Credential the Daemon holds.`);
    }

    yield* client.credentials
      .set({ params: { name: name.value }, payload: { value } })
      .pipe(Effect.ensuring(Effect.sync(() => Redacted.wipeUnsafe(value))));
    yield* readHeld(registry);

    return yield* configureInTurn(registry, network, {
      _tag: "Point",
      credential: name.value,
      path,
    });
  }).pipe(
    (work) => inTurn(registry, network, work),
    Effect.ensuring(Effect.sync(() => Redacted.wipeUnsafe(value))),
    Effect.catch((error) => Effect.succeed(failedWith(error._tag, network)))
  );

/**
 * Says in the view what a change from it came to.
 * @param registry - The registry.
 * @param outcome - What it came to.
 */
export const told = (registry: AtomRegistry.AtomRegistry, outcome: Outcome) => {
  if (outcome._tag === "SignedOut") {
    signedOut(registry);

    return;
  }

  happened(registry, {
    _tag: "Noticed",
    message: outcome._tag === "NotDone" ? outcome.message : undefined,
  });
};

/**
 * Folds one event into the Timelines' navigation, which says what the main view shows.
 * @param registry - The registry.
 * @param event - What happened.
 */
const navigated = (registry: AtomRegistry.AtomRegistry, event: TimelinesEvent) => {
  registry.set(timelinesState, reduceTimelines(registry.get(timelinesState), event));
};

/** Whether a Pane shows the options, however they came to show. */
const optionsShown = Atom.make((get) => get(optionsFilter) !== undefined);

/** Whether a Pane shows the Uploads, however they came to show. */
export const uploadsShown = Atom.make((get) =>
  panesOf(get(timelinesState).layout.root).some((pane) => pane.view.main._tag === "Uploads")
);

/**
 * Whether the options under `store`, `uploads`, and `previews` are wanted: the options show
 * them, and the Uploads make their links from one of them.
 */
export const ownerWanted = Atom.make((get) => get(optionsShown) || get(uploadsShown));

/**
 * Reads every Network's Configuration, and the Credentials held, each time the options come
 * to show in a Pane, however they came to: `/set`, the sidebar, a Pane focused
 * or closed, or a layout restored with them showing. So what they show follows from their
 * showing, and nothing that shows them need remember to read. Mounted once for the page.
 */
export const optionsSync = runtime
  .atom((get) =>
    Effect.gen(function* () {
      if (get(signedIn) && get(optionsShown)) {
        yield* refresh(get.registry);
      }
    })
  )
  .pipe(Atom.keepAlive);

/**
 * Reads every Network's Configuration, and the Credentials held, again, so what the
 * Composer's list says of the options is as configured now, as `/set` is about to list them.
 */
export const readOptions = runtime
  .fn((_: undefined, get) => refresh(get.registry))
  .pipe(Atom.keepAlive);

/**
 * Shows the options in the main view, filtered as given, with nothing edited or asked.
 * Showing them reads what they show, by `optionsSync`, and asking again while they show
 * reads it again. Opening any Timeline, Escape, or their close button shows what the Pane
 * showed before.
 */
export const openOptions = runtime
  .fn((filter: string, get) =>
    Effect.gen(function* () {
      const again = get.registry.get(optionsShown);

      navigated(get.registry, { _tag: "OptionsShown", filter });
      happened(get.registry, { _tag: "Editing", name: undefined });
      happened(get.registry, { _tag: "Noticed", message: undefined });

      if (again) {
        yield* refresh(get.registry);
      }
    })
  )
  .pipe(Atom.keepAlive);

/**
 * Shows the Uploads in the Pane they show in, or the focused one, in front of what it
 * showed. What they show is read by `uploadsSync`, as they come to show.
 */
export const openUploads = Atom.fnSync((_, get) => {
  navigated(get.registry, { _tag: "UploadsShown" });
}).pipe(Atom.keepAlive);

/** Closes the Uploads, showing what their Pane showed before them. */
export const closeUploads = Atom.fnSync((_, get) => {
  navigated(get.registry, { _tag: "UploadsClosed" });
}).pipe(Atom.keepAlive);

/** Closes the options, showing what their Pane showed before them. */
export const closeOptions = Atom.fnSync((_, get) => {
  happened(get.registry, { _tag: "Editing", name: undefined });
  happened(get.registry, { _tag: "Confirming", name: undefined });
  navigated(get.registry, { _tag: "OptionsClosed" });
}).pipe(Atom.keepAlive);

/** Filters the options view as the Owner types. */
export const filterOptions = Atom.fnSync((filter: string, get) => {
  navigated(get.registry, { _tag: "OptionsFiltered", filter });
}).pipe(Atom.keepAlive);

/** Says in the view why something asked of it was not done, or lets go of what it said. */
export const notice = Atom.fnSync((message: string | undefined, get) => {
  happened(get.registry, { _tag: "Noticed", message });
}).pipe(Atom.keepAlive);

/** Starts or stops editing an option in place, by its name. */
export const editing = Atom.fnSync((name: string | undefined, get) => {
  happened(get.registry, { _tag: "Editing", name });
}).pipe(Atom.keepAlive);

/** Asks the Owner to confirm unsetting an option, by its name, or lets that go. */
export const confirming = Atom.fnSync((name: string | undefined, get) => {
  happened(get.registry, { _tag: "Confirming", name });
}).pipe(Atom.keepAlive);

/** Opens the password prompt for a Credential option, or closes it. */
export const promptCredential = Atom.fnSync((prompt: Asked | undefined, get) => {
  happened(get.registry, { _tag: "Prompting", prompt });
}).pipe(Atom.keepAlive);

/** Makes a change from the options view, and says there what it came to. */
export const change = runtime
  .fn(
    ({ edit, network }: { readonly network: NetworkId; readonly edit: Edit }, get) =>
      Effect.gen(function* () {
        happened(get.registry, { _tag: "Editing", name: undefined });
        told(get.registry, yield* configure(get.registry, network, edit));
      }),
    { concurrent: true }
  )
  .pipe(Atom.keepAlive);

/**
 * Holds the value the password prompt was given for its Credential option. The prompt
 * closes once it is held, and stays open saying why when it is not. The value is wiped
 * once the Vault has answered, so the argument this command keeps holds nothing.
 */
export const hold = runtime
  .fn(
    (
      {
        network,
        path,
        value,
      }: {
        readonly network: NetworkId;
        readonly path: Path;
        readonly value: Redacted.Redacted;
      },
      get
    ) =>
      Effect.gen(function* () {
        const outcome = yield* holdCredential(get.registry, network, path, value);

        told(get.registry, outcome);

        if (outcome._tag === "Done") {
          happened(get.registry, { _tag: "Prompting", prompt: undefined });
        }
      }),
    { concurrent: true }
  )
  .pipe(Atom.keepAlive);
