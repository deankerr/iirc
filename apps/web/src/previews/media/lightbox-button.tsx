/**
 * The control in the corner of media that opens it in the lightbox, the same square as the
 * one that closes a video's lightbox.
 *
 * @packageDocumentation
 */
import type { LinkShown } from "@iirc/frontend/previews";
import { Button as AriaButton } from "react-aria-components";

import { Icon } from "../../ui/icon.tsx";
import { Lightbox } from "./lightbox.tsx";
import type { LightboxMedia } from "./lightbox.tsx";

import corner from "./lightbox-button.module.css";
import lightbox from "./lightbox.module.css";

/**
 * The control that opens media in the lightbox.
 * @param props - What the lightbox draws, its page's link, what to call it, and what else
 *   happens as it opens.
 * @returns The control, and the lightbox it opens.
 */
export const LightboxButton = ({
  link,
  media,
  name,
  onOpen,
}: {
  readonly link: LinkShown;
  readonly media: LightboxMedia;
  readonly name: string;
  readonly onOpen?: (() => void) | undefined;
}) => (
  <Lightbox alt={name} link={link} media={media} onOpen={onOpen}>
    <AriaButton aria-label={`enlarge ${name}`} className={`${lightbox.control} ${corner.corner}`}>
      <Icon name="enlarge" />
    </AriaButton>
  </Lightbox>
);
