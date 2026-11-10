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
import type { Edit, Naming, OptionsEvent, Path, Configuration } from "@iirc/frontend/options";
import {
  apply,
  credentialFor,
  initialOptions,
  listed,
  optionName,
  reduceOptions,
  unknownNaming,
} from "@iirc/frontend/options";
import { reduce as reduceSignIn } from "@iirc/frontend/sign-in";
import { reduceTimelines } from "@iirc/frontend/timelines";
import type { TimelinesEvent } from "@iirc/frontend/timelines";
import { Effect, Option, Redacted, Schema } from "effect";
import { Atom } from "effect/reactivity";
import type { AtomRegistry } from "effect/reactivity";

import { DaemonClient } from "../app/daemon-client.ts";
import { runtime } from "../app/runtime.ts";
import { signInState } from "../sign-in/atoms.ts";
import { timelinesState } from "../timelines/atoms.ts";

/** The options view, as the core folds it. */
export const optionsState = Atom.make(initialOptions).pipe(Atom.keepAlive);

/** What the main view shows: the open Timeline, or the options with their filter. */
export const mainView = Atom.make((get) => get(timelinesState).main);

/** The options the view lists, filtered as the main view says. */
export const optionRows = Atom.make((get) => {
  const main = get(mainView);

  return listed(get(optionsState), main._tag === "Options" ? main.filter : "");
});

/**
 * Folds one event into the options view.
 * @param registry - The registry.
 * @param event - What happened.
 */
const happened = (registry: AtomRegistry.AtomRegistry, event: OptionsEvent) => {
  registry.set(optionsState, reduceOptions(registry.get(optionsState), event));
};

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
 * Reads the names of the Credentials the Vault holds into the view.
 * @param registry - The registry.
 * @returns Once read, or not.
 */
const readHeld = (registry: AtomRegistry.AtomRegistry) =>
  Effect.gen(function* () {
    const client = yield* DaemonClient;
    const { names } = yield* client.credentials.list();

    happened(registry, { _tag: "Held", names });
  }).pipe(Effect.ignore);

/**
 * Reads every Network's Configuration, and the Credentials held, into the view.
 * @param registry - The registry.
 * @returns Once read.
 */
export const refresh = (registry: AtomRegistry.AtomRegistry) =>
  Effect.gen(function* () {
    const client = yield* DaemonClient;
    const entries = yield* client.networks.list();
    const networks = entries.map((entry) => entry.network);

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
    yield* readHeld(registry);
  }).pipe(Effect.ignore);

/**
 * What the Daemon reports of a Network that bears on its Channels' names, read only for an
 * edit of its Channels: the casemapping an Ircd declared, and `CHANTYPES`. A read that
 * fails is taken as knowing neither, so names are compared exactly and none is prefixed.
 * @param network - The Network.
 * @param edit - The edit.
 * @returns What it reports.
 */
const namingOf = (network: NetworkId, edit: Edit) =>
  Effect.gen(function* () {
    if (edit._tag !== "Join" && edit._tag !== "Part" && edit._tag !== "PartTimeline") {
      return unknownNaming;
    }

    const client = yield* DaemonClient;
    const known = yield* client.networks.known({ params: { network } });

    const naming: Naming = {
      casemapping: known.declared ?? undefined,
      chantypes: known.chantypes ?? undefined,
    };

    return naming;
  }).pipe(Effect.orElseSucceed(() => unknownNaming));

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

/**
 * Makes a change to a Network's Configuration. If another changed it between the read and
 * the write, it is read again and the same edit applied once more.
 * @param registry - The registry.
 * @param network - The Network.
 * @param edit - The edit.
 * @returns What it came to.
 */
export const configure = (registry: AtomRegistry.AtomRegistry, network: NetworkId, edit: Edit) =>
  Effect.gen(function* () {
    const first = yield* tryOnce(registry, network, edit);

    if (first._tag !== "Conflict") {
      return first;
    }

    const second = yield* tryOnce(registry, network, edit);

    return second._tag === "Conflict" ? failedWith("ConfigurationChanged", network) : second;
  });

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

    return yield* configure(registry, network, {
      _tag: "Point",
      credential: name.value,
      path,
    });
  }).pipe(
    Effect.ensuring(Effect.sync(() => Redacted.wipeUnsafe(value))),
    Effect.catch((error) => Effect.succeed(failedWith(error._tag, network)))
  );

/**
 * Signs the page out, when a request was refused for its sign-in.
 * @param registry - The registry.
 */
export const signedOut = (registry: AtomRegistry.AtomRegistry) => {
  registry.set(signInState, reduceSignIn(registry.get(signInState), { _tag: "Refused" }));
};

/**
 * Says in the view what a change from it came to.
 * @param registry - The registry.
 * @param outcome - What it came to.
 */
const told = (registry: AtomRegistry.AtomRegistry, outcome: Outcome) => {
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

/**
 * Shows the options in the main view, filtered as given, with nothing edited or asked, and
 * reads what they show. Opening any Timeline shows it again.
 */
export const openOptions = runtime
  .fn((filter: string, get) =>
    Effect.gen(function* () {
      navigated(get.registry, { _tag: "OptionsShown", filter });
      happened(get.registry, { _tag: "Editing", name: undefined });
      happened(get.registry, { _tag: "Noticed", message: undefined });
      yield* refresh(get.registry);
    })
  )
  .pipe(Atom.keepAlive);

/** Filters the options view as the Owner types. */
export const filterOptions = Atom.fnSync((filter: string, get) => {
  navigated(get.registry, { _tag: "OptionsFiltered", filter });
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
export const promptCredential = Atom.fnSync(
  (prompt: { readonly network: NetworkId; readonly path: Path } | undefined, get) => {
    happened(get.registry, { _tag: "Prompting", prompt });
  }
).pipe(Atom.keepAlive);

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
