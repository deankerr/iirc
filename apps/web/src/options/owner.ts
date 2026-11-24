/**
 * The options under `store`, `uploads`, and `previews`, as atoms: the Owner's, so the same on every
 * device, with no override on any. They are followed from the Daemon while the page is
 * signed in and the options show, as nothing else here draws on them. A change is made
 * from the options read, as one under `ui` is, so the Daemon refuses it if another device
 * changed them in between, and is then read again and made once more, since a Change is
 * the whole value of one option. A Credential option's value goes straight from the
 * password prompt to the Vault, under the Credential the option names, or the one the core
 * derives, and the option is then set to that name.
 *
 * @packageDocumentation
 */
import { CredentialPathName } from "@iirc/api";
import type { OwnerInForce, OwnerOptionName } from "@iirc/api";
import type { Json } from "@iirc/frontend/options";
import { ownerCredentialFor } from "@iirc/frontend/options";
import { Effect, Option, Redacted, Schedule, Schema, Stream } from "effect";
import { Atom } from "effect/reactivity";
import type { AtomRegistry } from "effect/reactivity";

import { DaemonClient } from "../app/daemon-client.ts";
import { runtime } from "../app/runtime.ts";
import { signedIn } from "../sign-in/atoms.ts";
import { retrying, Waits } from "../timelines/atoms.ts";
import {
  editing,
  happened,
  onItsWay,
  optionsState,
  ownerWanted,
  readHeld,
  signedOut,
  told,
} from "./atoms.ts";
import type { Outcome } from "./atoms.ts";

/**
 * Folds the options, as read or followed, into the options' state, where an older read
 * never replaces a newer one. A read that lands once the page is signed out is dropped, so
 * what signing out forgot stays forgotten.
 * @param registry - The registry.
 * @param owner - The options, and the sequence of the last Change of one.
 */
const ownerRead = (registry: AtomRegistry.AtomRegistry, owner: OwnerInForce) => {
  if (registry.get(signedIn)) {
    happened(registry, { _tag: "OwnerRead", owner });
  }
};

/**
 * Reads the options now, and folds them in only when the page stayed signed in the whole
 * time the read took, as the options under `ui` are read.
 * @param registry - The registry.
 * @returns The options read.
 */
const readOwner = (registry: AtomRegistry.AtomRegistry) =>
  Effect.gen(function* () {
    const client = yield* DaemonClient;
    let stayed = registry.get(signedIn);

    const read = yield* Effect.acquireUseRelease(
      Effect.sync(() =>
        registry.subscribe(signedIn, (now) => {
          stayed &&= now;
        })
      ),
      () => client.options.read(),
      (unsubscribe) => Effect.sync(unsubscribe)
    );

    if (stayed) {
      ownerRead(registry, read);
    }

    return read;
  });

/**
 * While the browser is signed in and the options or the Uploads show, follows the options under `store`
 * and `uploads`, each event the options whole, from the ones in force, so another device's
 * change shows. Whenever the stream ends, or gives nothing for longer than three
 * heartbeats, it is followed again. A refusal signs the page out, and signed out, the
 * options are forgotten until they are read again. Mounted once.
 */
export const ownerSync = runtime
  .atom((get) =>
    Effect.gen(function* () {
      const { registry } = get;

      if (!get(signedIn)) {
        happened(registry, { _tag: "OwnerForgotten" });

        return;
      }

      if (!get(ownerWanted)) {
        return;
      }

      const client = yield* DaemonClient;
      const { idle, reconnect } = yield* Waits;
      const schedule = yield* retrying;

      // From no place each time, so the options in force come first, whatever was missed.
      const follow = Effect.gen(function* () {
        const events = yield* client.options
          .changes({ headers: {}, query: {} })
          .pipe(Effect.timeout(idle));

        yield* events.pipe(
          Stream.timeout(idle),
          // A Change may name a Credential another device just held, and the Vault is not
          // followed, so the names held are read again with it.
          Stream.runForEach((event) =>
            event.event === "changed"
              ? Effect.andThen(
                  Effect.sync(() => {
                    ownerRead(registry, event.data);
                  }),
                  readHeld(registry)
                )
              : Effect.void
          )
        );
      });

      yield* follow.pipe(
        Effect.retry({ schedule, while: (error) => error._tag !== "Unauthorized" }),
        Effect.repeat(Schedule.spaced(reconnect)),
        Effect.catchTag("Unauthorized", () =>
          Effect.sync(() => {
            signedOut(registry);
          })
        )
      );
    })
  )
  .pipe(Atom.keepAlive);

/** A change of an option under `store`, `uploads`, or `previews`: its value as JSON, or none to unset it. */
export interface OwnerChange {
  readonly option: OwnerOptionName;
  readonly value: Json | undefined;
}

/**
 * Why a change of the options failed, in words, from its error's tag.
 * @param tag - The error's tag.
 * @returns The outcome.
 */
const ownerFailed = (tag: string): Outcome => {
  switch (tag) {
    case "Unauthorized": {
      return { _tag: "SignedOut" };
    }

    case "OptionsChanged": {
      return {
        _tag: "NotDone",
        message:
          "The storage, uploads, and previews settings changed while this was being saved, so nothing was changed. Try again.",
      };
    }

    case "InvalidRequest": {
      return {
        _tag: "NotDone",
        message: "The daemon could not accept this as the setting's value.",
      };
    }

    case "JournalFailed": {
      return {
        _tag: "NotDone",
        message: "The daemon could not record this, so nothing was changed.",
      };
    }

    case "VaultFailed": {
      return {
        _tag: "NotDone",
        message: "The daemon could not write its passwords, so nothing was saved.",
      };
    }

    default: {
      return {
        _tag: "NotDone",
        message: "The daemon did not answer, so it's unknown whether this was changed.",
      };
    }
  }
};

/** A conflict: the options in force were not the ones the change was made from. */
const conflict = { _tag: "Conflict" } as const;

/**
 * One try at a change, made from the sequence read: the one this page holds, or one read
 * now when it holds none, or after a conflict. Once it is journaled, the options are read,
 * so this page shows it before the stream brings it.
 * @param registry - The registry.
 * @param change - The change.
 * @param fresh - Whether to read the options first, whatever this page holds.
 * @returns What it came to, or a conflict to try again.
 */
const tryOwner = (registry: AtomRegistry.AtomRegistry, change: OwnerChange, fresh: boolean) =>
  Effect.gen(function* () {
    const client = yield* DaemonClient;
    const held = registry.get(optionsState).owner;
    const from = fresh || held === undefined ? yield* readOwner(registry) : held;

    const params = { option: change.option };
    const query = { ifSequence: from.sequence };

    yield* change.value === undefined
      ? client.options.unset({ params, query })
      : client.options.set({ params, payload: { value: change.value }, query });

    yield* readOwner(registry);

    const done: Outcome = { _tag: "Done" };

    return done;
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed(error._tag === "OptionsChanged" ? conflict : ownerFailed(error._tag))
    )
  );

/**
 * Changes an option under `store`, `uploads`, or `previews` through the Daemon, made from the options
 * read and made once more after a conflict, and shown at once until the Daemon has answered.
 * @param registry - The registry.
 * @param change - The change.
 * @returns What it came to.
 */
export const changeOwner = (registry: AtomRegistry.AtomRegistry, change: OwnerChange) =>
  onItsWay(
    registry,
    { _tag: "Owner", option: change.option, value: change.value },
    Effect.gen(function* () {
      const first = yield* tryOwner(registry, change, false);

      if (first._tag !== "Conflict") {
        return first;
      }

      const second = yield* tryOwner(registry, change, true);

      return second._tag === "Conflict" ? ownerFailed("OptionsChanged") : second;
    })
  );

/** Makes a change of an option under `store`, `uploads`, or `previews` from the options view, and says there what it came to. */
export const changeOwnerOption = runtime
  .fn(
    (change: OwnerChange, get) =>
      Effect.gen(function* () {
        get.registry.set(editing, undefined);
        told(get.registry, yield* changeOwner(get.registry, change));
      }),
    { concurrent: true }
  )
  .pipe(Atom.keepAlive);

const credentialName = Schema.decodeUnknownOption(CredentialPathName);

/**
 * Holds a value for a Credential option under `store`, `uploads`, or `previews`, under the Credential
 * it names, or the one the core derives, then sets the option to that name. The value
 * goes to the Vault in one request, and is wiped once that has answered, whatever it said.
 * @param registry - The registry.
 * @param option - The option.
 * @param value - The value.
 * @returns What it came to.
 */
const holdOwnerCredential = (
  registry: AtomRegistry.AtomRegistry,
  option: OwnerOptionName,
  value: Redacted.Redacted
) =>
  Effect.gen(function* () {
    const client = yield* DaemonClient;
    const read = yield* readOwner(registry);
    const named = ownerCredentialFor(read.options, option);
    const name = credentialName(named);

    if (Option.isNone(name)) {
      return ownerFailed("InvalidRequest");
    }

    yield* client.credentials
      .set({ params: { name: name.value }, payload: { value } })
      .pipe(Effect.ensuring(Effect.sync(() => Redacted.wipeUnsafe(value))));
    yield* readHeld(registry);

    // Set even when the option already names it: the Vault is not followed, so this Change,
    // the same value again, is what tells every other device to read the names held again.
    return yield* changeOwner(registry, { option, value: name.value });
  }).pipe(
    Effect.ensuring(Effect.sync(() => Redacted.wipeUnsafe(value))),
    Effect.catch((error) => Effect.succeed(ownerFailed(error._tag)))
  );

/**
 * Holds the value the password prompt was given for its Credential option under `store` or
 * `uploads`. The prompt closes once it is held, and stays open saying why when it is not.
 */
export const holdOwner = runtime
  .fn(
    (
      { option, value }: { readonly option: OwnerOptionName; readonly value: Redacted.Redacted },
      get
    ) =>
      Effect.gen(function* () {
        const outcome = yield* holdOwnerCredential(get.registry, option, value);

        told(get.registry, outcome);

        if (outcome._tag === "Done") {
          happened(get.registry, { _tag: "Prompting", prompt: undefined });
        }
      }),
    { concurrent: true }
  )
  .pipe(Atom.keepAlive);
