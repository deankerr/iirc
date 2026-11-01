#!/usr/bin/env bun
import { BunHttpServer, BunRuntime, BunServices } from "@effect/platform-bun";
import { DaemonCore } from "@iirc/daemon";
import { ApiRoutes } from "@iirc/daemon/routes";
import { Config, Duration, Effect, Layer, Schema } from "effect";
import { Command, Flag } from "effect/cli";
import { HttpRouter } from "effect/http";

import { version } from "../package.json";

// AUTH-5: the API listens on loopback, and remote access goes through a proxy.
const apiHost = "127.0.0.1";

// Stopping must not wait for a Frontend that is slow to hang up.
const shutdownTimeout = Duration.seconds(1);

const Port = Schema.Int.check(Schema.isBetween({ maximum: 65_535, minimum: 1 }));

const flags = {
  channel: Flag.String("channel").pipe(
    Flag.withDescription("Channel to join once registered, repeatable"),
    Flag.atLeast(0)
  ),
  dataDir: Flag.String("data-dir").pipe(
    Flag.withDescription("Directory holding the Log"),
    Flag.withFallbackConfig(Config.String("IIRC_DATA_DIR"))
  ),
  host: Flag.String("host").pipe(Flag.withDescription("Hostname of the Ircd")),
  httpPort: Flag.Int("http-port").pipe(
    Flag.withSchema(Port),
    Flag.withDescription("Loopback port the API listens on"),
    Flag.withDefault(7667)
  ),
  network: Flag.String("network").pipe(
    Flag.withDescription("Name of the Network, which its history is kept under"),
    Flag.withDefault("default")
  ),
  nick: Flag.String("nick").pipe(Flag.withDescription("Nick to register with")),
  port: Flag.Int("port").pipe(
    Flag.withSchema(Port),
    Flag.withDescription("Port of the Ircd"),
    Flag.withDefault(6697)
  ),
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
  "daemon",
  flags,
  ({ channel, dataDir, host, httpPort, network, nick, port, realname, tls, username }) =>
    HttpRouter.serve(ApiRoutes, { disableLogger: true }).pipe(
      Layer.provide(
        BunHttpServer.layer({
          gracefulShutdownTimeout: shutdownTimeout,
          hostname: apiHost,
          port: httpPort,
        })
      ),
      // Outside `serve`, which forks the MemoMap.
      Layer.provide(
        DaemonCore({
          dataDir,
          input: { channels: channel, nick, realname, username },
          ircd: { host, port, tls },
          network,
          version,
        })
      ),
      Layer.launch
    )
).pipe(Command.withDescription("Stay on one Network and expose it over the API"));

const iirc = Command.make("iirc").pipe(
  Command.withDescription("An always-on IRC client"),
  Command.withSubcommands([daemon])
);

Command.run(iirc, { version }).pipe(Effect.provide(BunServices.layer), BunRuntime.runMain);
