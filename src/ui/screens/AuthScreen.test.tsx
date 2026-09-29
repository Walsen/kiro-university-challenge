/**
 * Component + accessibility tests for the account screen (task 11.4, R12.3,
 * R12.4, R12.5).
 *
 * These render the real {@link AuthScreen} against an injected fake
 * {@link PlatformClient}, so nothing touches Cognito or the network. They cover:
 *   - the auth states the screen can be in: idle forms, an in-flight busy
 *     affordance, an explicit success/info message, and an explicit error;
 *   - keyboard operability — every form can be completed and submitted with the
 *     keyboard alone (tab to fields, type, Enter to submit), and the mode
 *     switches are real, focusable buttons (R12.4);
 *   - perceivable feedback — a submit shows a busy label the user can perceive,
 *     and results are announced via ARIA live regions (`role="alert"` for
 *     errors, `role="status"` for info) (R12.3/R12.4);
 *   - explicit failure states — a rejected sign-in surfaces an explicit,
 *     announced error rather than a frozen/blank screen, and the form stays
 *     operable so the user can try again (R12.5);
 *   - accessibility of the controls — inputs have associated `<label>`s (queried
 *     by accessible name), each form has an accessible name, and the submit is a
 *     button with an accessible name.
 */
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { AuthScreen } from "./AuthScreen";
import { createFakePlatform, fakeSession } from "../test/fakePlatform";
import { renderWithPlatform } from "../test/renderWithPlatform";
import type { AuthSession } from "../../client/ports/PlatformClient";

/** A no-op authenticated callback for the screens that don't assert routing. */
const noop = (): void => {};

describe("AuthScreen — states, keyboard operability, and a11y (task 11.4)", () => {
  it("renders the sign-in form with labeled, keyboard-reachable fields (R12.3/R12.4)", () => {
    renderWithPlatform(<AuthScreen onAuthenticated={noop} />, createFakePlatform());

    // The form has an accessible name and its inputs are associated with labels.
    const form = screen.getByRole("form", { name: "Sign in" });
    expect(form).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
    // The submit is a real button with an accessible name (operable by keyboard).
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
  });

  it("completes and submits sign-in with the keyboard alone, then routes (R12.4)", async () => {
    const user = userEvent.setup();
    let authenticated = false;
    renderWithPlatform(
      <AuthScreen
        onAuthenticated={() => {
          authenticated = true;
        }}
      />,
      createFakePlatform({ signIn: () => Promise.resolve(fakeSession("Ada")) }),
    );

    // Drive entirely from the keyboard: tab to the first field, type, tab, type,
    // then submit with Enter from within the field (no mouse).
    await user.tab();
    expect(screen.getByLabelText("Email")).toHaveFocus();
    await user.keyboard("ada@example.com");
    await user.tab();
    expect(screen.getByLabelText("Password")).toHaveFocus();
    await user.keyboard("hunter2!{Enter}");

    await waitFor(() => expect(authenticated).toBe(true));
  });

  it("shows a perceivable busy affordance while a sign-in is in flight (R12.3)", async () => {
    const user = userEvent.setup();
    // A sign-in that never settles so we can observe the in-flight busy state.
    const neverSettles = new Promise<AuthSession>(() => {});
    renderWithPlatform(
      <AuthScreen onAuthenticated={noop} />,
      createFakePlatform({ signIn: () => neverSettles }),
    );

    await user.type(screen.getByLabelText("Email"), "ada@example.com");
    await user.type(screen.getByLabelText("Password"), "hunter2!");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    // The button label changes to a busy verb and the control is disabled — a
    // state the user (and AT) can perceive, not a frozen unlabeled spinner.
    const busyButton = await screen.findByRole("button", { name: "Signing in…" });
    expect(busyButton).toBeDisabled();
  });

  it("surfaces a rejected sign-in as an explicit, announced error and stays operable (R12.5)", async () => {
    const user = userEvent.setup();
    renderWithPlatform(
      <AuthScreen onAuthenticated={noop} />,
      createFakePlatform({
        // The auth provider throws for an expected failure (its contract); the
        // screen must turn that into an explicit, non-frozen error state.
        signIn: () => Promise.reject(new Error("Incorrect email or password")),
      }),
    );

    await user.type(screen.getByLabelText("Email"), "ada@example.com");
    await user.type(screen.getByLabelText("Password"), "wrong");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    // Explicit failure: an ARIA alert announces the reason...
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Incorrect email or password");
    // ...and the screen is not frozen: the button is operable again for a retry.
    const button = screen.getByRole("button", { name: "Sign in" });
    expect(button).toBeEnabled();
  });

  it("announces an info/next-step message via a status live region after sign-up (R12.3)", async () => {
    const user = userEvent.setup();
    renderWithPlatform(
      <AuthScreen onAuthenticated={noop} />,
      createFakePlatform(),
    );

    // Switch to the create-account form (a keyboard-operable button).
    await user.click(screen.getByRole("button", { name: "Create account" }));
    expect(screen.getByRole("form", { name: "Create account" })).toBeInTheDocument();

    await user.type(screen.getByLabelText("Email"), "grace@example.com");
    await user.type(screen.getByLabelText("Display name"), "Grace");
    await user.type(screen.getByLabelText("Password"), "hunter2!");
    await user.click(screen.getByRole("button", { name: "Create account" }));

    // The default fake requires confirmation → an explicit, announced next step.
    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("confirmation code");
    // And the screen routes to the confirm form (perceivable state change).
    expect(
      screen.getByRole("form", { name: "Confirm account" }),
    ).toBeInTheDocument();
  });

  it("keeps recovery non-disclosive with an explicit, generic status (R3.4/R12.5)", async () => {
    const user = userEvent.setup();
    renderWithPlatform(<AuthScreen onAuthenticated={noop} />, createFakePlatform());

    await user.click(screen.getByRole("button", { name: "Forgot password?" }));
    await user.type(screen.getByLabelText("Email"), "unknown@example.com");
    await user.click(screen.getByRole("button", { name: "Send recovery code" }));

    const status = await screen.findByRole("status");
    // Generic wording — the UI reveals nothing about whether the account exists.
    expect(status).toHaveTextContent(/if that account exists/i);
  });
});
