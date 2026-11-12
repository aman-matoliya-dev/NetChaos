/**
 * Builds the rejection reason for an aborted request, mirroring native fetch:
 * it rejects with `signal.reason` (a DOMException named "AbortError" by default,
 * or whatever value was passed to `controller.abort(reason)`).
 */
export function createAbortError(signal?: AbortSignal | null): unknown {
  const reason: unknown = signal?.reason;
  if (reason !== undefined) return reason;

  const message = "This operation was aborted";
  if (typeof DOMException === "function") return new DOMException(message, "AbortError");
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

/** Throws the abort reason if the signal is already aborted. */
export function throwIfAborted(signal?: AbortSignal | null): void {
  if (signal?.aborted) throw createAbortError(signal);
}
