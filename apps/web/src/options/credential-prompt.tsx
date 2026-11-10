/**
 * The password prompt for a Credential option, opened by `/set <option>` alone or by Enter
 * on the option in the options view. A Credential's value is never typed anywhere else.
 * The field is sign-in's: a plain, uncontrolled `<input type="password">`, read once as the
 * form is submitted, parsed as the API's own `CredentialValue`, straight to `Redacted`,
 * then emptied, which clears React DOM's tracker too, and the form reset. The value goes
 * to `PUT /api/credentials/{name}` and the option is pointed at it.
 *
 * @packageDocumentation
 */
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { CredentialValue } from "@iirc/api";
import type { Prompt } from "@iirc/frontend/options";
import { Option, Schema } from "effect";
import type { KeyboardEvent } from "react";
import { useId } from "react";
import { Form } from "react-aria-components";
import type { FormProps } from "react-aria-components";

import { Button } from "../ui/button.tsx";
import { PasswordField } from "../ui/password-field.tsx";
import { hold, optionsState, promptCredential } from "./atoms.ts";

import styles from "./credential-prompt.module.css";

const parseValue = Schema.decodeUnknownOption(CredentialValue);

/**
 * The prompt for one option.
 * @param props - The option, and why the last value was not held, if it was not.
 * @returns The prompt.
 */
const Asking = ({
  notice,
  prompt,
}: {
  readonly prompt: Prompt;
  readonly notice: string | undefined;
}) => {
  const holdNow = useAtomSet(hold);
  const close = useAtomSet(promptCredential);
  const noticeId = useId();

  // Read in one expression, emptied, and reset, whether or not it parsed, so only the
  // `Redacted` the command wipes ever holds the value.
  const onSubmit: NonNullable<FormProps["onSubmit"]> = (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const entered = parseValue(Object.fromEntries(new FormData(form)));

    for (const field of form.querySelectorAll("input")) {
      field.value = "";
    }

    form.reset();

    if (Option.isSome(entered)) {
      holdNow({ network: prompt.network, path: prompt.path, value: entered.value.value });
    }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      close(undefined);
    }
  };

  return (
    <Form aria-label={`Hold ${prompt.name}`} className={styles.prompt} onSubmit={onSubmit}>
      <PasswordField
        autoComplete="new-password"
        autoFocus
        errorId={notice === undefined ? undefined : noticeId}
        label={`New value for ${prompt.name}`}
        name="value"
      />
      {notice === undefined ? null : (
        <p className={styles.failure} id={noticeId} role="alert">
          {notice}
        </p>
      )}
      <div className={styles.actions}>
        <Button onKeyDown={onKeyDown} type="submit" variant="primary">
          Hold it
        </Button>
        <Button
          onKeyDown={onKeyDown}
          onPress={() => {
            close(undefined);
          }}
        >
          Cancel
        </Button>
      </div>
    </Form>
  );
};

/**
 * The password prompt, while one is asked for.
 * @returns The prompt, or nothing.
 */
export const CredentialPrompt = () => {
  const { notice, prompting } = useAtomValue(optionsState);

  return prompting === undefined ? null : (
    <Asking key={prompting.name} notice={notice} prompt={prompting} />
  );
};
