// PROTOTYPE (#30): a rough iirc screen, a Timeline or two of faked Previews, and the knobs.
import { useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";

import line from "../../timelines/line.module.css";
import { channel, direct, previewed, previews } from "./fixtures.ts";
import type { Row, Segment } from "./fixtures.ts";
import { Previews, shown } from "./preview.tsx";
import { fromSearch, knobs, LargeContext, toSearch, useVariants, VariantsContext } from "./variants.ts";
import type { Knob, Large, Variants } from "./variants.ts";
import { videoUrl } from "./video.ts";

import styles from "./app.module.css";
import previewStyles from "./previews.module.css";

const nickClass = (colour: number) => (line as Record<string, string>)[`nick${colour}`];

const LinkText = ({ href }: { readonly href: string }) => {
  const { failed } = useVariants();
  const state = previews.get(href);
  const reason = state?._tag === "Failed" ? state.reason : undefined;
  return (
    <>
      <a
        className={styles.link}
        href={href}
        rel="noopener noreferrer"
        target="_blank"
        title={reason === undefined ? href : `${href}\nno preview: ${reason}`}
      >
        {href}
      </a>
      {reason !== undefined && failed === "mark" ? (
        <span className={styles.failMark} title={`no preview: ${reason}`}>
          {" "}
          ⊘
        </span>
      ) : null}
    </>
  );
};

const Segments = ({ text }: { readonly text: readonly Segment[] }) =>
  text.map((segment, index) =>
    typeof segment === "string" ? (
      // oxlint-disable-next-line react/no-array-index-key
      <span key={index}>{segment}</span>
    ) : (
      // oxlint-disable-next-line react/no-array-index-key
      <LinkText href={segment.href} key={index} />
    )
  );

const MessageRow = ({ row, notes }: { readonly row: Extract<Row, { _tag: "Message" }>; readonly notes: boolean }) => {
  const variants = useVariants();
  const hrefs = previewed(row);
  const count = shown(hrefs).length;
  const [open, setOpen] = useState(variants.fold === "open");

  // Flipping the default refolds every Message, so the two can be compared at once.
  useEffect(() => setOpen(variants.fold === "open"), [variants.fold]);

  return (
    <div className={line.line} data-row={row.id}>
      <div className={`${row.highlight === true ? line.highlight : line.message} ${styles.rowRel}`}>
        <span className={line.time} data-sample="00:00">
          {row.time}
        </span>{" "}
        <span className={line.sender}>
          <span className={line.said}>
            &lt;<bdi className={nickClass(row.colour)}>{row.nick}</bdi>&gt;
          </span>
        </span>{" "}
        <bdi className={line.text}>
          <Segments text={row.text} />
          {variants.folded === "toggle" && count > 0 ? (
            <>
              {" "}
              <button
                className={previewStyles.chip}
                onClick={() => setOpen(!open)}
                title={open ? "Fold" : "Show"}
                type="button"
              >
                {open ? "[−]" : `[+${count}]`}
              </button>
            </>
          ) : null}
        </bdi>
        <span className={styles.note}>{notes && row.note !== undefined ? row.note : ""}</span>
        <Previews hrefs={hrefs} onToggle={() => setOpen(!open)} open={open} />
      </div>
    </div>
  );
};

const RowView = ({ row, notes }: { readonly row: Row; readonly notes: boolean }) =>
  row._tag === "Activity" ? (
    <div className={line.line}>
      <div className={line.activity}>
        <span className={line.time} data-sample="00:00">
          {row.time}
        </span>{" "}
        <span aria-hidden className={line.marker}>
          {row.marker}
        </span>{" "}
        <span className={line.text}>{row.text}</span>
      </div>
    </div>
  ) : (
    <MessageRow notes={notes} row={row} />
  );

/** The larger view: over the whole screen, or over its Pane. Escape or a press outside closes it. */
const Lightbox = ({ large, onClose, over }: { readonly large: Large; readonly onClose: () => void; readonly over: "screen" | "pane" }) => {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (over === "screen") {
      dialog.current?.showModal();
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [over, onClose]);

  const body = (
    <figure className={styles.largeFigure} onClick={(event) => event.stopPropagation()}>
      {large.kind === "image" ? (
        <img alt="" className={styles.largeMedia} height={large.height} src={large.src} width={large.width} />
      ) : (
        // oxlint-disable-next-line jsx-a11y/media-has-caption
        <video autoPlay className={styles.largeMedia} controls poster={large.poster} src={large.src} />
      )}
      <figcaption className={styles.largeCaption}>
        <a href={large.href} rel="noopener noreferrer" target="_blank">
          {large.href} ↗
        </a>
        <span className={styles.dim}>
          {large.width}×{large.height} · esc to close
        </span>
      </figcaption>
    </figure>
  );

  return over === "screen" ? (
    // oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions
    <dialog className={styles.largeDialog} onClick={onClose} onClose={onClose} ref={dialog}>
      {body}
    </dialog>
  ) : (
    // oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
    <div className={styles.largePane} onClick={onClose}>
      {body}
    </div>
  );
};

const Pane = ({
  name,
  rest,
  rows,
  style,
  dim,
}: {
  readonly name: string;
  readonly rest: string;
  readonly rows: readonly Row[];
  readonly style?: CSSProperties;
  readonly dim?: boolean;
}) => {
  const variants = useVariants();
  const [large, setLarge] = useState<Large | undefined>();
  const scroller = useRef<HTMLDivElement>(null);

  // Opens at the latest, as a Timeline does.
  useEffect(() => {
    const element = scroller.current;
    if (element !== null) {
      element.scrollTop = element.scrollHeight;
    }
  }, []);

  return (
    <LargeContext.Provider value={setLarge}>
      <section className={styles.pane} style={style}>
        <div className={styles.bar}>
          <span className={styles.barName} data-dim={dim === true}>
            {name}
          </span>
          <span className={styles.barRest}>{rest}</span>
        </div>
        <div className={styles.scroller} ref={scroller}>
          <div className={styles.rows}>
            {rows.map((row) => (
              <RowView key={row.id} notes={variants.notes === "on"} row={row} />
            ))}
          </div>
        </div>
        <div className={styles.composer}>
          <span className={styles.dim}>Message {name}</span>
        </div>
        {large === undefined ? null : (
          <Lightbox large={large} onClose={() => setLarge(undefined)} over={variants.large} />
        )}
      </section>
    </LargeContext.Provider>
  );
};

const Sidebar = ({ focus }: { readonly focus: string }) => (
  <nav className={styles.sidebar}>
    <div className={styles.network}>▾ libera</div>
    {["#iirc", "#ircv3", "mara"].map((name) => (
      <div className={styles.item} data-selected={name === focus} key={name}>
        {name}
      </div>
    ))}
    <div className={styles.network}>▸ oftc</div>
  </nav>
);

const channelPane = (style?: CSSProperties) => (
  <Pane name="#iirc" rest="Previews, faked · #30 · nothing here is fetched" rows={channel} style={style} />
);
const directPane = (style?: CSSProperties) => (
  <Pane dim name="mara" rest="Direct Message · previews wait for a press" rows={direct} style={style} />
);

const Phone = ({ framed }: { readonly framed: boolean }) => {
  const [tab, setTab] = useState<"#iirc" | "mara">("#iirc");
  return (
    <div className={framed ? styles.phoneFrame : styles.phoneBleed}>
      <div className={styles.phoneBar}>
        <span className={styles.dim}>☰</span>
        {(["#iirc", "mara"] as const).map((name) => (
          <button className={styles.tab} data-selected={tab === name} key={name} onClick={() => setTab(name)} type="button">
            {name}
          </button>
        ))}
      </div>
      {tab === "#iirc" ? channelPane() : directPane()}
    </div>
  );
};

const Stage = ({ compact }: { readonly compact: boolean }) => {
  const { layout } = useVariants();

  if (compact) {
    return <Phone framed={false} />;
  }

  switch (layout) {
    case "phone": {
      return (
        <div className={styles.phoneStage}>
          <Phone framed />
        </div>
      );
    }
    case "split": {
      return (
        <div className={styles.stage}>
          <Sidebar focus="#iirc" />
          {channelPane({ flex: 1 })}
          {directPane({ flex: "0 0 320px" })}
        </div>
      );
    }
    case "narrow": {
      return (
        <div className={styles.stage}>
          <Sidebar focus="#iirc" />
          {channelPane({ flex: "0 0 320px" })}
          {directPane({ flex: 1 })}
        </div>
      );
    }
    default: {
      return (
        <div className={styles.stage}>
          <Sidebar focus="#iirc" />
          {channelPane({ flex: 1 })}
        </div>
      );
    }
  }
};

const Knobs = ({ variants, set }: { readonly variants: Variants; readonly set: (knob: Knob, value: string) => void }) => (
  <>
    {(Object.keys(knobs) as Knob[]).map((key) => (
      <span className={styles.knob} key={key}>
        <span className={styles.dim}>{knobs[key].label}</span>
        {knobs[key].options.map((option) => (
          <button
            className={styles.option}
            data-selected={variants[key] === option}
            key={option}
            onClick={() => set(key, option)}
            type="button"
          >
            {option}
          </button>
        ))}
      </span>
    ))}
  </>
);

const useCompact = () => {
  const query = "(max-width: 640px)";
  const [compact, setCompact] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const list = window.matchMedia(query);
    const change = () => setCompact(list.matches);
    list.addEventListener("change", change);
    return () => list.removeEventListener("change", change);
  }, []);
  return compact;
};

export const App = () => {
  const [variants, setVariants] = useState(() => fromSearch(window.location.search));
  const compact = useCompact();

  useEffect(() => {
    window.history.replaceState(null, "", `${window.location.pathname}${toSearch(variants)}`);
    const root = document.documentElement;
    if (variants.theme === "auto") {
      delete root.dataset.theme;
      root.style.colorScheme = "";
    } else {
      root.dataset.theme = variants.theme;
      root.style.colorScheme = variants.theme;
    }
  }, [variants]);

  // Record the stand-in video early, so a press plays it at once.
  useEffect(() => {
    void videoUrl();
  }, []);

  const set = (knob: Knob, value: string) => setVariants({ ...variants, [knob]: value });

  const toolbar: ReactNode = <Knobs set={set} variants={variants} />;

  return (
    <VariantsContext.Provider value={variants}>
      <div className={styles.app}>
        {compact ? (
          <details className={styles.toolbarCompact}>
            <summary>prototype · previews #30</summary>
            <div className={styles.toolbarWrap}>{toolbar}</div>
          </details>
        ) : (
          <div className={styles.toolbar}>
            <strong className={styles.protoName}>prototype · previews #30</strong>
            {toolbar}
          </div>
        )}
        <Stage compact={compact} />
      </div>
    </VariantsContext.Provider>
  );
};
