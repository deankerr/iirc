/**
 * The sign-in screen: a key goes to the Daemon once, for a sign-in the browser holds in a
 * cookie no script can read.
 *
 * @packageDocumentation
 */
import { useAtomSet } from "@effect/atom-react";
import { SignInRequest } from "@iirc/api";
import { explain } from "@iirc/frontend/sign-in";
import type { Attempt } from "@iirc/frontend/sign-in";
import { Option, Schema } from "effect";
import type { Redacted } from "effect";
import { useId } from "react";
import { Form } from "react-aria-components";
import type { FormProps } from "react-aria-components";

import { Button } from "../ui/button.tsx";
import { PasswordField } from "../ui/password-field.tsx";
import { signInWithKey } from "./atoms.ts";

import styles from "./sign-in-screen.module.css";

const parseKey = Schema.decodeUnknownOption(SignInRequest);

/**
 * Reads the key from the form as it is submitted, empties the field, and hands the key to
 * the sign-in command redacted, parsed as the API's own request. The form is read in one
 * expression, so no `FormData` or plain string outlives it, and a key that does not parse
 * leaves no error holding it. Each field's value is then set to `""` before the form is
 * reset: a reset alone leaves the last value typed in the tracker React DOM keeps on every
 * input, controlled or not, and setting it clears that too. So once the key is sent, only
 * the `Redacted` the command wipes holds it.
 * @param signIn - The command.
 * @returns The submit handler.
 */
const submitted =
  (signIn: (key: Redacted.Redacted) => void): NonNullable<FormProps["onSubmit"]> =>
  (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const entered = parseKey(Object.fromEntries(new FormData(form)));

    for (const field of form.querySelectorAll("input")) {
      field.value = "";
    }

    form.reset();

    if (Option.isSome(entered)) {
      signIn(entered.value.key);
    }
  };

/**
 * Asks for a key, and says in words why a sign-in failed.
 * @param props - The attempt to sign in.
 * @returns The screen.
 */
export const SignInScreen = ({ attempt }: { readonly attempt: Attempt }) => {
  const signIn = useAtomSet(signInWithKey);
  const failureId = useId();

  return (
    <main className={styles.screen}>
      <Form className={styles.form} onSubmit={submitted(signIn)}>
        <h1 className={styles.title}>iirc</h1>
        <p className={styles.hint}>
          Sign in with a key. Make one with <code>iirc key create &lt;name&gt;</code>.
        </p>
        <PasswordField
          autoComplete="current-password"
          errorId={attempt._tag === "Failed" ? failureId : undefined}
          label="Key"
          name="key"
        />
        {attempt._tag === "Failed" ? (
          <p className={styles.failure} id={failureId} role="alert">
            {explain(attempt.failure)}
          </p>
        ) : null}
        <div className={styles.actions}>
          <Button isPending={attempt._tag === "Waiting"} type="submit" variant="primary">
            {attempt._tag === "Waiting" ? "Signing in…" : "Sign in"}
          </Button>
        </div>
      </Form>
    </main>
  );
};
