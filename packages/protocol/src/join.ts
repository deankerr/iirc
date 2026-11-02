import { maxLineBytes, outbound } from "./outbound.ts";
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

/**
 * What a Channel name starts with: the `CHANTYPES` of every Ircd on the floor, together.
 * `JOIN 0` leaves every Channel, so a name that needs no prefix could do that.
 */
export const channelPrefixes = ["#", "&", "+", "!"] as const;

const channelName = new RegExp(`^[${channelPrefixes.join("")}][^\\0\\u0007\\r\\n ,]*$`, "u");

/**
 * Whether a name is a Channel's: it starts with one of {@link channelPrefixes}, and holds
 * nothing that would end it early in a list, nor a BEL, which RFC 2812 forbids.
 * @param name - The name.
 * @returns Whether it is one.
 */
export const isChannelName = (name: string): boolean => channelName.test(name);

const hasKey = ({ key }: JoinChannel) => key !== undefined && key !== "";

const joinLine = (channels: readonly JoinChannel[]) => {
  const keys = channels.flatMap(({ key }) => (key === undefined || key === "" ? [] : [key]));

  return outbound("JOIN", [
    channels.map(({ name }) => name).join(","),
    ...(keys.length > 0 ? [keys.join(",")] : []),
  ]);
};

// No UTF-16 unit takes more than 3 bytes, so a short Channel fits without building its
// Line. Settings can list tens of thousands, and each is checked on the event loop.
const surelyFits = ({ key = "", name }: JoinChannel) =>
  "JOIN  :".length + 3 * (name.length + key.length) <= maxLineBytes;

/**
 * Why a Channel cannot go in any `JOIN` Line, even alone, if it cannot.
 * @param channel - The Channel, with its key if it has one.
 * @returns The reason, or nothing if a `JOIN` can carry it.
 */
export const joinRejection = (channel: JoinChannel): JoinRejection | undefined => {
  if (!isChannelName(channel.name)) {
    return "InvalidChannel";
  }

  if (!isListItem(channel.key ?? "")) {
    return "InvalidKey";
  }

  return surelyFits(channel) || joinLine([channel])._tag === "Safe" ? undefined : "TooLong";
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
    const reason = joinRejection(channel);

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
