// PROTOTYPE (#30): one Message's Previews, in each of the variants Dean can flip between.
import { useContext, useEffect, useRef, useState } from "react";

import { previews } from "./fixtures.ts";
import type { Picture, Preview, State } from "./fixtures.ts";
import { LargeContext, useVariants } from "./variants.ts";
import type { Variants } from "./variants.ts";
import { videoUrl } from "./video.ts";

import styles from "./previews.module.css";

const hostOf = (href: string) => new URL(href).host.replace(/^www\./u, "");

const limits: Record<Variants["size"], { readonly w: number; readonly h: number }> = {
  l: { h: 400, w: 640 },
  m: { h: 260, w: 440 },
  s: { h: 160, w: 280 },
};

/** A box sized from the Preview's own width and height, so nothing shifts as it loads. */
const useBox = (picture: { readonly width: number; readonly height: number }) => {
  const { size } = useVariants();
  const limit = limits[size];
  const width = Math.min(limit.w, picture.width, (limit.h * picture.width) / picture.height);
  return { aspectRatio: `${picture.width} / ${picture.height}`, width: `${Math.round(width)}px` };
};

const Expand = ({ onPress }: { readonly onPress: () => void }) => (
  <button
    aria-label="Larger view"
    className={styles.expand}
    onClick={(event) => {
      event.stopPropagation();
      onPress();
    }}
    title="Larger view"
    type="button"
  >
    ⤢
  </button>
);

const ImageView = ({ href, image }: { readonly href: string; readonly image: Picture }) => {
  const open = useContext(LargeContext);
  const box = useBox(image);
  return (
    <button
      className={styles.media}
      onClick={() => open({ height: image.height, href, kind: "image", src: image.src, width: image.width })}
      style={box}
      title={`${hostOf(href)} · press for a larger view`}
      type="button"
    >
      <img alt="" height={image.height} loading="lazy" src={image.src} width={image.width} />
    </button>
  );
};

/** A still frame, drawn by the Frontend from the first frame, with a play badge until pressed. */
const AnimatedView = ({ href, image }: { readonly href: string; readonly image: Picture }) => {
  const open = useContext(LargeContext);
  const box = useBox(image);
  const [playing, setPlaying] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (playing) {
      return;
    }
    const still = new Image();
    still.onload = () => {
      canvas.current?.getContext("2d")?.drawImage(still, 0, 0, image.width, image.height);
    };
    still.src = image.src;
  }, [playing, image]);

  const large = () => open({ height: image.height, href, kind: "image", src: image.src, width: image.width });

  return (
    <div className={styles.mediaWrap} style={box}>
      <button
        className={styles.media}
        onClick={() => (playing ? setPlaying(false) : setPlaying(true))}
        title={playing ? "Press to stop" : "Animated: press to play"}
        type="button"
      >
        {playing ? (
          <img alt="" height={image.height} src={image.src} width={image.width} />
        ) : (
          <>
            <canvas height={image.height} ref={canvas} width={image.width} />
            <span className={styles.badge}>▶ GIF</span>
          </>
        )}
      </button>
      <Expand onPress={large} />
    </div>
  );
};

const VideoView = ({ href, poster, duration }: { readonly href: string; readonly poster: Picture; readonly duration: string }) => {
  const open = useContext(LargeContext);
  const box = useBox(poster);
  const [src, setSrc] = useState<string | undefined>();
  const [pressed, setPressed] = useState(false);

  const play = () => {
    setPressed(true);
    void videoUrl().then(setSrc);
  };

  const large = () => {
    void videoUrl().then((url) =>
      open({ height: poster.height, href, kind: "video", poster: poster.src, src: url ?? "", width: poster.width })
    );
  };

  return (
    <div className={styles.mediaWrap} style={box}>
      {pressed && src !== undefined ? (
        // oxlint-disable-next-line jsx-a11y/media-has-caption
        <video autoPlay className={styles.video} controls poster={poster.src} preload="none" src={src} />
      ) : (
        <button className={styles.media} onClick={play} title="Video: press to play" type="button">
          <img alt="" height={poster.height} loading="lazy" src={poster.src} width={poster.width} />
          <span className={styles.badge}>{pressed ? "loading…" : `▶ ${duration}`}</span>
        </button>
      )}
      <Expand onPress={large} />
    </div>
  );
};

const AudioView = ({ href, src, duration }: { readonly href: string; readonly src: string; readonly duration: string }) => {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const name = new URL(href).pathname.split("/").pop() ?? href;

  return (
    <div className={styles.audio}>
      <button
        aria-label={playing ? "Pause" : "Play"}
        className={styles.audioButton}
        onClick={() => {
          const element = audio.current;
          if (element === null) {
            return;
          }
          if (element.paused) {
            void element.play();
          } else {
            element.pause();
          }
        }}
        type="button"
      >
        {playing ? "❚❚" : "▶"}
      </button>
      <span className={styles.audioName}>{name}</span>
      <span className={styles.audioTrack}>
        <span className={styles.audioFill} style={{ width: `${progress * 100}%` }} />
      </span>
      <span className={styles.dim}>{duration}</span>
      {/* oxlint-disable-next-line jsx-a11y/media-has-caption */}
      <audio
        onEnded={() => setPlaying(false)}
        onPause={() => setPlaying(false)}
        onPlay={() => setPlaying(true)}
        onTimeUpdate={(event) => setProgress(event.currentTarget.currentTime / (event.currentTarget.duration || 1))}
        preload="none"
        ref={audio}
        src={src}
      />
    </div>
  );
};

const PlayerView = ({ preview }: { readonly preview: Extract<Preview, { kind: "player" }> }) => {
  const { referrer } = useVariants();
  const box = useBox(preview.poster);
  const [pressed, setPressed] = useState(false);
  const where = `plays from ${preview.frame.host}`;

  return (
    <div className={styles.player}>
      <div className={styles.mediaWrap} style={box}>
        {pressed ? (
          <iframe
            allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
            className={styles.frame}
            // #29 decided no-referrer; YouTube answers that with error 153, so the other is offered.
            referrerPolicy={referrer === "none" ? "no-referrer" : "strict-origin"}
            sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"
            src={preview.frame.src}
            title={preview.title}
          />
        ) : (
          <button className={styles.media} onClick={() => setPressed(true)} title={where} type="button">
            <img alt="" height={preview.poster.height} loading="lazy" src={preview.poster.src} width={preview.poster.width} />
            <span className={styles.play} aria-hidden>
              ▶
            </span>
            <span className={styles.where}>{where}</span>
          </button>
        )}
      </div>
      <PageText description={undefined} site={preview.site} title={preview.title} />
    </div>
  );
};

const PageText = ({
  site,
  title,
  description,
}: {
  readonly site: string | undefined;
  readonly title: string | undefined;
  readonly description: string | undefined;
}) => (
  <div className={styles.pageText}>
    {site === undefined ? null : <span className={styles.site}>{site}</span>}
    {title === undefined ? null : <span className={styles.title}>{title}</span>}
    {description === undefined ? null : <span className={styles.description}>{description}</span>}
  </div>
);

const PageView = ({ href, preview }: { readonly href: string; readonly preview: Extract<Preview, { kind: "page" }> }) => {
  const { page } = useVariants();
  const open = useContext(LargeContext);
  const site = preview.site ?? hostOf(href);
  const image = preview.image;
  const large = () => {
    if (image !== undefined) {
      open({ height: image.height, href, kind: "image", src: image.src, width: image.width });
    }
  };

  if (page === "line") {
    return (
      <a className={styles.pageLine} href={href} rel="noopener noreferrer" target="_blank">
        {image === undefined ? null : <img alt="" className={styles.lineThumb} src={image.src} />}
        <span className={styles.site}>{site}</span>
        <span className={styles.title}>{preview.title}</span>
      </a>
    );
  }

  if (page === "card") {
    return (
      <div className={styles.pageCard}>
        <PageText description={preview.description} site={site} title={preview.title} />
        {image === undefined ? null : <CardImage image={image} onPress={large} />}
      </div>
    );
  }

  return (
    <div className={styles.pageThumb}>
      <PageText description={preview.description} site={site} title={preview.title} />
      {image === undefined ? null : (
        <button className={styles.thumb} onClick={large} title="Larger view" type="button">
          <img alt="" src={image.src} />
        </button>
      )}
    </div>
  );
};

const CardImage = ({ image, onPress }: { readonly image: Picture; readonly onPress: () => void }) => {
  const box = useBox(image);
  return (
    <button className={styles.media} onClick={onPress} style={box} title="Larger view" type="button">
      <img alt="" height={image.height} loading="lazy" src={image.src} width={image.width} />
    </button>
  );
};

const ReadyView = ({ href, preview }: { readonly href: string; readonly preview: Preview }) => {
  switch (preview.kind) {
    case "page": {
      return <PageView href={href} preview={preview} />;
    }
    case "image": {
      return preview.animated === true ? (
        <AnimatedView href={href} image={preview.image} />
      ) : (
        <ImageView href={href} image={preview.image} />
      );
    }
    case "video": {
      return <VideoView duration={preview.duration} href={href} poster={preview.poster} />;
    }
    case "audio": {
      return <AudioView duration={preview.duration} href={href} src={preview.src} />;
    }
    case "player": {
      return <PlayerView preview={preview} />;
    }
    default: {
      return preview satisfies never;
    }
  }
};

const Pending = ({ href }: { readonly href: string }) => {
  const { pending } = useVariants();
  return pending === "skeleton" ? (
    <div className={styles.skeleton} title={`fetching ${hostOf(href)}`}>
      <span />
      <span />
    </div>
  ) : (
    <div className={styles.pendingLine}>
      <span className={styles.spinner} aria-hidden />
      {hostOf(href)}
    </div>
  );
};

/** One link's Preview, as its state says. A Direct Message's waits for a press (#26). */
const One = ({ href, state }: { readonly href: string; readonly state: State }) => {
  const [asked, setAsked] = useState<"no" | "fetching" | "done">("no");

  useEffect(() => {
    if (asked !== "fetching") {
      return;
    }
    const timer = setTimeout(() => setAsked("done"), 1200);
    return () => clearTimeout(timer);
  }, [asked]);

  switch (state._tag) {
    case "Ready": {
      return <ReadyView href={href} preview={state.preview} />;
    }
    case "Pending": {
      return <Pending href={href} />;
    }
    case "Failed": {
      return null;
    }
    case "Waiting": {
      if (asked === "done") {
        return <ReadyView href={href} preview={state.then} />;
      }
      if (asked === "fetching") {
        return <Pending href={href} />;
      }
      return (
        <button
          className={styles.show}
          onClick={() => setAsked("fetching")}
          title={`The Daemon fetches it on a press, so ${hostOf(href)} learns nothing until you ask`}
          type="button"
        >
          show preview <span className={styles.dim}>· {hostOf(href)}</span>
        </button>
      );
    }
    default: {
      return state satisfies never;
    }
  }
};

/** What a folded Preview says of itself in one line. */
const summaryOf = (href: string, state: State): string => {
  const host = hostOf(href);
  if (state._tag === "Pending") {
    return `${host} · loading`;
  }
  if (state._tag === "Waiting") {
    return `${host} · waits for a press`;
  }
  if (state._tag === "Failed") {
    return host;
  }
  const preview = state.preview;
  switch (preview.kind) {
    case "page": {
      return `${preview.site ?? host} · ${preview.title ?? ""}`;
    }
    case "image": {
      return `${preview.animated === true ? "animated image" : "image"} · ${host} · ${preview.image.width}×${preview.image.height}`;
    }
    case "video": {
      return `video · ${host} · ${preview.duration}`;
    }
    case "audio": {
      return `sound · ${host} · ${preview.duration}`;
    }
    case "player": {
      return `${preview.site} · ${preview.title}`;
    }
    default: {
      return preview satisfies never;
    }
  }
};

/** The links of a Message that have something to show below it, failures left as plain links. */
export const shown = (hrefs: readonly string[]) =>
  hrefs.flatMap((href) => {
    const state = previews.get(href);
    return state === undefined || state._tag === "Failed" ? [] : [{ href, state }];
  });

/** A Message's Previews, below its text, folded or open. */
export const Previews = ({
  hrefs,
  open,
  onToggle,
}: {
  readonly hrefs: readonly string[];
  readonly open: boolean;
  readonly onToggle: () => void;
}) => {
  const variants = useVariants();
  const items = shown(hrefs);

  if (items.length === 0) {
    return null;
  }

  if (!open) {
    if (variants.folded === "toggle") {
      return null;
    }
    return (
      <div className={styles.block} data-frame={variants.frame}>
        <button className={styles.summary} onClick={onToggle} title="Show" type="button">
          {items.map(({ href, state }) => (
            <span className={styles.summaryLine} key={href}>
              <span className={styles.chevron}>▸</span> {summaryOf(href, state)}
            </span>
          ))}
        </button>
      </div>
    );
  }

  return (
    <div className={styles.block} data-frame={variants.frame}>
      {variants.folded === "summary" ? (
        <button aria-label="Fold" className={styles.fold} onClick={onToggle} title="Fold" type="button">
          ▾
        </button>
      ) : null}
      <div className={styles.items} data-several={variants.several} data-count={items.length}>
        {items.map(({ href, state }) => (
          <div className={styles.item} key={href}>
            <One href={href} state={state} />
          </div>
        ))}
      </div>
    </div>
  );
};
