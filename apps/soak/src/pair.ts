import { NetworkId } from "@iirc/api";
import { Schema, SchemaGetter } from "effect";

// A Target is one word an Ircd could route: no space, comma, or control character.
const Target = Schema.String.check(Schema.isPattern(/^[^\s,\p{Cc}]+$/u));

// A text with no separator has no second part, and decodes to a field every Schema here
// refuses, so the refusal names the text the Owner typed.
const splitOnce = (text: string, separator: string): readonly [string, string] => {
  const at = text.indexOf(separator);

  return at === -1 ? [text, ""] : [text.slice(0, at), text.slice(at + separator.length)];
};

/** Where `send` sends: a Network of the Daemon, and the Target on it. */
export const SendPair = Schema.Struct({ network: NetworkId, target: Target });

/** The decoded form of {@link SendPair}. */
export type SendPair = typeof SendPair.Type;

/** What `check` compares: the sender's Network, the receiver's, and the Target between. */
export const CheckPair = Schema.Struct({ receiver: NetworkId, sender: NetworkId, target: Target });

/** The decoded form of {@link CheckPair}. */
export type CheckPair = typeof CheckPair.Type;

/** `<networkId>=<target>`, such as `floor=#soak`. */
export const SendPairText = Schema.String.pipe(
  Schema.decodeTo(SendPair, {
    decode: SchemaGetter.transform((text) => {
      const [network, target] = splitOnce(text, "=");

      return { network, target };
    }),
    encode: SchemaGetter.transform(({ network, target }) => `${network}=${target}`),
  })
);

/** `<senderNetworkId>:<receiverNetworkId>=<target>`, such as `floor:floor=#soak`. */
export const CheckPairText = Schema.String.pipe(
  Schema.decodeTo(CheckPair, {
    decode: SchemaGetter.transform((text) => {
      const [networks, target] = splitOnce(text, "=");
      const [sender, receiver] = splitOnce(networks, ":");

      return { receiver, sender, target };
    }),
    encode: SchemaGetter.transform(
      ({ receiver, sender, target }) => `${sender}:${receiver}=${target}`
    ),
  })
);
