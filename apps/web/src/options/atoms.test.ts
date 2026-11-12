// @vitest-environment happy-dom
import { NetworkId, TimelineId } from "@iirc/api";
import type { Timeline } from "@iirc/api";
import { draftOf } from "@iirc/frontend/composer";
import { Redacted, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { composerState, edit, send } from "../composer/atoms.ts";
import { check } from "../sign-in/atoms.ts";
import {
  eventually,
  fakeDaemon,
  holds,
  liberaConfiguration,
  registryFor,
  run,
  until,
} from "../testing/fake-daemon.ts";
import { open, openTimeline, sync } from "../timelines/atoms.ts";
import { hold, mainView, openOptions, optionRows, optionsState, optionsSync } from "./atoms.ts";

const hex = (value: number, digits: number) => value.toString(16).padStart(digits, "0");
const idOf = (sequence: number) => `${hex(sequence, 14)}-00000000-00000000`;
const channel = Schema.decodeSync(TimelineId)(idOf(2));
const libera = Schema.decodeSync(NetworkId)("libera");

const describeTimeline = (
  id: string,
  name: string,
  kind: "Network" | "Channel"
): typeof Timeline.Encoded => ({
  changed: 1,
  detached: false,
  head: null,
  id,
  key: kind === "Network" ? null : name,
  kind,
  latest: null,
  name,
  network: "libera",
  read: null,
  unread: { activity: 0, direct: 0, highlights: 0, messages: 0 },
});

/**
 * A Daemon with one Network, configured, and `#iirc` open in a browser signed in to it.
 * @returns The fake, the registry, and a way to type a line into `#iirc`'s composer.
 */
const configuring = async () => {
  const fake = fakeDaemon();

  fake.daemon.signedIn = true;
  fake.daemon.nextSequence = 5;
  fake.daemon.timelines.set("libera", [
    { gaps: [], items: [], timeline: describeTimeline(idOf(1), "libera", "Network") },
    { gaps: [], items: [], timeline: describeTimeline(idOf(2), "#iirc", "Channel") },
  ]);

  const registry = registryFor(fake.fetch);

  await run(registry, check, undefined);
  registry.mount(sync);
  registry.mount(optionsSync);
  await eventually(() => fake.daemon.followers.length === 1);
  registry.set(open, channel);
  await until(registry, openTimeline, (shown) => shown._tag === "Shown");

  const type = async (text: string, place: typeof channel | "Nowhere" = channel) => {
    registry.set(edit, { text, timeline: place });
    await run(registry, send, place);
  };

  const notice = (place: typeof channel | "Nowhere" = channel) =>
    draftOf(registry.get(composerState), place).notice?.message;

  const inForce = () => fake.daemon.configurations.get("libera");

  return { ...fake, inForce, notice, registry, type };
};

describe("the options", () => {
  it("reads every Network's Configuration and the Credentials held into the view, filtered", async () => {
    const { daemon, registry } = await configuring();

    daemon.credentials.set("libera.sasl", "not shown");
    await run(registry, openOptions, "*nicks");
    await until(registry, optionsState, (state) => state.held !== undefined);

    expect({
      held: registry.get(optionsState).held,
      rows: registry.get(optionRows).map((option) => [option.name, option.value]),
      shown: registry.get(mainView),
    }).toStrictEqual({
      held: new Set(["libera.sasl"]),
      rows: [["network.libera.nicks", { _tag: "Shown", text: "iirc" }]],
      shown: { _tag: "Options", back: { _tag: "Timeline" }, filter: "*nicks" },
    });
  });

  it("opens the view from /set, filtered by a pattern, and lets a Timeline take the main view back", async () => {
    const { registry, type } = await configuring();

    await type("/set network.libera.*");
    await until(registry, optionRows, (rows) => rows.length > 0);
    const opened = registry.get(mainView);
    const first = registry.get(optionRows)[0]?.name;

    registry.set(open, channel);

    expect({ closed: registry.get(mainView), first, opened }).toStrictEqual({
      closed: { _tag: "Timeline" },
      first: "network.libera.channels",
      opened: { _tag: "Options", back: { _tag: "Timeline" }, filter: "network.libera.*" },
    });
  });

  it("sets an option made from the Configuration read, and shows what it became", async () => {
    const { daemon, inForce, registry, type } = await configuring();

    await type("/set network.libera.nicks dean, dean_");

    expect({
      nicks: inForce()?.configuration.nicks,
      puts: daemon.puts,
      read: registry.get(optionsState).networks.get(libera)?._tag,
    }).toStrictEqual({
      nicks: ["dean", "dean_"],
      puts: [{ ifSequence: "1", network: "libera" }],
      read: "Read",
    });
  });

  it("reads again and makes the same edit once more when another Frontend changed it first", async () => {
    const { daemon, inForce, notice, type } = await configuring();

    daemon.interject = 1;
    await type("/set network.libera.enabled off");

    expect({
      configuration: inForce()?.configuration,
      notice: notice(),
      puts: daemon.puts,
    }).toStrictEqual({
      // Both changes stand: the other Frontend's realname, and our enabled.
      configuration: { ...liberaConfiguration, enabled: false, realname: "changed elsewhere" },
      notice: undefined,
      puts: [
        { ifSequence: "1", network: "libera" },
        { ifSequence: "5", network: "libera" },
      ],
    });
  });

  it("says so in words when it conflicts again, and changes nothing of its own", async () => {
    const { daemon, inForce, notice, type } = await configuring();

    daemon.interject = 2;
    await type("/set network.libera.enabled off");

    expect({
      enabled: inForce()?.configuration.enabled,
      notice: notice(),
      puts: daemon.puts.length,
    }).toStrictEqual({
      enabled: true,
      notice:
        "libera's Configuration changed while this was being made, twice, so nothing was changed. Try again.",
      puts: 2,
    });
  });

  it("joins and parts Channels of the open Timeline's Network, /part with none parting the open one", async () => {
    const { inForce, type } = await configuring();

    await type("/join #new,#more");
    const joined = inForce()?.configuration.channels;

    await type("/part");
    const parted = inForce()?.configuration.channels;

    expect({ joined, parted }).toStrictEqual({
      joined: [{ name: "#iirc" }, { name: "#new" }, { name: "#more" }],
      parted: [{ name: "#new" }, { name: "#more" }],
    });
  });

  it("adds a Network with no Timeline open, and never replaces one already configured", async () => {
    const { daemon, notice, type } = await configuring();

    await type("/network add oftc irc.oftc.net bot", "Nowhere");
    await type("/network add libera irc.libera.chat bot", "Nowhere");

    expect({
      added: daemon.configurations.get("oftc")?.configuration,
      notice: notice("Nowhere"),
      puts: daemon.puts,
    }).toStrictEqual({
      added: {
        channels: [],
        declined: [],
        enabled: true,
        fallbackEncoding: "windows-1252",
        highlights: [],
        ircds: [{ host: "irc.oftc.net", port: 6697, tls: true }],
        login: { _tag: "None" },
        nicks: ["bot"],
        realname: "bot",
        username: "bot",
      },
      notice: "libera is already configured. Change it with /set network.libera.*",
      puts: [
        { ifSequence: "0", network: "oftc" },
        { ifSequence: "0", network: "libera" },
      ],
    });
  });

  it("asks for a Credential's value in a prompt, and refuses one typed into the composer", async () => {
    const { daemon, notice, registry, type } = await configuring();
    const secret = "hunter2-correct-horse";

    await type("/set network.libera.login.credential");
    const { prompting } = registry.get(optionsState);

    await type(`/set network.libera.password ${secret}`);

    expect({
      draft: draftOf(registry.get(composerState), channel).text,
      held: daemon.credentials.size,
      history: draftOf(registry.get(composerState), channel).history,
      inAtoms: holds(registry, secret),
      notice: notice(),
      prompting,
    }).toStrictEqual({
      draft: "",
      held: 0,
      history: ["/set network.libera.login.credential"],
      inAtoms: false,
      notice:
        "A Credential's value is never typed into the composer. It was cleared, and nothing was sent. Use /set network.libera.password alone, which asks for it in a password prompt.",
      prompting: {
        name: "network.libera.login.credential",
        network: libera,
        path: ["login", "credential"],
      },
    });
  });

  it("compares Channels by the casemapping the Daemon reports, parting only the one named", async () => {
    const { daemon, inForce, type } = await configuring();

    daemon.known.set("libera", { chantypes: "#", declared: "ascii" });
    await type("/set network.libera.channels #[a],#{a}");
    await type("/part #[a]");
    const parted = inForce()?.configuration.channels;

    await type("/join {a}");

    expect({ joined: inForce()?.configuration.channels, parted }).toStrictEqual({
      joined: [{ name: "#{a}" }],
      parted: [{ name: "#{a}" }],
    });
  });

  it("holds the prompt's value, closes the prompt, and wipes the value once the Vault answered", async () => {
    const { daemon, inForce, registry, type } = await configuring();
    const value = Redacted.make("a-channel-key");

    await type("/set network.libera.password");
    await run(registry, hold, { network: libera, path: ["password"], value });

    expect({
      held: Object.fromEntries(daemon.credentials),
      inAtoms: holds(registry, "a-channel-key"),
      password: inForce()?.configuration.password,
      prompting: registry.get(optionsState).prompting,
      wiped: holds(value, "a-channel-key"),
    }).toStrictEqual({
      held: { "libera.password": "a-channel-key" },
      inAtoms: false,
      password: "libera.password",
      prompting: undefined,
      wiped: false,
    });
  });
});
