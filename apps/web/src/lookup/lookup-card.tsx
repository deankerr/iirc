/**
 * A Pane's Lookup card: a transient panel under its header, over its Timeline, showing what
 * `/whois` or `/whowas` found, compact as the header is. Each User's nick in their colour,
 * `user@host`, realname, server, idle and signed on, account, away, the Channels with their
 * prefixes, each opening its Timeline or starting `/join`, and the numerics read for
 * nothing, dimly. Every text a Network sent is a text node in its own isolate. Escape, in
 * the card or in the composer with nothing else to let go of, or its close button, puts
 * it away.
 *
 * @packageDocumentation
 */
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { ChannelShown, ProfileShown } from "@iirc/frontend/lookup";
import type { KeyboardEvent } from "react";
import { useId } from "react";

import { perform } from "../composer/atoms.ts";
import { Nick } from "../timelines/line.tsx";
import { Button } from "../ui/button.tsx";
import { dismissCard, paneCard } from "./atoms.ts";

import styles from "./lookup-card.module.css";

/**
 * One Channel a User is in: their prefixes' symbols, and its name, which opens its Timeline
 * or starts `/join` when chosen, or is text while it cannot be.
 * @param props - The Channel.
 * @returns The Channel.
 */
const Channel = ({ channel }: { readonly channel: ChannelShown }) => {
  const run = useAtomSet(perform);
  const { choose } = channel;

  const text = (
    <>
      {channel.symbols === "" ? null : <bdi className={styles.symbol}>{channel.symbols}</bdi>}
      <bdi>{channel.name}</bdi>
    </>
  );

  if (choose === undefined) {
    return (
      <li aria-label={channel.label} className={styles.channel}>
        {text}
      </li>
    );
  }

  return (
    <li className={styles.channel}>
      <Button
        aria-label={`${choose._tag === "Open" ? "Open" : "Join"} ${channel.label}`}
        onPress={() => {
          run([choose]);
        }}
      >
        {text}
      </Button>
    </li>
  );
};

/**
 * A field the reply said, labelled dimly, its value in an isolate.
 * @param props - Its label and value.
 * @returns The field, or nothing when unsaid.
 */
const Field = ({ label, value }: { readonly label: string; readonly value: string | undefined }) =>
  value === undefined ? null : (
    <p className={styles.field}>
      <span className={styles.dim}>{label} </span>
      <bdi>{value}</bdi>
    </p>
  );

/**
 * One User, as the reply described them.
 * @param props - The User.
 * @returns The profile.
 */
const Profile = ({ profile }: { readonly profile: ProfileShown }) => {
  const flags = [
    profile.operator ? "operator" : undefined,
    profile.secure ? "secure connection" : undefined,
    profile.idle,
    profile.signon,
  ].filter((one) => one !== undefined);

  return (
    <div className={styles.profile}>
      <p className={styles.line}>
        <Nick colour={profile.colour} nick={profile.nick} />
        {profile.mask === undefined ? null : <bdi className={styles.dim}>{profile.mask}</bdi>}
        {profile.realname === undefined ? null : <bdi>{profile.realname}</bdi>}
      </p>
      {profile.server === undefined ? null : (
        <p className={styles.field}>
          <span className={styles.dim}>on </span>
          <bdi>{profile.server.name}</bdi>
          {profile.server.info === "" ? null : (
            <span className={styles.dim}>
              {" — "}
              <bdi>{profile.server.info}</bdi>
            </span>
          )}
        </p>
      )}
      {flags.length === 0 ? null : <p className={styles.dim}>{flags.join(" · ")}</p>}
      <Field label="account" value={profile.account} />
      <Field label="away:" value={profile.away} />
      {profile.channels.length === 0 ? null : (
        <ul aria-label="Channels" className={styles.channels}>
          {profile.channels.map((channel, index) => (
            // A Channel's place in the reply tells two apart, and it never moves.
            // oxlint-disable-next-line react/no-array-index-key
            <Channel channel={channel} key={index} />
          ))}
        </ul>
      )}
      {profile.other.map((one, index) => (
        // A numeric's place in the reply tells two apart, and it never moves.
        // oxlint-disable-next-line react/no-array-index-key
        <p className={`${styles.field} ${styles.dim}`} key={index}>
          <bdi>{one.numeric}</bdi> <bdi>{one.text}</bdi>
        </p>
      ))}
    </div>
  );
};

/**
 * A Pane's Lookup card, while it has one for the Timeline it shows.
 * @param props - The Pane.
 * @returns The card, or nothing.
 */
export const LookupCard = ({ pane }: { readonly pane: string }) => {
  const shown = useAtomValue(paneCard(pane));
  const dismiss = useAtomSet(dismissCard);
  const run = useAtomSet(perform);
  const headingId = useId();

  if (shown === undefined) {
    return null;
  }

  // Put away from inside it, the composer takes the focus, as after the palette.
  const close = () => {
    dismiss(pane);
    run([{ _tag: "FocusComposer", text: undefined }]);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  };

  const { body } = shown;

  return (
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- Escape anywhere in the card puts it away, as in a dialog.
    <section aria-labelledby={headingId} className={styles.card} onKeyDown={onKeyDown}>
      <div className={styles.head}>
        <h3 className={styles.heading} id={headingId}>
          <span className={styles.dim}>{shown.kind === "Whois" ? "whois" : "whowas"} </span>
          <Nick colour={shown.colour} nick={shown.nick} />
        </h3>
        <Button
          aria-label="Close the Lookup"
          onPress={() => {
            close();
          }}
        >
          close
        </Button>
      </div>
      <div aria-live="polite" className={styles.body}>
        {body._tag === "Profiles" ? (
          <>
            {body.note === undefined ? null : <p className={styles.note}>{body.note}</p>}
            {body.profiles.map((profile, index) => (
              // A User's place in the reply tells two apart, and it never moves.
              // oxlint-disable-next-line react/no-array-index-key
              <Profile key={index} profile={profile} />
            ))}
          </>
        ) : (
          <p className={body._tag === "Waiting" ? styles.dim : styles.note}>{body.words}</p>
        )}
      </div>
    </section>
  );
};
