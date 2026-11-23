/**
 * A Pane's Lookup card: a transient panel under its header, over its Timeline, showing what
 * `/whois`, `/whowas`, `/names`, `/who`, or a Channel's list found, compact as the header is. Each User's
 * nick in their colour, which opens the menu on it, `user@host`, realname, server, idle and signed on, account, away,
 * the Channels with their prefixes, each opening its Timeline or starting `/join`, and the
 * numerics read for nothing, dimly. Each mask of a list with who set it and when, and,
 * while Self may, a button that removes it. Every text a Network sent is a text node in its
 * own isolate. Each member `/names` found as a wrapped nick with its prefix symbols, and each
 * User `/who` matched as one row of nick, `user@host`, away, and realname, dimly. Each Channel
 * `/list` found as a row of its name, which opens its Timeline or starts `/join`, its members,
 * and its topic, dimly, a page at a time, with a button that reads the next. Escape, in the
 * card or in the composer with nothing else to let go of, its close button, or Back puts it away.
 *
 * @packageDocumentation
 */
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { TimelineId } from "@iirc/api";
import type {
  ChannelShown,
  ListedShown,
  MaskShown,
  MemberShown,
  ProfileShown,
  SubjectShown,
  UserShown,
} from "@iirc/frontend/lookup";
import type { KeyboardEvent } from "react";
import { useId, useRef } from "react";

import { perform } from "../composer/atoms.ts";
import { NickButton } from "../nick/nick-menu.tsx";
import { useBackCloses } from "../page/back.ts";
import { paneTimeline } from "../timelines/atoms.ts";
import { Nick } from "../timelines/line.tsx";
import { Button, IconButton } from "../ui/button.tsx";
import { dismissCard, moreChannels, paneCard, removeMask } from "./atoms.ts";

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
        variant="text"
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
 * A nick that opens the menu on it, in the Timeline the card shows over, or only the nick
 * while that is unknown.
 * @param props - The nick as drawn, its colour, and the Timeline.
 * @returns The nick.
 */
const Who = ({
  colour,
  nick,
  timeline,
}: {
  readonly colour: number;
  readonly nick: string;
  readonly timeline: TimelineId | undefined;
}) =>
  timeline === undefined ? (
    <Nick colour={colour} nick={nick} />
  ) : (
    <NickButton nick={nick} timeline={timeline}>
      <Nick colour={colour} nick={nick} />
    </NickButton>
  );

/**
 * One User, as the reply described them, their nick opening the menu on it.
 * @param props - The User, and the Timeline the card shows over, if known.
 * @returns The profile.
 */
const Profile = ({
  profile,
  timeline,
}: {
  readonly profile: ProfileShown;
  readonly timeline: TimelineId | undefined;
}) => {
  const flags = [
    profile.operator ? "operator" : undefined,
    profile.secure ? "secure connection" : undefined,
    profile.idle,
    profile.signon,
  ].filter((one) => one !== undefined);

  return (
    <div className={styles.profile}>
      <p className={styles.line}>
        <Who colour={profile.colour} nick={profile.nick} timeline={timeline} />
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
      <Field label="connects from" value={profile.actual} />
      <Field label="modes" value={profile.modes} />
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
 * One mask of a Channel's list: the mask, or for a ban by account, a dim word `account` and
 * the account, then the mask dimly, who set it and when, dimly, and while Self may, a
 * button that removes the mask, which the card then no longer shows.
 * @param props - The mask, and the Pane whose card it is on.
 * @returns The mask.
 */
const Mask = ({ mask, pane }: { readonly mask: MaskShown; readonly pane: string }) => {
  const removeOne = useAtomSet(removeMask);
  const { remove } = mask;
  const set = [mask.setBy, mask.setAt].filter((one) => one !== undefined);

  return (
    <li className={styles.mask}>
      {mask.account === undefined ? (
        <bdi>{mask.mask}</bdi>
      ) : (
        <>
          <span className={styles.dim}>account</span> <bdi>{mask.account}</bdi>{" "}
          <bdi className={styles.dim}>{mask.mask}</bdi>
        </>
      )}
      {set.length === 0 ? null : (
        <span className={styles.dim}>
          {" set by "}
          {mask.setBy === undefined ? null : <bdi>{mask.setBy}</bdi>}
          {mask.setBy !== undefined && mask.setAt !== undefined ? ", " : null}
          {mask.setAt}
        </span>
      )}
      {remove === undefined ? null : (
        <IconButton
          className={styles.remove}
          icon="close"
          label={`Remove ${mask.mask}`}
          onPress={() => {
            removeOne({ act: remove.act, mask: remove.mask, pane });
          }}
          size="small"
        />
      )}
    </li>
  );
};

/**
 * One member of a Channel: the symbols of their prefixes, dimly, and their nick.
 * @param props - The member, and the Timeline the card shows over, if known.
 * @returns The member.
 */
const Member = ({
  member,
  timeline,
}: {
  readonly member: MemberShown;
  readonly timeline: TimelineId | undefined;
}) => (
  <li aria-label={member.label} className={styles.member}>
    {member.symbols === "" ? null : <bdi className={styles.symbol}>{member.symbols}</bdi>}
    <Who colour={member.colour} nick={member.nick} timeline={timeline} />
  </li>
);

/**
 * One User a `WHO` matched, in a row: nick, `user@host`, away, and realname, dimly.
 * @param props - The User, and the Timeline the card shows over, if known.
 * @returns The User.
 */
const Matched = ({
  timeline,
  user,
}: {
  readonly timeline: TimelineId | undefined;
  readonly user: UserShown;
}) => (
  <li className={styles.user}>
    <Who colour={user.colour} nick={user.nick} timeline={timeline} />
    <bdi className={styles.dim}>{user.mask}</bdi>
    {user.away ? <span className={styles.dim}>away</span> : null}
    {user.realname === undefined ? null : <bdi className={styles.dim}>{user.realname}</bdi>}
  </li>
);

/**
 * One of the Network's Channels, in a row: its name, which opens its Timeline or starts
 * `/join` when chosen, or is text while it cannot be, its members, and its topic, dimly.
 * @param props - The Channel.
 * @returns The Channel.
 */
const Listed = ({ listed }: { readonly listed: ListedShown }) => {
  const run = useAtomSet(perform);
  const { choose } = listed;

  return (
    <li className={styles.listed}>
      {choose === undefined ? (
        <bdi aria-label={listed.label} className={styles.name}>
          {listed.name}
        </bdi>
      ) : (
        <Button
          aria-label={`${choose._tag === "Open" ? "Open" : "Join"} ${listed.label}`}
          className={styles.name}
          onPress={() => {
            run([choose]);
          }}
          variant="text"
        >
          <bdi>{listed.name}</bdi>
        </Button>
      )}
      <span className={`${styles.count} ${styles.dim}`}>{listed.members}</span>
      {listed.topic === undefined ? null : (
        <bdi className={`${styles.topic} ${styles.dim}`}>{listed.topic}</bdi>
      )}
    </li>
  );
};

/**
 * What a card looked up: a nick in its colour, a Channel's name, or a mask.
 * @param props - What it looked up.
 * @returns It.
 */
const Subject = ({ subject }: { readonly subject: SubjectShown }) => {
  switch (subject._tag) {
    case "Nick": {
      return <Nick colour={subject.colour} nick={subject.nick} />;
    }

    case "Mask": {
      return <bdi>{subject.mask}</bdi>;
    }

    case "Directory": {
      return <bdi>{subject.words}</bdi>;
    }

    case "Channel": {
      return <bdi>{subject.name}</bdi>;
    }

    default: {
      return subject satisfies never;
    }
  }
};

/** What each Lookup is called in its card's heading. */
const kindWords = {
  Bans: "bans",
  Channels: "channels",
  Exceptions: "exceptions",
  Invitations: "invitation masks",
  Names: "names",
  Who: "who",
  Whois: "whois",
  Whowas: "whowas",
} as const;

/**
 * A Pane's Lookup card, while it has one for the Timeline it shows.
 * @param props - The Pane.
 * @returns The card, or nothing.
 */
export const LookupCard = ({ pane }: { readonly pane: string }) => {
  const shown = useAtomValue(paneCard(pane));
  const opened = useAtomValue(paneTimeline(pane));
  const timeline = "timeline" in opened ? opened.timeline : undefined;
  const dismiss = useAtomSet(dismissCard);
  const run = useAtomSet(perform);
  const more = useAtomSet(moreChannels);
  const headingId = useId();

  const section = useRef<HTMLElement>(null);

  // Back puts it away as Escape does, and the composer takes the focus if it was in it.
  useBackCloses(shown !== undefined, () => {
    const inside = section.current?.contains(document.activeElement) === true;

    dismiss(pane);

    if (inside) {
      run([{ _tag: "FocusComposer", text: undefined }]);
    }
  });

  if (shown === undefined) {
    return null;
  }

  // Put away from inside it, the composer takes the focus.
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
    <section
      aria-labelledby={headingId}
      className={styles.card}
      onKeyDown={onKeyDown}
      ref={section}
    >
      <div className={styles.head}>
        <h3 className={styles.heading} id={headingId}>
          <span className={styles.dim}>{kindWords[shown.kind]} </span>
          <Subject subject={shown.subject} />
        </h3>
        <IconButton
          className={styles.close}
          icon="close"
          keys="Esc"
          label="Close the Lookup"
          onPress={() => {
            close();
          }}
          size="small"
        />
      </div>
      <div aria-live="polite" className={styles.body}>
        {body._tag === "Profiles" ? (
          <>
            {body.note === undefined ? null : <p className={styles.note}>{body.note}</p>}
            {body.profiles.map((profile, index) => (
              // A User's place in the reply tells two apart, and it never moves.
              // oxlint-disable-next-line react/no-array-index-key
              <Profile key={index} profile={profile} timeline={timeline} />
            ))}
          </>
        ) : null}
        {body._tag === "Masks" ? (
          <>
            {body.note === undefined ? null : <p className={styles.note}>{body.note}</p>}
            <ul aria-label="Masks" className={styles.masks}>
              {body.masks.map((mask, index) => (
                // A mask holds no state of its own, so one a removal moves draws the same.
                // oxlint-disable-next-line react/no-array-index-key
                <Mask key={index} mask={mask} pane={pane} />
              ))}
            </ul>
          </>
        ) : null}
        {body._tag === "Members" ? (
          <>
            {body.note === undefined ? null : <p className={styles.note}>{body.note}</p>}
            <ul aria-label="Members" className={styles.members}>
              {body.members.map((member, index) => (
                // A member's place in the reply tells two apart, and it never moves.
                // oxlint-disable-next-line react/no-array-index-key
                <Member key={index} member={member} timeline={timeline} />
              ))}
            </ul>
          </>
        ) : null}
        {body._tag === "Users" ? (
          <>
            {body.note === undefined ? null : <p className={styles.note}>{body.note}</p>}
            <ul aria-label="Users" className={styles.users}>
              {body.users.map((user, index) => (
                // A User's place in the reply tells two apart, and it never moves.
                // oxlint-disable-next-line react/no-array-index-key
                <Matched key={index} timeline={timeline} user={user} />
              ))}
            </ul>
          </>
        ) : null}
        {body._tag === "Directory" ? (
          <>
            {body.note === undefined ? null : <p className={styles.note}>{body.note}</p>}
            <ul aria-label="Channels" className={styles.directory}>
              {body.channels.map((listed, index) => (
                // A Channel's place in the list tells two apart, and a page only adds after it.
                // oxlint-disable-next-line react/no-array-index-key
                <Listed key={index} listed={listed} />
              ))}
            </ul>
            {body.more === undefined ? null : (
              <p className={styles.more}>
                <Button
                  isPending={body.more.reading}
                  onPress={() => {
                    more(pane);
                  }}
                  size="small"
                >
                  More Channels
                </Button>
                <span className={styles.dim}>{body.more.words} shown</span>
              </p>
            )}
          </>
        ) : null}
        {body._tag === "Waiting" || body._tag === "Said" ? (
          <p className={body._tag === "Waiting" ? styles.dim : styles.note}>{body.words}</p>
        ) : null}
        {shown.notes.map((note, index) => (
          // A note's place in the reply tells two apart, and it never moves.
          // oxlint-disable-next-line react/no-array-index-key
          <p className={styles.dim} key={index}>
            {note}
          </p>
        ))}
      </div>
    </section>
  );
};
