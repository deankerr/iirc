/**
 * One row of a Timeline as a terminal line: the time, then a Message by its sender in
 * their colour, or a dimmer description of an Activity, marked in the senders' column as
 * WeeChat marks one, or of a Session, or a Gap or the day changing as a divider, each
 * one's words starting where a Message's text does. Under `ui.line` `inline`, and in a
 * Timeline too narrow for those columns, a row is one run of text that wraps under itself.
 * Under `stacked`, a run of plain speech from one User has its nick and time on a line above
 * the first Message's text, and each later Message is its text alone, its time shown while
 * its row is hovered or focused; every other row is drawn as under `inline`. Failed Connections in a row
 * say how many and when. A reply has what it answers above it, as a line that goes there
 * when pressed, and a Direct Message says which Channel it is about. A Message that can be
 * answered has a menu, opened by a button shown while its row is hovered or focused, and
 * always where the pointer is coarse, or by the context menu, as a right-click, the menu
 * key, or Shift+F10 opens it, which offers to reply. A Message's Previews, if it has any,
 * are under its text. A sender's nick, and a nick in an Activity's words, opens the menu on
 * that nick, whose context menu is its own. Every name and every text a Network sent sits
 * in its own isolate, as a text node.
 *
 * @packageDocumentation
 */
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { TimelineId, TimelineItem } from "@iirc/api";
import { churnOf } from "@iirc/frontend/churn";
import { replyOf } from "@iirc/frontend/composer";
import type { Answering } from "@iirc/frontend/composer";
import { churnLine, lineOf, quotedOf } from "@iirc/frontend/render";
import type { Delivery, Line as LineOfRow, Part } from "@iirc/frontend/render";
import type { Row } from "@iirc/frontend/timelines";
import { Fragment, useRef, useState } from "react";
import type { MouseEvent, ReactNode, RefObject } from "react";
import { Button as AriaButton, Menu, MenuItem, Popover } from "react-aria-components";

import { chooseReply, perform } from "../composer/atoms.ts";
import { NickButton } from "../nick/nick-menu.tsx";
import { dayShown, lineShown, timeShown } from "../options/ui.ts";
import { MessagePreviews } from "../previews/message-previews.tsx";
import { jumpTo } from "../search/atoms.ts";
import { Button } from "../ui/button.tsx";
import { clockFor, datedClockFor, hasSeconds, sampleOf } from "../ui/clock.ts";
import { dateOf, formattedAt } from "../ui/dates.ts";
import { dayIso, dayWritten } from "../ui/day.ts";
import { Icon } from "../ui/icon.tsx";
import { tagsOn } from "./atoms.ts";
import { Inlines } from "./inlines.tsx";

import styles from "./line.module.css";

/**
 * A time as the line shows it, as `ui.time` says, or nothing for `none`.
 * @param props - The instant.
 * @returns The time, with the full date and time on hover.
 */
const Time = ({
  at,
  className = styles.time,
  focusable = false,
}: {
  readonly at: number;
  readonly className?: string;
  readonly focusable?: boolean;
}) => {
  const shown = useAtomValue(timeShown);
  const date = dateOf(at);

  const sample = sampleOf(shown);

  // With no time shown, its column is still there, empty and with no width, so every row
  // keeps the same columns.
  if (shown === "none") {
    return <span className={className} />;
  }

  // An instant a Date cannot hold, as a hostile Ircd's `server-time` can give, is unavailable.
  if (date === undefined) {
    return (
      <span
        className={className}
        data-sample={sample}
        // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a later Message of a run shows its time only while focused.
        tabIndex={focusable ? 0 : undefined}
        title="Time unavailable"
      >
        {hasSeconds(shown) ? "--:--:--" : "--:--"}
      </span>
    );
  }

  return (
    <time
      className={className}
      data-sample={sample}
      dateTime={date.toISOString()}
      // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a later Message of a run shows its time only while focused.
      tabIndex={focusable ? 0 : undefined}
      title={datedClockFor(shown).format(date)}
    >
      {clockFor(shown).format(date)}
    </time>
  );
};

// One class for each of the core's colour slots, each reading the theme's `--nick-N`.
const nickClasses: readonly string[] = [
  styles.nick0,
  styles.nick1,
  styles.nick2,
  styles.nick3,
  styles.nick4,
  styles.nick5,
  styles.nick6,
  styles.nick7,
  styles.nick8,
  styles.nick9,
  styles.nick10,
  styles.nick11,
  styles.nick12,
  styles.nick13,
  styles.nick14,
  styles.nick15,
];

/**
 * A nick in its colour.
 * @param props - The nick and its colour slot.
 * @returns The nick.
 */
export const Nick = ({ colour, nick }: { readonly colour: number; readonly nick: string }) => (
  <bdi className={nickClasses[colour]}>{nick}</bdi>
);

// Delivery that failed, drawn as not sent.
const failed: ReadonlySet<Delivery> = new Set(["Unsent", "Rejected"]);

/**
 * What a reply answers, as one dim line above it that goes to that Message when pressed:
 * who said it, in their colour, and its text, cut to the line's width. A Message that
 * answers nothing the Timeline holds has none.
 * @param props - The reply, as an item.
 * @returns The line, or nothing.
 */
const Answered = ({ item }: { readonly item: TimelineItem }) => {
  const jump = useAtomSet(jumpTo);

  if (item.answered === null) {
    return null;
  }

  const quoted = quotedOf(item.answered);
  const nick = <Nick colour={quoted.colour} nick={quoted.nick} />;

  return (
    <>
      <div className={styles.answered}>
        <Button
          aria-label="Go to the message this answers"
          onPress={() => {
            jump({ position: quoted.position, timeline: item.timeline });
          }}
          size="small"
          variant="text"
        >
          <span className={styles.quote}>
            <span aria-hidden>{"\u21B3"}</span> {quoted.kind === "Action" ? <>* {nick}</> : null}
            {quoted.kind === "Notice" ? <>-{nick}-</> : null}
            {quoted.kind === "Privmsg" ? <>{nick}:</> : null} <bdi>{quoted.text}</bdi>
          </span>
        </Button>
      </div>{" "}
    </>
  );
};

/**
 * An offer to join a Channel, which does what `/join` does when pressed, and nothing sooner.
 * @param props - The Channel, and the Network whose Configuration joining changes.
 * @returns The button.
 */
const JoinOffer = ({
  channel,
  network,
}: {
  readonly channel: string;
  readonly network: Extract<Part, { readonly _tag: "Join" }>["network"];
}) => {
  const run = useAtomSet(perform);

  return (
    <Button
      aria-label={`Join ${channel}`}
      onPress={() => {
        run([{ _tag: "Configure", edit: { _tag: "Join", channels: [channel] }, network }]);
      }}
      size="small"
    >
      join
    </Button>
  );
};

/**
 * A piece of a description, a nick opening the menu on it.
 * @param props - The piece, and the Timeline it is shown in.
 * @returns It, as text.
 */
const Piece = ({ part, timeline }: { readonly part: Part; readonly timeline: TimelineId }) => {
  switch (part._tag) {
    case "Words": {
      return part.text;
    }

    case "Nick": {
      return (
        <NickButton nick={part.nick} timeline={timeline}>
          <Nick colour={part.colour} nick={part.nick} />
        </NickButton>
      );
    }

    case "Name": {
      return <bdi>{part.text}</bdi>;
    }

    case "Said": {
      return (
        <bdi>
          <Inlines inlines={part.inlines} />
        </bdi>
      );
    }

    case "Command": {
      return (
        <code>
          <bdi>{part.text}</bdi>
        </code>
      );
    }

    case "Join": {
      return <JoinOffer channel={part.channel} network={part.network} />;
    }

    default: {
      return part satisfies never;
    }
  }
};

/**
 * A Gap's words: when the Daemon was not connected, and how many times, if more than once.
 * @param props - The Gap.
 * @returns The divider.
 */
const GapLine = ({ gap }: { readonly gap: Extract<Row, { _tag: "Gap" }>["gap"] }) => {
  const format = useAtomValue(timeShown);
  const shown = clockFor(format);
  const from = formattedAt(shown, gap.from.at) ?? "an unknown time";
  const to = gap.to === null ? undefined : (formattedAt(shown, gap.to.at) ?? "an unknown time");

  const span =
    to === undefined ? `not connected since ${from}` : `not connected from ${from} to ${to}`;

  return (
    <p className={styles.gap}>
      <span className={styles.time} data-sample={sampleOf(format)} />
      <span aria-hidden className={styles.rule} />
      <span className={styles.gapText}>
        {span}
        {gap.count > 1 ? `, ${gap.count} times` : ""}
      </span>
    </p>
  );
};

/**
 * Where the day changes: the day's words, as `ui.day` says, after a rule. Its time column is
 * there and empty, so the line shows and lines up whether or not any line's time does. The
 * words offer to go to another day: pressed, they start `/date` with this day in the
 * composer, to change and send, so the line keeps its height.
 * @param props - The instant of the first item of the day.
 * @returns The divider.
 */
const DayLine = ({ at }: { readonly at: number }) => {
  const format = useAtomValue(timeShown);
  const start = useAtomSet(perform);
  const written = dayWritten(useAtomValue(dayShown), at);
  const iso = dayIso(at);

  return (
    <p className={styles.day}>
      <span className={styles.time} data-sample={sampleOf(format)} />
      <span aria-hidden className={styles.rule} />
      <span className={styles.dayText}>
        {written === undefined ? (
          "an unknown day"
        ) : (
          <AriaButton
            aria-label={`${written}: go to another day`}
            className={styles.dayGo}
            onPress={() => {
              // Written apart from `iso`, which HTML's dates bound at the year 1.
              start([{ _tag: "StartCommand", text: `/date ${dayWritten("iso", at) ?? ""}` }]);
            }}
          >
            <time dateTime={iso}>{written}</time>
          </AriaButton>
        )}
      </span>
    </p>
  );
};

/**
 * How many times a failed Connection repeated, and from when to when, as the times show.
 * @param props - How many, and the instants of the first and the latest.
 * @returns The words.
 */
const RepeatedWords = ({
  count,
  from,
  to,
}: {
  readonly count: number;
  readonly from: number;
  readonly to: number;
}) => {
  const shown = clockFor(useAtomValue(timeShown));
  const first = formattedAt(shown, from) ?? "an unknown time";
  const latest = formattedAt(shown, to) ?? "an unknown time";

  return <span className={styles.repeated}>{` \u00D7${count}, ${first}\u2013${latest}`}</span>;
};

/**
 * Each description's tone, as its class: Activity, a Session, and a refusal of ours are dim,
 * and a numeric's words are not.
 */
const toneClass = {
  Activity: styles.activity,
  // An Ircd's own words read as plainly as a Message's, beside their dim number.
  Numeric: styles.numeric,
  Refused: styles.refused,
  Session: styles.session,
} as const;

/**
 * What can be done with a Message from its row: reply to it.
 * @param props - The Message's sender, what answering it answers, its row, and what closes the menu.
 * @returns The menu, placed under its row.
 */
const MessageMenu = ({
  anchor,
  answering,
  nick,
  onClose,
  timeline,
}: {
  readonly anchor: RefObject<HTMLElement | null>;
  readonly answering: Answering;
  readonly nick: string;
  readonly onClose: () => void;
  readonly timeline: TimelineItem["timeline"];
}) => {
  const reply = useAtomSet(chooseReply);

  return (
    <Popover
      className={styles.popover}
      isOpen
      offset={0}
      onOpenChange={(isOpen) => {
        if (!isOpen) {
          onClose();
        }
      }}
      placement="bottom end"
      triggerRef={anchor}
    >
      <Menu
        aria-label={`What to do with the message from ${nick}`}
        autoFocus="first"
        className={styles.menu}
      >
        <MenuItem
          className={styles.action}
          id="reply"
          onAction={() => {
            onClose();
            reply({ answering, timeline });
          }}
          textValue="Reply"
        >
          Reply
        </MenuItem>
      </Menu>
    </Popover>
  );
};

/**
 * Where a Message stands: on a line of its own, or under `ui.line` stacked, a run's head or
 * a later Message of one.
 */
type Place = "Line" | "Head" | "Later";

/**
 * What comes before a Message's text: what it answers, the time, and the sender as said. A
 * run's head has its nick and time on a line of their own, with what it answers under them,
 * just above the text that answers it. A later Message of a run has its time alone, still
 * there for a screen reader and shown while the row is hovered or focused, and reached by
 * Tab when nothing else in the row takes focus.
 * @param props - The Message's item, its line, where it stands, and whether its time takes focus.
 * @returns What comes before its text.
 */
const Said = ({
  focusable,
  item,
  line,
  place,
}: {
  readonly focusable: boolean;
  readonly item: TimelineItem;
  readonly line: Extract<LineOfRow, { readonly _tag: "Message" }>;
  readonly place: Place;
}) => {
  const nick = (
    <NickButton nick={line.nick} timeline={item.timeline}>
      <Nick colour={line.colour} nick={line.nick} />
    </NickButton>
  );

  if (place === "Head") {
    return (
      <>
        <span className={styles.heading}>
          <span className={styles.headNick}>{nick}</span> <Time at={item.position.at} />
        </span>{" "}
        <Answered item={item} />
      </>
    );
  }

  if (place === "Later") {
    return (
      <>
        <Answered item={item} />
        <Time
          at={item.position.at}
          className={`${styles.time} ${styles.later}`}
          focusable={focusable}
        />{" "}
      </>
    );
  }

  return (
    <>
      <Answered item={item} />
      <Time at={item.position.at} />{" "}
      <span className={styles.sender}>
        <span className={styles.said}>
          {line.kind === "Privmsg" ? <>&lt;{nick}&gt;</> : null}
          {line.kind === "Notice" ? <>-{nick}-</> : null}
          {line.kind === "Action" ? <>* {nick}</> : null}
        </span>
      </span>{" "}
    </>
  );
};

/**
 * A Message's line: what it answers, the time, the sender as said, its text, how it fares
 * if it is ours, and its Previews, with its menu where it can be answered.
 * @param props - Its item, and its line.
 * @returns The line.
 */
const MessageLine = ({
  continues,
  item,
  line,
}: {
  readonly continues: boolean;
  readonly item: TimelineItem;
  readonly line: Extract<LineOfRow, { readonly _tag: "Message" }>;
}) => {
  const answering = replyOf(item, useAtomValue(tagsOn(item.network)));
  // Under stacked, plain speech is a run's head, with its nick and time on a line above
  // its text, or a later Message of one, with its text alone.
  const stacked = useAtomValue(lineShown) === "stacked" && line.kind === "Privmsg";
  let place: Place = "Line";

  if (stacked) {
    place = continues ? "Later" : "Head";
  }

  const [menu, setMenu] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const delivery = line.delivered;

  let tone = item.level === "Highlight" ? styles.highlight : styles.message;

  if (line.delivery !== undefined && failed.has(line.delivery)) {
    tone = styles.unsent;
  }

  // The context menu, from a pointer or the keyboard, opens the Message's menu in place of
  // the browser's, while there is something to offer.
  const onContextMenu = (event: MouseEvent<HTMLElement>) => {
    if (answering !== undefined) {
      event.preventDefault();
      setMenu(true);
    }
  };

  let classes = answering === undefined ? tone : `${tone} ${styles.menued}`;

  if (place !== "Line") {
    classes = `${classes} ${place === "Later" ? styles.continued : styles.head}`;
  }

  return (
    // oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- the menu's button is the row's control, and this only listens for the context menu.
    <div
      className={classes}
      data-menu={menu || undefined}
      onContextMenu={onContextMenu}
      ref={anchor}
      // A tap focuses a later Message of a run, which shows its time where nothing hovers.
      tabIndex={place === "Later" ? -1 : undefined}
    >
      <Said focusable={answering === undefined} item={item} line={line} place={place} />
      <bdi className={styles.text}>
        <Inlines inlines={line.text} />
        {line.context === undefined ? null : (
          <>
            {" "}
            <span className={styles.context}>
              in <bdi>{line.context}</bdi>
            </span>
          </>
        )}
      </bdi>
      {delivery === undefined ? null : (
        <>
          {" "}
          <span className={styles.delivery}>{delivery}</span>
        </>
      )}
      {answering === undefined ? null : (
        <AriaButton
          aria-label={`More for the message from ${line.nick}`}
          className={styles.more}
          onPress={() => {
            setMenu(true);
          }}
        >
          <Icon name="more" />
        </AriaButton>
      )}
      <MessagePreviews item={item} />
      {menu && answering !== undefined ? (
        <MessageMenu
          anchor={anchor}
          answering={answering}
          nick={line.nick}
          onClose={() => {
            setMenu(false);
          }}
          timeline={item.timeline}
        />
      ) : null}
    </div>
  );
};

/**
 * An Ircd's message of the day: one dim line that says what it is and how many lines it
 * has, and whether it was cut short, which a press, or Enter or Space, opens to a block of
 * its text and closes again. The block is monospace in any font, keeps every space, wraps
 * no line, and scrolls sideways within itself when a line is wider than the Pane. Whether it
 * is open is this view's alone.
 * @param props - Its time, and its line.
 * @returns The line.
 */
const MotdLine = ({
  line,
  time,
}: {
  readonly line: Extract<LineOfRow, { readonly _tag: "Motd" }>;
  readonly time: ReactNode;
}) => {
  const [open, setOpen] = useState(false);

  return (
    <div className={styles.motd}>
      {time}{" "}
      <span aria-hidden className={styles.marker}>
        {line.marker}
      </span>{" "}
      <span className={styles.motdText}>
        <AriaButton
          aria-expanded={open}
          className={styles.motdSummary}
          onPress={() => {
            setOpen(!open);
          }}
        >
          <Icon name={open ? "expanded" : "collapsed"} /> {line.summary}
        </AriaButton>
        {open ? (
          // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a block that scrolls sideways is reached by keyboard.
          <pre className={styles.motdBlock} tabIndex={0}>
            {line.lines.map((inlines, index) => (
              // A message's lines never move, so their order is their identity.
              // oxlint-disable-next-line react/no-array-index-key
              <Fragment key={index}>
                {index === 0 ? null : "\n"}
                <Inlines inlines={inlines} />
              </Fragment>
            ))}
          </pre>
        ) : null}
      </span>
    </div>
  );
};

/**
 * A description of an item, in the columns every row shares: its time, its marker, and its
 * words, with how many times a failed Connection repeated when it did.
 * @param props - The item, its line, and how often it repeated, if it did.
 * @returns The line.
 */
const DescribedLine = ({
  item,
  line,
  repeated,
}: {
  readonly item: TimelineItem;
  readonly line: Extract<LineOfRow, { readonly _tag: "Description" }>;
  readonly repeated: Extract<Row, { readonly _tag: "Item" }>["repeated"];
}) => (
  // An arrow says nothing a reader needs, but a numeric's number is its name.
  <div className={toneClass[line.tone]}>
    <Time at={item.position.at} />{" "}
    <span aria-hidden={line.tone !== "Numeric"} className={styles.marker}>
      {line.marker ?? ""}
    </span>{" "}
    <span className={styles.text}>
      {line.parts.map((part, index) => (
        // A description's pieces never move, so their order is their identity.
        // oxlint-disable-next-line react/no-array-index-key
        <Piece key={index} part={part} timeline={item.timeline} />
      ))}
      {repeated === undefined ? null : (
        <RepeatedWords count={repeated.count} from={repeated.from} to={item.position.at} />
      )}
    </span>
  </div>
);

/**
 * A run of joins, parts, quits, and changes of nick as one dim line, as the message of the
 * day is: how many of each and who, which a press, or Enter or Space, opens to each one's own
 * line under it, and closes again. Whether it is open is this view's alone. The nicks on the
 * folded line are only coloured, since a button holds them, and the lines under it open the
 * menu on a nick as any do.
 * @param props - The row, and the run's items, oldest first.
 * @returns The lines.
 */
const FoldedLines = ({
  items,
  row,
}: {
  readonly items: readonly TimelineItem[];
  readonly row: Extract<Row, { readonly _tag: "Item" }>;
}) => {
  const [open, setOpen] = useState(false);
  const line = churnLine(items.flatMap((item) => churnOf(item.content) ?? []));

  return (
    <>
      <div className={styles.motd}>
        <Time at={items[0]?.position.at ?? row.item.position.at} />{" "}
        <span aria-hidden className={styles.marker}>
          {line.marker}
        </span>{" "}
        <span className={styles.motdText}>
          <AriaButton
            aria-expanded={open}
            className={`${styles.motdSummary} ${styles.foldSummary}`}
            onPress={() => {
              setOpen(!open);
            }}
          >
            <Icon name={open ? "expanded" : "collapsed"} />{" "}
            {line.parts.map((part, index) =>
              part._tag === "Nick" ? (
                // The words' pieces never move, so their order is their identity.
                // oxlint-disable-next-line react/no-array-index-key
                <Nick colour={part.colour} key={index} nick={part.nick} />
              ) : (
                // oxlint-disable-next-line react/no-array-index-key
                <Piece key={index} part={part} timeline={row.item.timeline} />
              )
            )}
          </AriaButton>
        </span>
      </div>
      {open
        ? items.map((item) => {
            const each = lineOf(item.content, item.network);

            return each._tag === "Description" ? (
              <div className={styles.line} key={`${item.position.sequence}-${item.position.n}`}>
                <DescribedLine item={item} line={each} repeated={undefined} />
              </div>
            ) : null;
          })
        : null}
    </>
  );
};

/**
 * One row's line, in the columns every row shares: the time, the sender or a marker, and
 * the text, so an Activity's or a Session's words start where a Message's text does.
 * @param props - The row.
 * @returns The line.
 */
const RowLine = ({ row }: { readonly row: Row }) => {
  if (row._tag === "Gap") {
    return <GapLine gap={row.gap} />;
  }

  if (row._tag === "Day") {
    return <DayLine at={row.at} />;
  }

  if (row._tag === "New") {
    return (
      <p className={styles.new}>
        <span className={styles.newText}>new</span>
      </p>
    );
  }

  if (row.folded !== undefined) {
    return <FoldedLines items={row.folded} row={row} />;
  }

  const line = lineOf(row.item.content, row.item.network);
  const time = <Time at={row.item.position.at} />;

  // The spaces between a row's parts are ignored while they are the grid's columns, and
  // are what its words, as one run of text, are read and copied by when they are not.

  if (line._tag === "Motd") {
    return <MotdLine line={line} time={time} />;
  }

  if (line._tag === "Description") {
    return <DescribedLine item={row.item} line={line} repeated={row.repeated} />;
  }

  return <MessageLine continues={row.continues === true} item={row.item} line={line} />;
};

/**
 * One row, in the columns every row shares.
 * @param props - The row.
 * @returns The line.
 */
export const Line = ({ row }: { readonly row: Row }) => (
  <div className={styles.line}>
    <RowLine row={row} />
  </div>
);
