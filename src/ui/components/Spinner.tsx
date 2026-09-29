/**
 * `Spinner` — an accessible "loading" affordance (R12.3, R12.4).
 *
 * Rendered while a platform read is in flight so the screen is visibly working
 * rather than blank or frozen. It carries an ARIA `status` role and a
 * `label` so assistive technology announces the wait; the visual is CSS-only.
 */
export interface SpinnerProps {
  readonly label?: string;
}

export function Spinner({ label = "Loading" }: SpinnerProps): JSX.Element {
  return (
    <div className="spinner" role="status" aria-live="polite">
      <span className="spinner__dot" aria-hidden="true" />
      <span className="spinner__label">{label}…</span>
    </div>
  );
}
