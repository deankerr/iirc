#!/usr/bin/env bun
import { BunHttpServer, BunRuntime, BunServices } from "@effect/platform-bun";
import { Daemon, DaemonCore } from "@iirc/daemon";
import { ApiRoutes } from "@iirc/daemon/routes";
import { TuningFromJson } from "@iirc/daemon/tuning";
import { Cause, Config, Duration, Effect, Exit, Layer, Runtime, Schema } from "effect";
import { Command, Flag } from "effect/cli";
import { HttpRouter } from "effect/http";

import { version } from "../package.json";

// AUTH-5: the API listens on loopback, and remote access goes through a proxy.
const apiHost = "127.0.0.1";

// How long past `quitWaitMillis` a Frontend may take to hang up once the Network has gone:
// at least the second `hostNetwork` allows itself past that wait.
const frontendWait = 1500;

const Port = Schema.Int.check(Schema.isBetween({ maximum: 65_535, minimum: 1 }));

const flags = {
  alternateNick: Flag.String("alternate-nick").pipe(
    Flag.withDescription("Nick to try when the nick is taken, repeatable, in order"),
    Flag.atLeast(0)
  ),
  channel: Flag.String("channel").pipe(
    Flag.withDescription("Channel to autojoin once registered, repeatable"),
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
  quitReason: Flag.String("quit-reason").pipe(
    Flag.withDescription("What QUIT says when the Daemon stops"),
    Flag.withDefault("iirc")
  ),
  realname: Flag.String("realname").pipe(
    Flag.withDescription("Real name to register with"),
    Flag.withDefault("iirc")
  ),
  tls: Flag.Boolean("tls").pipe(
    Flag.withDescription("Connect with TLS. Pass --no-tls for plaintext."),
    Flag.withDefault(true)
  ),
  tuning: Flag.String("tuning").pipe(
    Flag.withDescription(
      'JSON overriding any Tuning number, such as {"reconnectInitialMillis":1000}'
    ),
    Flag.withDefault("{}"),
    Flag.withSchema(TuningFromJson)
  ),
  username: Flag.String("username").pipe(
    Flag.withDescription("Username to register with"),
    Flag.withDefault("iirc")
  ),
};

const daemon = Command.make(
  "daemon",
  flags,
  ({
    alternateNick,
    channel,
    dataDir,
    host,
    httpPort,
    network,
    nick,
    port,
    quitReason,
    realname,
    tls,
    tuning,
    username,
  }) =>
    Daemon.stopsFirst.pipe(
      Layer.provide(
        HttpRouter.serve(ApiRoutes, { disableLogger: true }).pipe(
          Layer.provide(
            BunHttpServer.layer({
              gracefulShutdownTimeout: Duration.millis(tuning.quitWaitMillis + frontendWait),
              hostname: apiHost,
              port: httpPort,
            })
          )
        )
      ),
      // Outside `serve`, which forks the MemoMap.
      Layer.provide(
        DaemonCore({
          dataDir,
          network: {
            channels: channel.map((name) => ({ name })),
            id: network,
            identity: { alternates: alternateNick, nick, realname, username },
            ircds: [{ host, port, tls }],
            quitReason,
            tuning,
          },
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

// `runMain` interrupts main on SIGINT and SIGTERM, which is how a Daemon is asked to stop,
// so here an interrupt is a clean exit, and the default would call it 130.
const teardown: Runtime.Teardown = (exit, onExit) => {
  if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) {
    onExit(0);
  } else {
    Runtime.defaultTeardown(exit, onExit);
  }
};

Command.run(iirc, { version }).pipe(
  Effect.provide(BunServices.layer),
  BunRuntime.runMain({ teardown })
);
