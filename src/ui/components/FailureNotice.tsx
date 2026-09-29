/**
 * `FailureNotice` — the one explicit, accessible way the shell renders a typed
 * {@link PlatformFailure} (R12.3, R12.5).
 *
 * Every failing platform read/write routes through this component so failures
 * look and behave consistently: a headline mapped from the failure `kind`, the
 * server/transport detail as supporting text, and an optional "Retry" the
 * screen wires up for transient failures. It is an ARIA `alert` so assistive
 * technology announces it the moment it appears (R12.4), and it is never a
 * frozen dead-end — either the Player can retry, or the headline tells them what
 * to do (re-authenticate, fix input).
 */
import type { PlatformFailure } from "../../client/ports/PlatformClient";
import { failureHeadline, isRetryable } from "../platform/failure";

export interface FailureNoticeProps {
  readonly failure: PlatformFailure;
  /** Wire a retry for transient failures; omitted when retrying cannot help. */
  readonly onRetry?: () => void;
}

export function FailureNotice({ failure, onRetry }: FailureNoticeProps): JSX.Element {
  const canRetry = onRetry !== undefined && isRetryable(failure);
  return (
    <div className="notice notice--error" role="alert">
      <p className="notice__headline">{failureHeadline(failure)}</p>
      {failure.message.length > 0 ? (
        <p className="notice__detail">{failure.message}</p>
      ) : null}
      {canRetry ? (
        <button type="button" className="btn" onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </div>
  );
}
