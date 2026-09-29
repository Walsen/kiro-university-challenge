/**
 * `AuthScreen` — the account screens: sign-up, confirm, sign-in, and account
 * recovery, plus sign-out from the header (tasks 10.2, R1–R3, R12.3).
 *
 * The screen depends only on the {@link PlatformClient} auth surface
 * (`platform.auth`), never on Cognito. It is a small state machine over the
 * auth *modes* (`signIn`, `signUp`, `confirm`, `recoverStart`, `recoverComplete`)
 * and renders clear, explicit feedback for each step (R12.3): a busy state while
 * a call is in flight, an error headline on failure, and a confirmation/next-step
 * message on success.
 *
 * Non-disclosure (R2.2 invalid credentials don't reveal the factor; R3.4
 * recovery doesn't reveal existence) is enforced inside the auth adapter; this
 * screen simply shows whatever message the provider returns and never infers or
 * reveals more.
 *
 * On a successful sign-in it calls `onAuthenticated`, which the shell uses to
 * refresh the session mirror and route into the app.
 */
import { useState, type FormEvent } from "react";

import { usePlatform } from "../platform/PlatformProvider";

/** The distinct auth flows the screen can be in. */
type AuthMode = "signIn" | "signUp" | "confirm" | "recoverStart" | "recoverComplete";

/** Explicit status of the in-flight auth action (R12.3, R12.5 — never frozen). */
type ActionStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "busy" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "info"; readonly message: string };

export interface AuthScreenProps {
  /** Called after a sign-in establishes a session, so the shell can route in. */
  readonly onAuthenticated: () => void;
}

export function AuthScreen({ onAuthenticated }: AuthScreenProps): JSX.Element {
  const platform = usePlatform();

  const [mode, setMode] = useState<AuthMode>("signIn");
  const [status, setStatus] = useState<ActionStatus>({ kind: "idle" });

  // Form fields (shared across modes; each mode reads the ones it needs).
  const [identifier, setIdentifier] = useState("");
  const [credential, setCredential] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [code, setCode] = useState("");
  const [newCredential, setNewCredential] = useState("");

  const busy = status.kind === "busy";

  /** Run an auth action, mapping a thrown expected-failure to an error state. */
  async function runAction(
    action: () => Promise<void>,
    onSuccess: () => void,
  ): Promise<void> {
    setStatus({ kind: "busy" });
    try {
      await action();
      onSuccess();
    } catch (error) {
      setStatus({ kind: "error", message: messageOf(error) });
    }
  }

  function handleSignIn(event: FormEvent): void {
    event.preventDefault();
    void runAction(
      async () => {
        await platform.auth.signIn(identifier, credential);
      },
      () => {
        setStatus({ kind: "idle" });
        onAuthenticated();
      },
    );
  }

  function handleSignUp(event: FormEvent): void {
    event.preventDefault();
    void runAction(
      async () => {
        const result = await platform.auth.signUp(identifier, credential, displayName);
        // Route to confirmation only when the Platform requires it (R1.5);
        // otherwise the account is ready to sign in.
        setMode(result.confirmationRequired ? "confirm" : "signIn");
        setStatus({
          kind: "info",
          message: result.confirmationRequired
            ? "Account created. Enter the confirmation code we sent you."
            : "Account created. You can sign in now.",
        });
      },
      () => {
        /* status already set inside the action */
      },
    );
  }

  function handleConfirm(event: FormEvent): void {
    event.preventDefault();
    void runAction(
      async () => {
        await platform.auth.confirm(identifier, code);
      },
      () => {
        setMode("signIn");
        setStatus({ kind: "info", message: "Confirmed. You can sign in now." });
      },
    );
  }

  function handleRecoverStart(event: FormEvent): void {
    event.preventDefault();
    void runAction(
      async () => {
        await platform.auth.startRecovery(identifier);
      },
      () => {
        setMode("recoverComplete");
        // Deliberately generic — recovery never reveals whether the identifier
        // exists (R3.4). The adapter enforces this; the copy matches it.
        setStatus({
          kind: "info",
          message: "If that account exists, a recovery code is on its way.",
        });
      },
    );
  }

  function handleRecoverComplete(event: FormEvent): void {
    event.preventDefault();
    void runAction(
      async () => {
        await platform.auth.completeRecovery(identifier, code, newCredential);
      },
      () => {
        setMode("signIn");
        setStatus({
          kind: "info",
          message: "Your credential was reset. Sign in with your new password.",
        });
      },
    );
  }

  return (
    <section className="screen auth" aria-labelledby="auth-heading">
      <h2 id="auth-heading">{headingFor(mode)}</h2>

      <AuthStatus status={status} />

      {mode === "signIn" ? (
        <form className="form" onSubmit={handleSignIn} aria-label="Sign in">
          <Field
            id="auth-identifier"
            label="Email"
            type="email"
            value={identifier}
            onChange={setIdentifier}
            autoComplete="username"
          />
          <Field
            id="auth-credential"
            label="Password"
            type="password"
            value={credential}
            onChange={setCredential}
            autoComplete="current-password"
          />
          <button type="submit" className="btn btn--primary" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
      ) : null}

      {mode === "signUp" ? (
        <form className="form" onSubmit={handleSignUp} aria-label="Create account">
          <Field
            id="auth-identifier"
            label="Email"
            type="email"
            value={identifier}
            onChange={setIdentifier}
            autoComplete="username"
          />
          <Field
            id="auth-display-name"
            label="Display name"
            type="text"
            value={displayName}
            onChange={setDisplayName}
            autoComplete="nickname"
          />
          <Field
            id="auth-credential"
            label="Password"
            type="password"
            value={credential}
            onChange={setCredential}
            autoComplete="new-password"
          />
          <button type="submit" className="btn btn--primary" disabled={busy}>
            {busy ? "Creating…" : "Create account"}
          </button>
        </form>
      ) : null}

      {mode === "confirm" ? (
        <form className="form" onSubmit={handleConfirm} aria-label="Confirm account">
          <Field
            id="auth-identifier"
            label="Email"
            type="email"
            value={identifier}
            onChange={setIdentifier}
            autoComplete="username"
          />
          <Field
            id="auth-code"
            label="Confirmation code"
            type="text"
            value={code}
            onChange={setCode}
            autoComplete="one-time-code"
          />
          <button type="submit" className="btn btn--primary" disabled={busy}>
            {busy ? "Confirming…" : "Confirm"}
          </button>
        </form>
      ) : null}

      {mode === "recoverStart" ? (
        <form
          className="form"
          onSubmit={handleRecoverStart}
          aria-label="Start account recovery"
        >
          <Field
            id="auth-identifier"
            label="Email"
            type="email"
            value={identifier}
            onChange={setIdentifier}
            autoComplete="username"
          />
          <button type="submit" className="btn btn--primary" disabled={busy}>
            {busy ? "Sending…" : "Send recovery code"}
          </button>
        </form>
      ) : null}

      {mode === "recoverComplete" ? (
        <form
          className="form"
          onSubmit={handleRecoverComplete}
          aria-label="Complete account recovery"
        >
          <Field
            id="auth-identifier"
            label="Email"
            type="email"
            value={identifier}
            onChange={setIdentifier}
            autoComplete="username"
          />
          <Field
            id="auth-code"
            label="Recovery code"
            type="text"
            value={code}
            onChange={setCode}
            autoComplete="one-time-code"
          />
          <Field
            id="auth-new-credential"
            label="New password"
            type="password"
            value={newCredential}
            onChange={setNewCredential}
            autoComplete="new-password"
          />
          <button type="submit" className="btn btn--primary" disabled={busy}>
            {busy ? "Resetting…" : "Reset password"}
          </button>
        </form>
      ) : null}

      <AuthModeSwitcher mode={mode} onSelect={setMode} disabled={busy} />
    </section>
  );
}

/** The switch-mode links, shown as buttons so they are keyboard operable (R12.4). */
function AuthModeSwitcher({
  mode,
  onSelect,
  disabled,
}: {
  readonly mode: AuthMode;
  readonly onSelect: (mode: AuthMode) => void;
  readonly disabled: boolean;
}): JSX.Element {
  return (
    <nav className="auth__switch" aria-label="Other account actions">
      {mode !== "signIn" ? (
        <button
          type="button"
          className="btn btn--link"
          onClick={() => onSelect("signIn")}
          disabled={disabled}
        >
          Sign in
        </button>
      ) : null}
      {mode !== "signUp" ? (
        <button
          type="button"
          className="btn btn--link"
          onClick={() => onSelect("signUp")}
          disabled={disabled}
        >
          Create account
        </button>
      ) : null}
      {mode !== "recoverStart" && mode !== "recoverComplete" ? (
        <button
          type="button"
          className="btn btn--link"
          onClick={() => onSelect("recoverStart")}
          disabled={disabled}
        >
          Forgot password?
        </button>
      ) : null}
    </nav>
  );
}

/** Render the explicit auth action status as an accessible live region (R12.5). */
function AuthStatus({ status }: { readonly status: ActionStatus }): JSX.Element | null {
  if (status.kind === "error") {
    return (
      <p className="notice notice--error" role="alert">
        {status.message}
      </p>
    );
  }
  if (status.kind === "info") {
    return (
      <p className="notice notice--info" role="status">
        {status.message}
      </p>
    );
  }
  return null;
}

/** A labeled text input; the label is associated for keyboard/AT use (R12.4). */
function Field({
  id,
  label,
  type,
  value,
  onChange,
  autoComplete,
}: {
  readonly id: string;
  readonly label: string;
  readonly type: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly autoComplete: string;
}): JSX.Element {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type={type}
        value={value}
        autoComplete={autoComplete}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

function headingFor(mode: AuthMode): string {
  switch (mode) {
    case "signIn":
      return "Sign in";
    case "signUp":
      return "Create your account";
    case "confirm":
      return "Confirm your account";
    case "recoverStart":
      return "Recover your account";
    case "recoverComplete":
      return "Set a new password";
    default:
      return mode;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
