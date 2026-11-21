/**
 * An image a Preview shows, loaded only once it scrolls into view, in a box whose shape is
 * the image's own from before a byte of it loads, where the Daemon read its size, and a
 * placeholder until it has loaded where it did not. One that is not animated
 * is drawn as it is, and opens large when pressed. An animated one is fetched from the
 * Daemon once, drawn as its first frame under a play badge, which a press plays in place,
 * and stops again, with a control beside it, while it plays, that opens it large. Where it
 * cannot be fetched or decoded, nothing is drawn, and what is drawn without it shows.
 *
 * @packageDocumentation
 */
import { useAtomValue } from "@effect/atom-react";
import { motionOf, pressOn } from "@iirc/frontend/previews";
import type { ImageShown, LinkShown, Motion, PlayerShown, Size } from "@iirc/frontend/previews";
import type { CSSProperties, ReactElement, ReactNode, RefObject, VideoHTMLAttributes } from "react";
import { useEffect, useRef, useState } from "react";
import { Button as AriaButton } from "react-aria-components";

import { animateShown } from "../options/ui.ts";
import { Icon } from "../ui/icon.tsx";
import { OpensLarger } from "./larger-view.tsx";
import type { Large } from "./larger-view.tsx";
import { PlayButton } from "./play-button.tsx";
import type { Play } from "./play-button.tsx";
import { useReducedMotion } from "./reduced-motion.ts";

import styles from "./preview-image.module.css";

/**
 * Whether an element has come into view, once: from then on it stays so. Where no browser
 * observes, it never has.
 * @param element - The element.
 * @returns Whether it has.
 */
const useSeen = (element: Element | null): boolean => {
  const [seen, setSeen] = useState(false);

  useEffect(() => {
    const observer =
      element === null || seen || typeof IntersectionObserver === "undefined"
        ? undefined
        : new IntersectionObserver((entries, self) => {
            if (entries.some((entry) => entry.isIntersecting)) {
              self.disconnect();
              setSeen(true);
            }
          });

    if (element !== null) {
      observer?.observe(element);
    }

    return () => {
      observer?.disconnect();
    };
  }, [element, seen]);

  return seen;
};

/**
 * An animated image as the Daemon served it: `Loading` until fetched, the bytes as an
 * object URL, which plays, with their first frame decoded, or `Failed`.
 */
type Fetched =
  | { readonly _tag: "Loading" }
  | { readonly _tag: "Ready"; readonly url: string; readonly frame: ImageBitmap }
  | { readonly _tag: "Failed" };

/**
 * Fetches an image's bytes from the Daemon's own origin once, as the page's other calls are
 * made, and decodes its first frame, until it is let go of, which frees both.
 * @param src - Where to fetch it from, or none to fetch nothing yet.
 * @returns How it stands.
 */
const useFetched = (src: string | undefined): Fetched => {
  const [fetched, setFetched] = useState<Fetched>({ _tag: "Loading" });

  useEffect(() => {
    const controller = new AbortController();
    let url: string | undefined;
    let frame: ImageBitmap | undefined;

    const fetchIt = async (from: string) => {
      try {
        const response = await fetch(from, { signal: controller.signal });

        if (!response.ok) {
          setFetched({ _tag: "Failed" });

          return;
        }

        const blob = await response.blob();

        frame = await createImageBitmap(blob);

        if (controller.signal.aborted) {
          frame.close();

          return;
        }

        url = URL.createObjectURL(blob);
        setFetched({ _tag: "Ready", frame, url });
      } catch {
        if (!controller.signal.aborted) {
          setFetched({ _tag: "Failed" });
        }
      }
    };

    if (src !== undefined) {
      void fetchIt(src);
    }

    return () => {
      controller.abort();

      if (url !== undefined) {
        URL.revokeObjectURL(url);
      }

      frame?.close();
    };
  }, [src]);

  return fetched;
};

/**
 * An animated image's first frame, drawn on a canvas of its own size.
 * @param props - The frame.
 * @returns The canvas.
 */
const FirstFrame = ({ frame }: { readonly frame: ImageBitmap }) => {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    canvas.current?.getContext("2d")?.drawImage(frame, 0, 0);
  }, [frame]);

  return (
    <canvas
      aria-hidden
      className={styles.picture}
      height={frame.height}
      ref={canvas}
      width={frame.width}
    />
  );
};

/**
 * What a box of a shape is given, for the stylesheet to size it: the shape's proportions,
 * and, for an image, no wider than the image itself, in CSS pixels. The box is the same
 * before and after what it holds loads.
 * @param box - Its shape.
 * @param atMost - How wide it is at most, in CSS pixels, if there is a limit.
 * @returns Its style.
 */
const boxStyle = ({ height, width }: Size, atMost?: number): CSSProperties => {
  const style: Record<`--${string}`, string> = {
    "--box-height": `${height}`,
    "--box-width": `${width}`,
  };

  if (atMost !== undefined) {
    style["--box-at-most"] = `${atMost}px`;
  }

  return style;
};

/**
 * What holds an image, as big as it will be drawn, so what is drawn and what stands in its
 * place until it loads share one box. Given a `box`, it is reserved at once as that shape;
 * without one, it is a placeholder until it is `loaded`.
 * @param props - How it is drawn, its box if it has one, whether what is in it has
 *   loaded, what is in it, and how it is found.
 * @returns The box.
 */
const Holder = ({
  children,
  drawn,
  loaded,
  reference,
  box,
}: {
  readonly children: ReactNode;
  readonly drawn: ImageShown["drawn"];
  readonly loaded: boolean;
  readonly reference: (element: HTMLSpanElement | null) => void;
  readonly box: Size | undefined;
}) =>
  drawn === "Thumbnail" ? (
    <span className={styles.thumbnail} data-loaded={loaded} ref={reference}>
      {children}
    </span>
  ) : (
    <span
      className={styles.whole}
      data-loaded={loaded}
      data-reserved={box !== undefined || undefined}
      ref={reference}
      style={
        box === undefined ? undefined : boxStyle(box, drawn === "Poster" ? undefined : box.width)
      }
    >
      {children}
    </span>
  );

/**
 * The control in the corner of what is drawn, which opens it large.
 * @param props - What is drawn large, its page's link, what to call it, and what else
 *   happens as it opens.
 * @returns The control, and the larger view it opens.
 */
export const EnlargeControl = ({
  large,
  link,
  name,
  onOpen,
}: {
  readonly large: Large;
  readonly link: LinkShown;
  readonly name: string;
  readonly onOpen?: (() => void) | undefined;
}) => (
  <OpensLarger alt={name} large={large} link={link} onOpen={onOpen}>
    <AriaButton aria-label={`Open ${name} large`} className={styles.enlarge}>
      <Icon name="enlarge" />
    </AriaButton>
  </OpensLarger>
);

/**
 * An image that does not move, which opens large when pressed.
 * @param props - The image, its page's link, and what to draw in its place.
 * @returns The image, or what stands without it.
 */
const StillImage = ({
  image,
  link,
  without,
}: {
  readonly image: ImageShown;
  readonly link: LinkShown;
  readonly without: ReactElement | null;
}) => {
  const [element, setElement] = useState<HTMLSpanElement | null>(null);
  const seen = useSeen(element);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);

  if (failed) {
    return without;
  }

  return (
    <Holder drawn={image.drawn} loaded={loaded} reference={setElement} box={image.dimensions}>
      {seen ? (
        <OpensLarger alt={image.alt} large={{ _tag: "Image", src: image.src }} link={link}>
          <AriaButton aria-label={`Open ${image.alt} large`} className={styles.press}>
            <img
              alt={image.alt}
              className={styles.picture}
              data-drawn={image.drawn.toLowerCase()}
              decoding="async"
              loading="lazy"
              onError={() => {
                setFailed(true);
              }}
              onLoad={() => {
                setLoaded(true);
              }}
              referrerPolicy="no-referrer"
              src={image.src}
            />
          </AriaButton>
        </OpensLarger>
      ) : null}
    </Holder>
  );
};

/**
 * An animated image: its first frame under a play badge, until it is played.
 * @param props - The image, its page's link, and what to draw in its place.
 * @returns The image, or what stands without it.
 */
const AnimatedImage = ({
  image,
  link,
  without,
}: {
  readonly image: ImageShown;
  readonly link: LinkShown;
  readonly without: ReactElement | null;
}) => {
  const animate = useAtomValue(animateShown);
  const reducedMotion = useReducedMotion();
  const [element, setElement] = useState<HTMLSpanElement | null>(null);
  const seen = useSeen(element);
  const fetched = useFetched(seen ? image.src : undefined);
  const [chosen, setChosen] = useState<Motion | undefined>();
  const motion = motionOf({ animate, animated: true, chosen, reducedMotion });

  if (fetched._tag === "Failed") {
    return without;
  }

  const moving = motion === "Moving";

  return (
    <Holder
      drawn={image.drawn}
      loaded={fetched._tag === "Ready"}
      reference={setElement}
      box={image.dimensions}
    >
      {fetched._tag === "Ready" ? (
        <>
          <AriaButton
            aria-label={`${moving ? "Stop" : "Play"} ${image.alt}`}
            className={styles.press}
            onPress={() => {
              setChosen(pressOn(image, motion) === "Play" ? "Moving" : "Still");
            }}
          >
            {moving ? (
              <img
                alt={image.alt}
                className={styles.picture}
                data-drawn={image.drawn.toLowerCase()}
                data-playing
                decoding="async"
                referrerPolicy="no-referrer"
                src={fetched.url}
              />
            ) : (
              <>
                <FirstFrame frame={fetched.frame} />
                <span aria-hidden className={styles.badge} data-badge="play">
                  <Icon name="play" />
                </span>
              </>
            )}
          </AriaButton>
          {moving ? (
            <EnlargeControl
              large={{ _tag: "Image", src: fetched.url }}
              link={link}
              name={image.alt}
            />
          ) : null}
        </>
      ) : null}
    </Holder>
  );
};

/**
 * What a poster draws: the text, and the poster under it in the box its video or player
 * plays in.
 * @param props - The text, the box's content and shape, whether it is loaded, and how it
 *   is found.
 * @returns The column.
 */
const Stacked = ({
  children,
  loaded,
  reference,
  box,
  text,
}: {
  readonly children: ReactNode;
  readonly loaded: boolean;
  readonly reference: (element: HTMLSpanElement | null) => void;
  readonly box: Size;
  readonly text: ReactElement;
}) => (
  <div className={styles.stacked}>
    {text}
    <Holder drawn="Poster" loaded={loaded} reference={reference} box={box}>
      {children}
    </Holder>
  </div>
);

/**
 * A poster that does not move.
 * @param props - The poster, its play button, what else sits in its corner, the text above
 * it, and what stands without it.
 * @returns The poster, or what stands without it.
 */
const StillPoster = ({
  corner,
  image,
  play,
  box,
  text,
  without,
}: {
  readonly corner: ReactNode;
  readonly image: ImageShown;
  readonly play: Play;
  readonly box: Size;
  readonly text: ReactElement;
  readonly without: ReactElement;
}) => {
  const [element, setElement] = useState<HTMLSpanElement | null>(null);
  const seen = useSeen(element);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);

  if (failed) {
    return without;
  }

  return (
    <Stacked loaded={loaded} reference={setElement} box={box} text={text}>
      {seen ? (
        <>
          <img
            alt={image.alt}
            className={styles.picture}
            data-drawn="poster"
            decoding="async"
            loading="lazy"
            onError={() => {
              setFailed(true);
            }}
            onLoad={() => {
              setLoaded(true);
            }}
            referrerPolicy="no-referrer"
            src={image.src}
          />
          <PlayButton {...play} over="poster" />
          {corner}
        </>
      ) : null}
    </Stacked>
  );
};

/**
 * A poster that is animated, which never moves here: its first frame, taken from the
 * Daemon's bytes, since a poster is still until something plays.
 * @param props - The poster, its play button, what else sits in its corner, the text above
 * it, and what stands without it.
 * @returns The poster, or what stands without it.
 */
const FramePoster = ({
  corner,
  image,
  play,
  box,
  text,
  without,
}: {
  readonly corner: ReactNode;
  readonly image: ImageShown;
  readonly play: Play;
  readonly box: Size;
  readonly text: ReactElement;
  readonly without: ReactElement;
}) => {
  const [element, setElement] = useState<HTMLSpanElement | null>(null);
  const seen = useSeen(element);
  const fetched = useFetched(seen ? image.src : undefined);

  if (fetched._tag === "Failed") {
    return without;
  }

  return (
    <Stacked loaded={fetched._tag === "Ready"} reference={setElement} box={box} text={text}>
      {fetched._tag === "Ready" ? (
        <>
          <FirstFrame frame={fetched.frame} />
          <PlayButton {...play} over="poster" />
          {corner}
        </>
      ) : null}
    </Stacked>
  );
};

/**
 * A poster, a player's or a video's: a still image with its play button over the middle,
 * under the text above it, and what else sits in its corner. It opens nothing when pressed
 * except the play button, which calls `play.onPlay`. Where it fails to load, or to be
 * fetched, what stands without it shows instead: the one given, or else the text with the
 * same play button beside it. It is drawn in `box`, the shape of the box its video or
 * player plays in, whether it has loaded or not.
 * @param props - The poster, its play button, what else sits in its corner, the shape of its
 * box, the text above it, and what stands without it, if not the text and the button.
 * @returns The poster with its text, or what stands without it.
 */
export const PreviewPoster = ({
  corner,
  image,
  play,
  box,
  text,
  without: given,
}: {
  readonly corner: ReactNode;
  readonly image: ImageShown;
  readonly play: Play;
  readonly box: Size;
  readonly text: ReactElement;
  readonly without?: ReactElement | undefined;
}) => {
  const without = given ?? (
    <>
      {text}
      <PlayButton {...play} over="text" />
    </>
  );

  return image.animated ? (
    <FramePoster
      corner={corner}
      image={image}
      play={play}
      box={box}
      text={text}
      without={without}
    />
  ) : (
    <StillPoster
      corner={corner}
      image={image}
      play={play}
      box={box}
      text={text}
      without={without}
    />
  );
};

/**
 * A player playing: its frame under the text, in the box its poster stood in, at most as
 * tall as a poster. The frame is sandboxed, so what plays there can run scripts and open a
 * window of its own, but cannot navigate this page, submit a form, or reach anything else
 * of it, and is told its origin and no more of where it was embedded.
 * @param props - The player, as drawn, the shape of its box, and the text above it.
 * @returns The text with the frame under it.
 */
export const PlayerFrame = ({
  player,
  box,
  text,
}: {
  readonly player: PlayerShown;
  readonly box: Size;
  readonly text: ReactElement;
}) => (
  <div className={styles.stacked}>
    {text}
    <iframe
      allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
      className={styles.frame}
      referrerPolicy="strict-origin"
      // oxlint-disable-next-line react/iframe-missing-sandbox -- the frame is another site's, which the page's frame-src limits to the Owner's player hosts, so its own origin gives it nothing of ours, and a player needs both to play
      sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"
      src={player.src}
      style={boxStyle(box)}
      title={`Player from ${player.host}`}
    />
  </div>
);

/**
 * A video in a box of the shape its poster stood in, as tall as a poster at most, so
 * playing it moves nothing below it, with what else sits in its corner.
 * @param props - What sits in the corner, which video element to ask for it, the box's
 * shape, and the video's own attributes.
 * @returns The box.
 */
export const VideoBox = ({
  corner,
  reference,
  box,
  ...video
}: VideoHTMLAttributes<HTMLVideoElement> & {
  readonly corner: ReactNode;
  readonly reference: RefObject<HTMLVideoElement | null>;
  readonly box: Size;
}) => (
  <span className={styles.boxed} style={boxStyle(box)}>
    {/* oxlint-disable-next-line jsx-a11y/media-has-caption -- a stranger's media carries no captions the Daemon could offer */}
    <video {...video} className={styles.video} controls ref={reference} />
    {corner}
  </span>
);

/**
 * A video playing under its text, in the box a poster stood in.
 * @param props - The text above it, and what draws the video.
 * @returns The text with the video under it.
 */
export const VideoFrame = ({
  box,
  text,
}: {
  readonly box: ReactElement;
  readonly text: ReactElement;
}) => (
  <div className={styles.stacked}>
    {text}
    {box}
  </div>
);

/**
 * An image the Daemon kept, drawn from its own origin once it scrolls into view. Where it
 * fails to load, nothing is drawn, and what is drawn without it shows.
 * @param props - The image, its page's link, and what to draw in its place.
 * @returns The image, or what stands without it.
 */
export const PreviewImage = ({
  image,
  link,
  without,
}: {
  readonly image: ImageShown;
  readonly link: LinkShown;
  readonly without: ReactElement | null;
}) =>
  image.animated ? (
    <AnimatedImage image={image} link={link} without={without} />
  ) : (
    <StillImage image={image} link={link} without={without} />
  );
