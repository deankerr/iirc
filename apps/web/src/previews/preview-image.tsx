/**
 * An image a Preview shows, loaded only once it scrolls into view. One that is not animated
 * is drawn as it is, and opens large when pressed. An animated one is fetched from the
 * Daemon once, drawn as its first frame under a play badge, which a press plays in place,
 * and stops again, with a control beside it, while it plays, that opens it large. Where it
 * cannot be fetched or decoded, nothing is drawn, and what is drawn without it shows.
 *
 * @packageDocumentation
 */
import { useAtomValue } from "@effect/atom-react";
import { motionOf, pressOn } from "@iirc/frontend/previews";
import type { ImageShown, LinkShown, Motion } from "@iirc/frontend/previews";
import type { ReactElement, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { Button as AriaButton } from "react-aria-components";

import { animateShown } from "../options/ui.ts";
import { Icon } from "../ui/icon.tsx";
import { OpensLarger } from "./larger-view.tsx";
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
 * What holds an image, as big as it will be drawn, so what is drawn and what stands in its
 * place until it loads share one box.
 * @param props - How it is drawn, whether there is anything in it, what is in it, and how
 *   it is found.
 * @returns The box.
 */
const Holder = ({
  children,
  drawn,
  loaded,
  reference,
}: {
  readonly children: ReactNode;
  readonly drawn: ImageShown["drawn"];
  readonly loaded: boolean;
  readonly reference: (element: HTMLSpanElement | null) => void;
}) => (
  <span
    className={drawn === "Whole" ? styles.whole : styles.thumbnail}
    data-loaded={loaded}
    ref={reference}
  >
    {children}
  </span>
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

  if (failed) {
    return without;
  }

  return (
    <Holder drawn={image.drawn} loaded={seen} reference={setElement}>
      {seen ? (
        <OpensLarger alt={image.alt} link={link} src={image.src}>
          <AriaButton aria-label={`Open ${image.alt} large`} className={styles.press}>
            <img
              alt={image.alt}
              className={styles.picture}
              data-drawn={image.drawn === "Whole" ? "whole" : "thumbnail"}
              decoding="async"
              loading="lazy"
              onError={() => {
                setFailed(true);
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
    <Holder drawn={image.drawn} loaded={fetched._tag === "Ready"} reference={setElement}>
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
                data-drawn={image.drawn === "Whole" ? "whole" : "thumbnail"}
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
            <OpensLarger alt={image.alt} link={link} src={fetched.url}>
              <AriaButton aria-label={`Open ${image.alt} large`} className={styles.enlarge}>
                <Icon name="enlarge" />
              </AriaButton>
            </OpensLarger>
          ) : null}
        </>
      ) : null}
    </Holder>
  );
};

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
