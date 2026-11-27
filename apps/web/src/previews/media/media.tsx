/**
 * A Preview's media, whatever it is: a picture, a video, a sound, or another site's player.
 * Each loads and plays on its own, reserves its box before anything loads, and says only
 * that it failed. Keyed by its source, media the Daemon answers anew starts afresh.
 *
 * @packageDocumentation
 */
import type { LinkShown, MediaCardShown } from "@iirc/frontend/previews";

import { EmbeddedPlayer } from "./embedded-player.tsx";
import { Picture } from "./picture.tsx";
import { Sound } from "./sound.tsx";
import { Video } from "./video.tsx";

/**
 * A Preview's media.
 * @param props - The media; its page's link, for the lightbox; what its card is called, for
 *   its labels; whether a video, a sound, or a player starts playing at once; and what it
 *   says when it cannot be drawn or played at all.
 * @returns The media.
 */
export const Media = ({
  link,
  media,
  name,
  onFail,
  playing,
}: {
  readonly link: LinkShown;
  readonly media: MediaCardShown["media"];
  readonly name: string;
  readonly onFail: () => void;
  readonly playing: boolean;
}) => {
  switch (media._tag) {
    case "Picture": {
      return <Picture key={media.src} link={link} onFail={onFail} picture={media} />;
    }

    case "Video": {
      return (
        <Video
          key={media.src}
          link={link}
          name={name}
          onFail={onFail}
          playing={playing}
          video={media}
        />
      );
    }

    case "Player": {
      return <EmbeddedPlayer key={media.src} player={media} playing={playing} />;
    }

    case "Sound": {
      return <Sound key={media.src} name={name} onFail={onFail} playing={playing} sound={media} />;
    }

    default: {
      return media satisfies never;
    }
  }
};
