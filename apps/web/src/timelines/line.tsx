/**
 * One row of a Timeline as a terminal line: the time, then a Message by its sender in
 * their colour, or a dimmer description of an Activity, marked in the senders' column as
 * WeeChat marks one, or of a Session, or a Gap as a divider, each one's words starting
 * where a Message's text does. In a Timeline too narrow for those columns, a row is one
 * run of text that wraps under itself. Failed Connections in a row say how many and when.
 * Every name and every text a Network sent sits in its own isolate, as a text node.
 *
 * @packageDocumentation
 */
import { useAtomValue } from "@effect/atom-react";
import type { TimeShown } from "@iirc/api";
import { lineOf } from "@iirc/frontend/render";
import type { Delivery, Part } from "@iirc/frontend/render";
import type { Row } from "@iirc/frontend/timelines";

import { timeShown } from "../options/ui.ts";
import { dateOf, formattedAt } from "../ui/dates.ts";
import { Inlines } from "./inlines.tsx";

import styles from "./line.module.css";

// The Owner's own clock and time zone, which only the view reads.
const clock = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  hourCycle: "h23",
  minute: "2-digit",
});

const clockWithSeconds = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  hourCycle: "h23",
  minute: "2-digit",
  second: "2-digit",
});

const day = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/**
 * The clock a time is shown by, as `ui.time` says: with seconds for `HH:mm:ss`, and
 * without them otherwise, as a Gap's times always show.
 * @param shown - How a line's time shows.
 * @returns The clock.
 */
const clockFor = (shown: TimeShown) => (shown === "HH:mm:ss" ? clockWithSeconds : clock);

/**
 * A time as the line shows it, as `ui.time` says, or nothing for `none`.
 * @param props - The instant.
 * @returns The time, with the full date and time on hover.
 */
const Time = ({ at }: { readonly at: number }) => {
  const shown = useAtomValue(timeShown);
  const date = dateOf(at);

  // With no time shown, its column is still there, empty and with no width, so every row
  // keeps the same columns.
  if (shown === "none") {
    return <span className={styles.time} />;
  }

  // An instant a Date cannot hold, as a hostile Ircd's `server-time` can give, is unavailable.
  if (date === undefined) {
    return (
      <span className={styles.time} title="Time unavailable">
        {shown === "HH:mm:ss" ? "--:--:--" : "--:--"}
      </span>
    );
  }

  return (
    <time className={styles.time} dateTime={date.toISOString()} title={day.format(date)}>
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
 * A piece of a description.
 * @param props - The piece.
 * @returns It, as text.
 */
const Piece = ({ part }: { readonly part: Part }) => {
  switch (part._tag) {
    case "Words": {
      return part.text;
    }

    case "Nick": {
      return <Nick colour={part.colour} nick={part.nick} />;
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
  const shown = clockFor(useAtomValue(timeShown));
  const from = formattedAt(shown, gap.from.at) ?? "an unknown time";
  const to = gap.to === null ? undefined : (formattedAt(shown, gap.to.at) ?? "an unknown time");

  const span =
    to === undefined ? `not connected since ${from}` : `not connected from ${from} to ${to}`;

  return (
    <p className={styles.gap}>
      <span className={styles.time} />
      <span aria-hidden className={styles.rule} />
      <span className={styles.gapText}>
        {span}
        {gap.count > 1 ? `, ${gap.count} times` : ""}
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

/** The column widths each row shares, as how the time shows says. */
const timedClass = {
  "HH:mm": styles.timed,
  "HH:mm:ss": styles.seconds,
  none: styles.untimed,
} as const;

/** Each description's tone, as its class: a refused action of ours is dim, like Activity. */
const toneClass = {
  Activity: styles.activity,
  Refused: styles.refused,
  Session: styles.session,
} as const;

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

  if (row._tag === "New") {
    return (
      <p className={styles.new}>
        <span className={styles.newText}>new</span>
      </p>
    );
  }

  const line = lineOf(row.item.content, row.item.network);
  const time = <Time at={row.item.position.at} />;

  // The spaces between a row's parts are ignored while they are the grid's columns, and
  // are what its words, as one run of text, are read and copied by when they are not.

  if (line._tag === "Description") {
    const { repeated } = row;

    return (
      <div className={toneClass[line.tone]}>
        {time}{" "}
        <span aria-hidden className={styles.marker}>
          {line.marker ?? ""}
        </span>{" "}
        <span className={styles.text}>
          {line.parts.map((part, index) => (
            // A description's pieces never move, so their order is their identity.
            // oxlint-disable-next-line react/no-array-index-key
            <Piece key={index} part={part} />
          ))}
          {repeated === undefined ? null : (
            <RepeatedWords count={repeated.count} from={repeated.from} to={row.item.position.at} />
          )}
        </span>
      </div>
    );
  }

  const delivery = line.delivered;
  const nick = <Nick colour={line.colour} nick={line.nick} />;
  let tone = row.item.level === "Highlight" ? styles.highlight : styles.message;

  if (line.delivery !== undefined && failed.has(line.delivery)) {
    tone = styles.unsent;
  }

  return (
    <div className={tone}>
      {time}{" "}
      <span className={styles.sender}>
        {line.kind === "Privmsg" ? <>&lt;{nick}&gt;</> : null}
        {line.kind === "Notice" ? <>-{nick}-</> : null}
        {line.kind === "Action" ? <>* {nick}</> : null}
      </span>{" "}
      <bdi className={styles.text}>
        <Inlines inlines={line.text} />
      </bdi>
      {delivery === undefined ? null : (
        <>
          {" "}
          <span className={styles.delivery}>{delivery}</span>
        </>
      )}
    </div>
  );
};

/**
 * One row, in the columns every row shares, as wide as how the time shows says.
 * @param props - The row.
 * @returns The line.
 */
export const Line = ({ row }: { readonly row: Row }) => (
  <div className={`${styles.line} ${timedClass[useAtomValue(timeShown)]}`}>
    <RowLine row={row} />
  </div>
);
