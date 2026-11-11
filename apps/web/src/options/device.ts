/**
 * This device's overrides of the options under `ui`, as it last kept them in
 * `localStorage`, read once as the page starts. They are never sent.
 *
 * @packageDocumentation
 */
import { deviceUiKey, deviceUiOf } from "@iirc/frontend/ui";
import type { DeviceUi } from "@iirc/frontend/ui";
import { Atom } from "effect/reactivity";

import { readChoice } from "../page/device.ts";

/** This device's overrides of the options under `ui`, as it last kept them. */
export const deviceUi = Atom.make<DeviceUi>(deviceUiOf(readChoice(deviceUiKey))).pipe(
  Atom.keepAlive
);
