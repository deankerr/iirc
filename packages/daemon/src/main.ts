#!/usr/bin/env bun
import { BunHttpServer, BunRuntime, BunServices, BunSocket } from "@effect/platform-bun";
import { DaemonApi } from "@iirc/api";
import { Effect, Layer } from "effect";
import { Command, Flag } from "effect/cli";
import { HttpRouter } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";

import { Daemon } from "./daemon.ts";
import { handlers } from "./http.ts";

const flags = {
  channel: Flag.String("channel").pipe(
    Flag.withDescription("Channel to join once registered"),
    Flag.atLeast(0)
  ),
  host: Flag.String("host").pipe(Flag.withDescription("Hostname of the Ircd")),
  httpPort: Flag.Int("http-port").pipe(
    Flag.withDescription("Loopback port the API listens on"),
    Flag.withDefault(7667)
  ),
  nick: Flag.String("nick").pipe(Flag.withDescription("Nick to register with")),
  port: Flag.Int("port").pipe(Flag.withDescription("Port of the Ircd"), Flag.withDefault(6697)),
  realname: Flag.String("realname").pipe(
    Flag.withDescription("Real name to register with"),
    Flag.withDefault("iirc")
  ),
  tls: Flag.Boolean("tls").pipe(
    Flag.withDescription("Connect with TLS. Pass --no-tls for plaintext."),
    Flag.withDefault(true)
  ),
  username: Flag.String("username").pipe(
    Flag.withDescription("Username to register with"),
    Flag.withDefault("iirc")
  ),
};

const daemon = Command.make(
  "iirc-daemon",
  flags,
  Effect.fn("daemon")(function* ({ channel, host, httpPort, nick, port, realname, tls, username }) {
    const socket = yield* tls
      ? BunSocket.makeTls({ host, port, servername: host })
      : BunSocket.makeNet({ host, port });

    const api = HttpRouter.serve(HttpApiBuilder.layer(DaemonApi).pipe(Layer.provide(handlers)), {
      disableLogger: true,
    }).pipe(
      Layer.provide(BunHttpServer.layer({ hostname: "127.0.0.1", port: httpPort })),
      Layer.provide(Daemon.layer({ channels: channel, nick, realname, socket, username }))
    );

    return yield* Layer.launch(api);
  })
).pipe(Command.withDescription("Stay on one Network and expose it over HTTP"));

Command.run(daemon, { version: "0.0.0" }).pipe(
  Effect.provide(BunServices.layer),
  BunRuntime.runMain
);
