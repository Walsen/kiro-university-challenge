/**
 * Smoke tests for the SPA shell wiring (task 10.2).
 *
 * These verify the shell is correctly wired to the {@link PlatformClient} port
 * — auth gating, the sign-in → run-setup route, sign-out, and that screens read
 * the injected fake — without touching the network (the fake stands in for the
 * SDK). Comprehensive component + a11y coverage is task 10.4; these are the
 * minimum render/wiring checks called for by the Definition of Done.
 */
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { App } from "./App";
import { createFakePlatform, fakeSession } from "./test/fakePlatform";
import { renderWithPlatform } from "./test/renderWithPlatform";

describe("App shell", () => {
  it("shows the sign-in screen when signed out", () => {
    renderWithPlatform(<App />, createFakePlatform());

    expect(screen.getByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.getByText("Signed out")).toBeInTheDocument();
    // The signed-in tabs are not present when signed out.
    expect(screen.queryByRole("button", { name: "Play" })).not.toBeInTheDocument();
  });

  it("routes to run setup and shows the display name after sign-in", async () => {
    const user = userEvent.setup();
    renderWithPlatform(
      <App />,
      createFakePlatform({ signIn: () => Promise.resolve(fakeSession("Grace")) }),
    );

    await user.type(screen.getByLabelText("Email"), "grace@example.com");
    await user.type(screen.getByLabelText("Password"), "hunter2!");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    // Session mirror updates → shell re-routes to the signed-in Play tab.
    expect(await screen.findByRole("heading", { name: "New run" })).toBeInTheDocument();
    expect(screen.getByText("Grace")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
  });

  it("signs out back to the auth screen", async () => {
    const user = userEvent.setup();
    renderWithPlatform(
      <App />,
      createFakePlatform({ initialSession: fakeSession("Linus") }),
    );

    expect(screen.getByText("Linus")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Sign out" }));

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    });
  });

  it("navigates to run setup requiring a run before showing scores", async () => {
    const user = userEvent.setup();
    renderWithPlatform(
      <App />,
      createFakePlatform({ initialSession: fakeSession() }),
    );

    await user.click(screen.getByRole("button", { name: "Scores" }));
    // No scope chosen yet → the shell prompts to start a run instead of querying.
    expect(screen.getByText(/set up and start a run/i)).toBeInTheDocument();
  });
});
