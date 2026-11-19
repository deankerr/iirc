/**
 * Where the Daemon's API listens, as `iirc daemon` takes it and `iirc health` asks it.
 *
 * @packageDocumentation
 */
import { defaultListen } from "@iirc/daemon";
import type { Listen } from "@iirc/daemon";
import { Schema, SchemaGetter } from "effect";
import { Flag } from "effect/cli";

/** `host:port`, with an IPv6 host in brackets, such as `[::1]:7667`. */
export const ListenAddress = Schema.String.check(
  Schema.isPattern(/^(?:\[[0-9A-Fa-f:.]+\]|[^\s:[\]]+):\d{1,5}$/u, {
    message: "must be host:port, such as 127.0.0.1:7667 or [::1]:7667",
  })
).pipe(
  Schema.decodeTo(
    Schema.Struct({
      host: Schema.String,
      port: Schema.Int.check(Schema.isBetween({ maximum: 65_535, minimum: 0 })),
    }),
    {
      decode: SchemaGetter.transform((text: string) => {
        const colon = text.lastIndexOf(":");

        return {
          host: text.slice(0, colon).replace(/^\[(?<inner>.*)\]$/u, "$<inner>"),
          port: Number(text.slice(colon + 1)),
        };
      }),
      encode: SchemaGetter.transform(({ host, port }: Listen) =>
        host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`
      ),
    }
  )
);

/**
 * `--listen host:port`, `127.0.0.1:7667` unless given.
 * @param description - What the address is for.
 * @returns The flag.
 */
export const listenFlag = (description: string) =>
  Flag.String("listen").pipe(
    Flag.withSchema(ListenAddress),
    Flag.withDescription(description),
    Flag.withDefault(defaultListen)
  );
