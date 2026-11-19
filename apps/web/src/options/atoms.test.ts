// @vitest-environment happy-dom
import { NetworkId, TimelineId } from "@iirc/api";
import type { Timeline } from "@iirc/api";
import { draftOf } from "@iirc/frontend/composer";
import { Redacted, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { edit, send } from "../composer/atoms.ts";
import { composerState } from "../composer/composer-state.ts";
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
import { confirmLeaving, leavingState } from "../timelines/closing.ts";
import { change, hold, optionsState, optionsSync } from "./atoms.ts";

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
  closed: false,
  detached: false,
  head: null,
  id,
  key: kind === "Network" ? null : name,
  kind,
  latest: null,
  life: 1,
  name,
  network: "libera",
  read: null,
  removed: false,
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
      added: daemon.configurations.get("oftc")?.configuration.ircds,
      notice: notice("Nowhere"),
      puts: daemon.puts,
    }).toStrictEqual({
      added: [{ host: "irc.oftc.net", port: 6697, tls: true }],
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

/**
 * A browser signed in to a fake Daemon whose `PUT`s to a path the pattern matches wait,
 * while `holding` says, until a test releases them.
 * @param pattern - The paths held.
 * @returns The fake, the registry, the writes held, and whether to hold.
 */
const holdingPuts = async (pattern: RegExp) => {
  const fake = fakeDaemon();
  const writes: (() => void)[] = [];
  const state = { holding: true };

  fake.daemon.signedIn = true;

  const registry = registryFor(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);

    if (state.holding && init?.method === "PUT" && pattern.test(url.pathname)) {
      const { promise, resolve } = Promise.withResolvers<undefined>();

      writes.push(() => {
        resolve(undefined);
      });
      await promise;
    }

    return await fake.fetch(input, init);
  });

  await run(registry, check, undefined);

  const release = () => {
    state.holding = false;

    for (const write of writes.splice(0)) {
      write();
    }
  };

  return { ...fake, registry, release, writes };
};

describe("a Network's changes, one at a time", () => {
  it("unsets a Credential option on the Daemon when unset while its value is on its way to the Vault", async () => {
    const { daemon, registry, release, writes } = await holdingPuts(/^\/api\/credentials\//u);
    const value = Redacted.make("a-channel-key");

    const held = run(registry, hold, { network: libera, path: ["password"], value });

    await eventually(() => writes.length === 1);

    const unset = run(registry, change, {
      edit: { _tag: "Unset", path: ["password"] },
      network: libera,
    });

    await eventually(() => registry.get(optionsState).onItsWay.length === 1);
    release();
    await Promise.all([held, unset]);

    expect({
      configuration: daemon.configurations.get("libera")?.configuration,
      held: Object.fromEntries(daemon.credentials),
    }).toStrictEqual({
      configuration: liberaConfiguration,
      held: { "libera.password": "a-channel-key" },
    });
  });

  it("leaves a Channel by an edit when its join is on its way, so it is not joined again", async () => {
    const { daemon, registry, release, writes } = await holdingPuts(/^\/api\/networks\/libera$/u);

    daemon.joined.set("libera", ["#iirc"]);
    daemon.configurations.set("libera", {
      configuration: { ...liberaConfiguration, channels: [] },
      sequence: 1,
    });
    registry.set(leavingState, {
      _tag: "Offered",
      channel: "#iirc",
      failure: undefined,
      network: libera,
      sending: false,
    });

    const joined = run(registry, change, {
      edit: { _tag: "Join", channels: ["#iirc"] },
      network: libera,
    });

    await eventually(() => writes.length === 1);
    const left = run(registry, confirmLeaving, undefined);

    await eventually(() => {
      const leaving = registry.get(leavingState);

      return leaving._tag === "Offered" && leaving.sending;
    });
    release();
    await Promise.all([joined, left]);

    expect({
      acts: daemon.acts.length,
      channels: daemon.configurations.get("libera")?.configuration.channels,
      puts: daemon.puts.length,
    }).toStrictEqual({ acts: 0, channels: [], puts: 2 });
  });
});
