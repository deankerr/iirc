/**
 * React Aria's modal overlay and popover, each of which Back closes while it is open, as
 * Escape does. Every overlay of the web frontend is one of these.
 *
 * @packageDocumentation
 */
import { useContext } from "react";
import {
  ModalOverlay as AriaModalOverlay,
  OverlayTriggerStateContext,
  Popover as AriaPopover,
} from "react-aria-components";
import type { ModalOverlayProps, PopoverProps } from "react-aria-components";

import { useBackCloses } from "../page/back.ts";

/**
 * Lets Back close an overlay: by its own `isOpen` and `onOpenChange` where it is given them,
 * or else by the trigger it is opened from.
 * @param props - The overlay's own open state, if any.
 */
const useOverlayBack = ({
  isOpen,
  onOpenChange,
}: {
  readonly isOpen?: boolean | undefined;
  readonly onOpenChange?: ((isOpen: boolean) => void) | undefined;
}) => {
  const trigger = useContext(OverlayTriggerStateContext);

  useBackCloses(isOpen ?? trigger?.isOpen ?? false, () => {
    if (isOpen === undefined) {
      trigger?.close();
    } else {
      onOpenChange?.(false);
    }
  });
};

/**
 * A modal overlay that Back closes while it is open.
 * @param props - React Aria's.
 * @returns The overlay.
 */
export const ModalOverlay = (props: ModalOverlayProps) => {
  useOverlayBack(props);

  return <AriaModalOverlay {...props} />;
};

/**
 * A popover that Back closes while it is open.
 * @param props - React Aria's.
 * @returns The popover.
 */
export const Popover = (props: PopoverProps) => {
  useOverlayBack(props);

  return <AriaPopover {...props} />;
};
