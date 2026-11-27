/**
 * An animated image's first frame: its bytes fetched from the Daemon once, held as an
 * object URL that plays, with their first frame decoded to draw it still.
 *
 * @packageDocumentation
 */
import { useEffect, useRef, useState } from "react";

/**
 * An animated image as the Daemon served it: `Loading` until fetched, the bytes as an
 * object URL, which plays, with their first frame decoded, or `Failed`.
 */
export type Fetched =
  | { readonly _tag: "Loading" }
  | { readonly _tag: "Ready"; readonly url: string; readonly frame: ImageBitmap }
  | { readonly _tag: "Failed" };

/**
 * Fetches an image's bytes from the Daemon's own origin once, as the page's other calls are
 * made, and decodes its first frame, until it is let go of, which frees both.
 * @param src - Where to fetch it from, or none to fetch nothing yet.
 * @returns How it stands.
 */
export const useFirstFrame = (src: string | undefined): Fetched => {
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
 * @param props - The frame, and the class it is drawn with.
 * @returns The canvas.
 */
export const FirstFrame = ({
  className,
  frame,
}: {
  readonly className: string;
  readonly frame: ImageBitmap;
}) => {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    canvas.current?.getContext("2d")?.drawImage(frame, 0, 0);
  }, [frame]);

  return (
    <canvas
      aria-hidden
      className={className}
      height={frame.height}
      ref={canvas}
      width={frame.width}
    />
  );
};
