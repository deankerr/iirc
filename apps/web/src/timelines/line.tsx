/**
 * One row of a Timeline as a terminal line: the time, then a Message by its sender in
 * their colour, or a dimmer description of an Activity or a Session, or a Gap as a divider.
 * Every name and every text a Network sent sits in its own isolate, as a text node.
 *
 * @packageDocumentation
 */
import { lineOf } from "@iirc/frontend/render";
import type { Delivery, Part } from "@iirc/frontend/render";
import type { Row } from "@iirc/frontend/timelines";

import { Inlines } from "./inlines.tsx";

import styles from "./line.module.css";

// The Owner's own clock and time zone, which only the view reads.
const clock = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  hourCycle: "h23",
  minute: "2-digit",
});

const day = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/**
 * A time as the line shows it.
 * @param props - The instant.
 * @returns The time, HH:MM, with the full date and time on hover.
 */
const Time = ({ at }: { readonly at: number }) => {
  const date = new Date(at);

  return (
    <time className={styles.time} dateTime={date.toISOString()} title={day.format(date)}>
      {clock.format(date)}
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
const Nick = ({ colour, nick }: { readonly colour: number; readonly nick: string }) => (
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
  const from = clock.format(new Date(gap.from.at));
  const to = gap.to === null ? undefined : clock.format(new Date(gap.to.at));

  const span =
    to === undefined ? `not connected since ${from}` : `not connected from ${from} to ${to}`;

  return (
    <p className={styles.gap}>
      <span className={styles.gapText}>
        {span}
        {gap.count > 1 ? `, ${gap.count} times` : ""}
      </span>
    </p>
  );
};

/**
 * One row.
 * @param props - The row.
 * @returns The line.
 */
export const Line = ({ row }: { readonly row: Row }) => {
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

  const line = lineOf(row.item.content);
  const time = <Time at={row.item.position.at} />;

  if (line._tag === "Description") {
    return (
      <div className={line.tone === "Session" ? styles.session : styles.activity}>
        {time}
        <span className={styles.text}>
          {line.parts.map((part, index) => (
            // A description's pieces never move, so their order is their identity.
            // oxlint-disable-next-line react/no-array-index-key
            <Piece key={index} part={part} />
          ))}
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
      {time}
      <span className={styles.sender}>
        {line.kind === "Privmsg" ? <>&lt;{nick}&gt;</> : null}
        {line.kind === "Notice" ? <>-{nick}-</> : null}
        {line.kind === "Action" ? <>* {nick}</> : null}
      </span>
      <bdi className={styles.text}>
        <Inlines inlines={line.text} />
      </bdi>
      {delivery === undefined ? null : <span className={styles.delivery}>{delivery}</span>}
    </div>
  );
};
