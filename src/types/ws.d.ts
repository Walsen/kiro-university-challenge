/**
 * Ambient declaration for the narrow slice of the `ws` module used by the task
 * 17.3 realtime integration seam test.
 *
 * `ws` is a transitive dependency and ships no bundled types; `@types/ws` is not
 * a project dependency because production code targets the browser `WebSocket`.
 * The only place that opens a real server-side WebSocket is the gated realtime
 * integration test (against the deployed AppSync Events endpoint). Declaring the
 * used surface here keeps that test fully typed without adding a runtime or type
 * dependency to the project. This file carries no runtime code.
 */
declare module "ws" {
  /** The subset of the `ws` WebSocket surface the integration test relies on. */
  export class WebSocket {
    constructor(address: string, protocols?: string | ReadonlyArray<string>);
    send(data: string): void;
    close(): void;
    on(event: "open", listener: () => void): void;
    on(event: "message", listener: (data: Buffer | string) => void): void;
    on(event: "error", listener: (err: unknown) => void): void;
    off(event: "message", listener: (data: Buffer | string) => void): void;
    off(event: "error", listener: (err: unknown) => void): void;
  }
}
