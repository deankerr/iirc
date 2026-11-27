/**
 * A picture a Preview shows, loaded only once it is near the view, in a box whose shape is
 * the picture's own from before a byte of it loads, where the Daemon read its size, and a
 * placeholder until it has loaded where it did not. A still one is drawn as it is, and opens
 * the lightbox when pressed. An animated one is fetched from the Daemon once and drawn as
 * its first frame under a play badge, or moving, as `motionOf` says; a press plays or stops
 * it, as `pressOn` says, and while it moves a control in its corner opens the lightbox.
 * Where it cannot be fetched or decoded, nothing is drawn, and it says it failed.
 *
 * @packageDocumentation
 */
import { useAtomValue } from "@effect/atom-react";
import { motionOf, pressOn } from "@iirc/frontend/previews";
import type { LinkShown, Motion, PictureShown } from "@iirc/frontend/previews";
import { useEffect, useState } from "react";
import { Button as AriaButton } from "react-aria-components";

import { animateShown } from "../../options/ui.ts";
import { Icon } from "../../ui/icon.tsx";
import { FirstFrame, useFirstFrame } from "./first-frame.tsx";
import { LightboxButton } from "./lightbox-button.tsx";
import { Lightbox } from "./lightbox.tsx";
import { MediaBox } from "./media-box.tsx";
import { useNearView } from "./near-view.ts";
import { useReducedMotion } from "./reduced-motion.ts";

import box from "./media-box.module.css";
import styles from "./picture.module.css";

/** What a picture is drawn from, its page's link, and what it says when it fails. */
interface PictureProps {
  readonly link: LinkShown;
  readonly onFail: () => void;
  readonly picture: PictureShown;
}

/**
 * A picture that does not move, which opens the lightbox when pressed.
 * @param props - The picture, its page's link, and what it says when it fails.
 * @returns The picture, or nothing once it failed.
 */
const StillPicture = ({ link, onFail, picture }: PictureProps) => {
  const [element, setElement] = useState<HTMLSpanElement | null>(null);
  const near = useNearView(element);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);

  if (failed) {
    return null;
  }

  return (
    <MediaBox loaded={loaded} reference={setElement} size={picture.dimensions} still upToSize>
      {near ? (
        <Lightbox alt={picture.alt} link={link} media={{ _tag: "Image", src: picture.src }}>
          <AriaButton aria-label={`enlarge ${picture.alt}`} className={box.press}>
            <img
              alt={picture.alt}
              className={box.picture}
              decoding="async"
              loading="lazy"
              onError={() => {
                setFailed(true);
                onFail();
              }}
              onLoad={() => {
                setLoaded(true);
              }}
              referrerPolicy="no-referrer"
              src={picture.src}
            />
          </AriaButton>
        </Lightbox>
      ) : null}
    </MediaBox>
  );
};

/**
 * An animated picture: its first frame under a play badge, or moving.
 * @param props - The picture, its page's link, and what it says when it fails.
 * @returns The picture, or nothing once it failed.
 */
const AnimatedPicture = ({ link, onFail, picture }: PictureProps) => {
  const animate = useAtomValue(animateShown);
  const reducedMotion = useReducedMotion();
  const [element, setElement] = useState<HTMLSpanElement | null>(null);
  const near = useNearView(element);
  const fetched = useFirstFrame(near ? picture.src : undefined);
  const [chosen, setChosen] = useState<Motion | undefined>();
  const motion = motionOf({ animate, animated: true, chosen, reducedMotion });
  const failed = fetched._tag === "Failed";

  useEffect(() => {
    if (failed) {
      onFail();
    }
  }, [failed, onFail]);

  if (failed) {
    return null;
  }

  const moving = motion === "Moving";

  return (
    <MediaBox
      loaded={fetched._tag === "Ready"}
      reference={setElement}
      size={picture.dimensions}
      upToSize
    >
      {fetched._tag === "Ready" ? (
        <>
          <AriaButton
            aria-label={`${moving ? "stop" : "play"} ${picture.alt}`}
            className={box.press}
            onPress={() => {
              setChosen(pressOn(picture, motion) === "Play" ? "Moving" : "Still");
            }}
          >
            {moving ? (
              <img
                alt={picture.alt}
                className={box.picture}
                data-playing
                decoding="async"
                referrerPolicy="no-referrer"
                src={fetched.url}
              />
            ) : (
              <>
                <FirstFrame className={box.picture} frame={fetched.frame} />
                <span aria-hidden className={styles.badge} data-badge="play">
                  <Icon name="play" />
                </span>
              </>
            )}
          </AriaButton>
          {moving ? (
            <LightboxButton
              link={link}
              media={{ _tag: "Image", src: fetched.url }}
              name={picture.alt}
            />
          ) : null}
        </>
      ) : null}
    </MediaBox>
  );
};

/**
 * A picture the Daemon kept, drawn from its own origin once it is near the view.
 * @param props - The picture, its page's link, and what it says when it fails.
 * @returns The picture, or nothing once it failed.
 */
export const Picture = (props: PictureProps) =>
  props.picture.animated ? <AnimatedPicture {...props} /> : <StillPicture {...props} />;
