# @iirc/state

The one interpretation of what an Ircd says. `stepState` folds a Session's inbound Lines into Self, the Channels Self is in, and the `RPL_ISUPPORT` tokens that matter, and names each change it made. Pure.

- **Depends on:** `@iirc/protocol`.
- **Used by:** `@iirc/session` (inside `Standing`), `@iirc/log` (Messages), `apps/soak` (casefolding in the checker).
- **Lineage:** ircstates.

## Public surface

| Export | Role |
| --- | --- |
| `initialState`, `IrcState` | A Session's state: `self`, `isupport`, and `channels` |
| `stepState(state, line)` | The state after one inbound Line, and its `StateChange`s. Never throws. Returns the same object when nothing changed |
| `StateChange` | `Welcomed`, `NickChanged`, `Joined`, `Parted`, `Kicked`, `JoinRefused`, `IsupportChanged`. A Channel's key is state, and changes nothing else |
| `channelOf(state, name)` | The Channel Self is in by that name, however it is spelled |
| `casefold(casemapping, name)` | The form names are compared in under `ascii`, `rfc1459`, or `rfc1459-strict` (KNOW-3) |
| `messageOf(line, sender?)` | The Message a `PRIVMSG` or `NOTICE` carries, if any |
| `nickOf(source)` | The nick in `nick!user@host`, `nick@host`, or a bare nick |
| `readsCommand(command)` | Whether `stepState` reads Lines of a command at all, so a host can skip the rest |
| `./modes`: `parseModes` | A Channel `MODE`'s letters against its parameters, by `PREFIX` and `CHANMODES` (KNOW-6) |

## Usage

```ts
import { parseLine } from "@iirc/protocol/line";
import { channelOf, initialState, stepState } from "@iirc/state";

let state = initialState;

for (const text of [
  ":irc 001 me :Welcome",
  ":me!u@h JOIN #Foo[x]",
  ":op!o@h MODE #foo{x} +k pizza",
]) {
  const parsed = parseLine(text);
  if (parsed._tag === "Line") {
    const { changes, next } = stepState(state, parsed.line);
    state = next;
    console.log(changes.map(({ _tag }) => _tag)); // ["Welcomed"], ["Joined"], []
  }
}

channelOf(state, "#FOO{X}"); // { name: "#Foo[x]", key: "pizza" } under rfc1459
```

## Key ideas

- **One Session at a time.** A new Connection starts again from `initialState`. Nothing carries over (LIVE-6).
- **Feed it inbound Lines only.** Self's own outbound Lines must never move state, because only an Ircd says what is true (CONN-3). `Standing` keeps to this.
- **Changes are the interface.** A host acts on `changes`, such as a kick or a key set, rather than diffing states.
- **Names are kept as the Ircd last spelled them,** and keyed by their casefolded form under the mapping in force. A new `CASEMAPPING` refolds the Channels, and the later of two that merge stands.

## Invariants

- At most 1024 Channels are held, dropping the oldest. Nothing else held grows with what a Network sends.
- A `JOIN`, `PART`, or `KICK` naming several Channels is several changes.
- A `JOIN` failure is a change and is not held, because only someone who asked knows whether it named a Channel (`437` also names nicks).
- A key shown as `*` is hidden and changes nothing.

## Traps

- Unknown `CASEMAPPING` values fall back to `ascii`, which can only split names. `UTF8MAPPING` and `rfc8265` are not read yet.
- `476` may carry no `<client>` parameter, as RFC 2812 gives it, so its Channel can come first.

## Requirements

Milestone 2's [Network state](../../docs/requirements.md#network-state) and [Channels and Users](../../docs/requirements.md#channels-and-users) build here. Today it covers Self's nick, `CASEMAPPING`, `PREFIX`, `CHANMODES`, and `NICKLEN` (KNOW-2), three casemappings (KNOW-3), and mode parsing (KNOW-6). It also serves CONN-3, LIVE-7, LIVE-8, and CRED-4.
