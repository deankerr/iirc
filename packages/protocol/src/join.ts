import { outbound } from "./outbound.ts";
import type { OutboundLine } from "./outbound.ts";

/** A Channel to join, with its key if it has one. */
export interface JoinChannel {
  readonly key?: string;
  readonly name: string;
}

/** Why a Channel cannot go in any `JOIN` Line. */
export type JoinRejection = "InvalidChannel" | "InvalidKey" | "TooLong";

/** The Lines to send, and the Channels none of them could carry. */
export interface JoinLines {
  readonly lines: readonly OutboundLine[];
  readonly rejected: readonly {
    readonly channel: JoinChannel;
    readonly reason: JoinRejection;
  }[];
}

// A comma would be read as a second Channel, and a space as the end of the list.
const isListItem = (item: string) => !/[\0\r\n ,]/u.test(item);

const isValidName = (name: string) => name !== "" && !name.startsWith(":") && isListItem(name);

const hasKey = ({ key }: JoinChannel) => key !== undefined && key !== "";

const joinLine = (channels: readonly JoinChannel[]) => {
  const keys = channels.flatMap(({ key }) => (key === undefined || key === "" ? [] : [key]));

  return outbound("JOIN", [
    channels.map(({ name }) => name).join(","),
    ...(keys.length > 0 ? [keys.join(",")] : []),
  ]);
};

const rejectionOf = (channel: JoinChannel): JoinRejection | undefined => {
  if (!isValidName(channel.name)) {
    return "InvalidChannel";
  }

  if (!isListItem(channel.key ?? "")) {
    return "InvalidKey";
  }

  return joinLine([channel])._tag === "Safe" ? undefined : "TooLong";
};

/**
 * Batches Channels into `JOIN` Lines by byte length (SEND-11). Keys are positional, so
 * keyed Channels go first and each Line's keys line up with its first Channels. An
 * empty key is no key.
 * @param channels - The Channels to join.
 * @returns The Lines, and any Channel that fits in none of them, with the reason.
 */
export const joinLines = (channels: readonly JoinChannel[]): JoinLines => {
  const lines: OutboundLine[] = [];
  const rejected: { channel: JoinChannel; reason: JoinRejection }[] = [];
  let batch: JoinChannel[] = [];

  const flush = () => {
    const built = joinLine(batch);

    if (batch.length > 0 && built._tag === "Safe") {
      lines.push(built.line);
    }
  };

  const keyedFirst = [
    ...channels.filter((channel) => hasKey(channel)),
    ...channels.filter((channel) => !hasKey(channel)),
  ];

  for (const channel of keyedFirst) {
    const reason = rejectionOf(channel);

    if (reason !== undefined) {
      rejected.push({ channel, reason });
    } else if (joinLine([...batch, channel])._tag === "Safe") {
      batch.push(channel);
    } else {
      flush();
      batch = [channel];
    }
  }

  flush();

  return { lines, rejected };
};
