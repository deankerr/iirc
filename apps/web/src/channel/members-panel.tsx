/**
 * A Pane's Channel's members, beside it while the Owner shows them on this device: a
 * labelled region holding a virtualized grid list, most privileged first, each member with
 * their rank's symbol, in their nick's colour, and dimmed while away, read a page at a
 * time as the Owner scrolls. Enter, or a double click, opens a member's Direct Message, as
 * `/query` does, and a member chosen offers that, looking them up, as `/whois` does, and
 * mentioning them in the composer. On a phone's width it lies over the Pane, and its hide
 * button, `/members`, or Alt+M closes it.
 *
 * @packageDocumentation
 */
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { TimelineId } from "@iirc/api";
import type { MemberRow } from "@iirc/frontend/channel";
import { commandNamed, runIn } from "@iirc/frontend/commands";
import type { Intent } from "@iirc/frontend/commands";
import { useId } from "react";
import {
  Collection,
  GridList,
  GridListItem,
  GridListLoadMoreItem,
  ListLayout,
  Virtualizer,
} from "react-aria-components";
import type { Key, Selection } from "react-aria-components";

import { commandContext, perform } from "../composer/atoms.ts";
import { Nick } from "../timelines/line.tsx";
import { Button } from "../ui/button.tsx";
import { channelOpen, chosenMember, chooseMember, moreMembers, roster } from "./atoms.ts";
import { membersShown } from "./state.ts";

import styles from "./members-panel.module.css";

/** How tall a member's row is, in pixels, for the virtualizer to lay them out. */
const rowHeight = 19;

/**
 * One member: their rank's symbol, and their nick in its colour.
 * @param props - The member.
 * @returns The row's content.
 */
const Member = ({ row }: { readonly row: MemberRow }) => (
  <span aria-hidden className={row.away ? styles.away : styles.member}>
    <span className={styles.symbol}>{row.symbol ?? " "}</span>
    <Nick colour={row.colour} nick={row.nick} />
  </span>
);

/**
 * The members read, in rank order, paged as the Owner scrolls.
 * @param props - The members, whether more follow, and whether they are being read.
 * @returns The list.
 */
const Members = ({
  label,
  loading,
  more,
  pane,
  rows,
  timeline,
}: {
  readonly label: string;
  readonly pane: string;
  readonly rows: readonly MemberRow[];
  readonly more: boolean;
  readonly loading: boolean;
  readonly timeline: TimelineId;
}) => {
  const askMore = useAtomSet(moreMembers);
  const run = useAtomSet(perform);
  const context = useAtomValue(commandContext);
  const chosen = useAtomValue(chosenMember(pane));
  const choose = useAtomSet(chooseMember);
  const query = commandNamed("query");

  // A key is read back as the member it names, never cast.
  const nickOf = (key: Key) => rows.find((row) => row.nick === String(key))?.nick;

  const onSelectionChange = (selection: Selection) => {
    const [first] = selection === "all" ? [] : [...selection];

    choose({ nick: first === undefined ? undefined : nickOf(first), pane });
  };

  return (
    <Virtualizer layout={ListLayout} layoutOptions={{ loaderSize: rowHeight, rowSize: rowHeight }}>
      <GridList
        aria-label={label}
        className={styles.list}
        items={rows}
        onAction={(key) => {
          const nick = nickOf(key);

          const intents =
            nick === undefined || query === undefined ? undefined : runIn(query, nick, context);

          if (intents?._tag === "Parsed") {
            run(intents.value);
          }
        }}
        onSelectionChange={onSelectionChange}
        selectedKeys={chosen === undefined ? [] : [chosen]}
        selectionBehavior="replace"
        selectionMode="single"
      >
        <Collection items={rows}>
          {(row) => (
            <GridListItem className={styles.item} id={row.nick} textValue={row.label}>
              <Member row={row} />
            </GridListItem>
          )}
        </Collection>
        {more ? (
          <GridListLoadMoreItem
            className={styles.loading}
            isLoading={loading}
            onLoadMore={() => {
              askMore(timeline);
            }}
          >
            reading more…
          </GridListLoadMoreItem>
        ) : null}
      </GridList>
    </Virtualizer>
  );
};

/**
 * What can be done with the member chosen, as commands: open their Direct Message, as
 * `/query` does, look them up, as `/whois` does, or mention them, starting the composer
 * with their nick.
 * @param props - The Pane.
 * @returns The actions, or nothing while none is chosen.
 */
const Actions = ({ pane }: { readonly pane: string }) => {
  const chosen = useAtomValue(chosenMember(pane));
  const context = useAtomValue(commandContext);
  const run = useAtomSet(perform);
  const query = commandNamed("query");
  const whois = commandNamed("whois");

  if (chosen === undefined) {
    return null;
  }

  const queried = query === undefined ? undefined : runIn(query, chosen, context);
  const looked = whois === undefined ? undefined : runIn(whois, chosen, context);
  const mention: readonly Intent[] = [{ _tag: "FocusComposer", text: `${chosen}: ` }];

  return (
    <div className={styles.actions}>
      {queried?._tag === "Parsed" ? (
        <Button
          onPress={() => {
            run(queried.value);
          }}
        >
          /query <bdi>{chosen}</bdi>
        </Button>
      ) : null}
      {looked?._tag === "Parsed" ? (
        <Button
          aria-label={`Whois ${chosen}`}
          onPress={() => {
            run(looked.value);
          }}
        >
          whois
        </Button>
      ) : null}
      <Button
        onPress={() => {
          run(mention);
        }}
      >
        mention
      </Button>
    </div>
  );
};

/**
 * The members of a Pane's Channel, while the Owner shows them on this device.
 * @param props - The Pane.
 * @returns The panel, or nothing.
 */
export const MembersPanel = ({ pane }: { readonly pane: string }) => {
  const shown = useAtomValue(membersShown);
  const open = useAtomValue(channelOpen(pane));
  const members = useAtomValue(roster(pane));
  const run = useAtomSet(perform);
  const headingId = useId();

  if (!shown || !open) {
    return null;
  }

  const hide = () => {
    run([{ _tag: "ShowMembers", shown: false }]);
  };

  let body = <p className={styles.dim}>Reading…</p>;
  let count: string | undefined;

  switch (members._tag) {
    case "None":
    case "Reading": {
      break;
    }

    case "Out": {
      body = <p className={styles.dim}>{members.note}</p>;
      break;
    }

    case "Failed": {
      body = <p className={styles.dim}>The Daemon has no such Channel.</p>;
      break;
    }

    case "Listed": {
      count = members.count === undefined ? undefined : String(members.count);
      body = (
        <Members
          label="Members"
          loading={members.loading}
          more={members.more}
          pane={pane}
          rows={members.rows}
          timeline={members.timeline}
        />
      );
      break;
    }

    default: {
      return members satisfies never;
    }
  }

  return (
    <section aria-labelledby={headingId} className={styles.panel}>
      <div className={styles.head}>
        <h2 className={styles.heading} id={headingId}>
          members
        </h2>
        {count === undefined ? null : <span className={styles.dim}>{count}</span>}
        <Button
          onPress={() => {
            hide();
          }}
        >
          hide
        </Button>
      </div>
      {body}
      <Actions pane={pane} />
    </section>
  );
};
