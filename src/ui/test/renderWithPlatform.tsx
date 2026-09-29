/**
 * Test helper: render a UI subtree wrapped in a {@link PlatformProvider} with a
 * fake {@link PlatformClient}. Keeps every smoke test one line of setup and
 * guarantees screens get their required platform context.
 */
import { render, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";

import type { PlatformClient } from "../../client/ports/PlatformClient";
import { PlatformProvider } from "../platform/PlatformProvider";

export function renderWithPlatform(
  ui: ReactElement,
  client: PlatformClient,
): RenderResult {
  return render(<PlatformProvider client={client}>{ui}</PlatformProvider>);
}
