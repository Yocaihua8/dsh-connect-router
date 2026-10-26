// Minimal HTTP client for one `opencode serve` instance.
//
// OpenCode authenticates with HTTP Basic when OPENCODE_SERVER_PASSWORD is set.
// Every failure is normalized to a BackendError carrying a numeric `status` and
// the upstream message, because DSH surfaces that text to the user and a bare
// "fetch failed" tells them nothing.

import { readSse } from "../../stream.js";

const DEFAULT_TIMEOUT_MS = 30000;

/** One failed call against the OpenCode server. */
export class BackendError extends Error {
  /**
   * @param message - human-readable cause, including the upstream body excerpt.
   * @param status - HTTP-like status; 502 for transport failures.
   * @param code - stable machine code.
   */
  constructor(message, status = 502, code = "upstream_error") {
    super(message);
    this.name = "BackendError";
    this.status = status;
    this.code = code;
  }
}

export class Backend {
  /**
   * @param base - origin such as `http://127.0.0.1:41234`.
   * @param password - the generated server password.
   * @param log - diagnostic sink.
   */
  constructor(base, password, log = () => {}) {
    this.base = base;
    this.password = password;
    this.log = log;
  }

  headers() {
    const token = Buffer.from(`opencode:${this.password}`).toString("base64");
    return { "Content-Type": "application/json", Authorization: `Basic ${token}` };
  }

  /**
   * One request. `timeout` of `null` means "no timeout" and requires `signal`.
   *
   * @returns the parsed JSON body, or `null` for an empty response.
   */
  async request(route, method = "GET", body, signal, timeout = DEFAULT_TIMEOUT_MS) {
    const signals = signal ? [signal] : [];
    if (timeout !== null) signals.push(AbortSignal.timeout(timeout));
    const composed = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
    let response;
    try {
      response = await fetch(this.base + route, {
        method,
        headers: this.headers(),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: composed,
      });
    } catch (error) {
      // A caller abort is not an upstream failure; let the caller see it.
      if (signal?.aborted) throw error;
      throw new BackendError(`OpenCode request failed: ${error?.message ?? error}`, 502, "transport");
    }
    const text = await response.text();
    if (!response.ok) {
      throw new BackendError(
        `OpenCode HTTP ${response.status}: ${text.slice(0, 600)}`,
        response.status >= 500 ? 502 : response.status,
      );
    }
    if (text.length === 0) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new BackendError("OpenCode returned a non-JSON response", 502, "invalid_response");
    }
  }

  /** Startup readiness probe. */
  health(timeout = 2000) {
    return this.request("/global/health", "GET", undefined, undefined, timeout);
  }

  /** Every provider OpenCode knows about, with its model catalog. */
  providers() {
    return this.request("/provider", "GET", undefined, undefined, 60000);
  }

  /** Create a session; every native tool is denied by the isolated config. */
  createSession(title, signal) {
    return this.request("/session", "POST", { title }, signal);
  }

  deleteSession(sessionId) {
    return this.request(`/session/${encodeURIComponent(sessionId)}`, "DELETE", undefined, undefined, 10000);
  }

  abortSession(sessionId) {
    return this.request(
      `/session/${encodeURIComponent(sessionId)}/abort`,
      "POST",
      undefined,
      undefined,
      10000,
    );
  }

  /**
   * Send one prompt and wait for the completed envelope.
   *
   * The endpoint is blocking: it resolves only after the whole turn finished,
   * which is why streaming is fed from the event bus in parallel.
   */
  sendMessage(sessionId, payload, signal) {
    return this.request(
      `/session/${encodeURIComponent(sessionId)}/message`,
      "POST",
      payload,
      signal,
      null,
    );
  }

  /** History of one session, oldest first. */
  getMessages(sessionId, signal) {
    return this.request(`/session/${encodeURIComponent(sessionId)}/message`, "GET", undefined, signal);
  }

  /**
   * The server event bus as an async iterable of parsed payloads.
   *
   * Frames are `data: <json>`; the `event:` line duplicates `payload.type`, so
   * only the data line is parsed.
   */
  async *events(signal, onReady = () => {}) {
    let response;
    try {
      response = await fetch(this.base + "/event", {
        headers: { ...this.headers(), Accept: "text/event-stream" },
        signal,
      });
    } catch (error) {
      throw new BackendError(`OpenCode event stream failed: ${error?.message ?? error}`, 502, "transport");
    }
    if (!response.ok) throw new BackendError(`OpenCode event stream HTTP ${response.status}`, 502, "transport");
    if (!response.body) throw new BackendError("OpenCode event stream had no body", 502, "invalid_response");

    onReady();
    for await (const frame of readSse(response.body, signal)) {
      if (!frame.trim()) continue;
      try {
        yield JSON.parse(frame);
      } catch {
        throw new BackendError("OpenCode event stream contained invalid JSON", 502, "INVALID_PACKET");
      }
    }
  }
}
