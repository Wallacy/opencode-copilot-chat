/**
 * Throttle/Debounce for persistent autocomplete.
 *
 * Prevents flooding the API while the user is typing rapidly.
 *
 * Strategy:
 *   - Debounce: Wait for user to stop typing (configurable delay)
 *   - Cancellation: Cancel pending request when new input arrives
 *   - Minimum interval: Enforce minimum time between API requests
 *   - Request deduplication: Skip if same document+position+context
 *
 * This is critical for autocomplete UX:
 *   - User types fast → only the final keystroke triggers a request
 *   - User types one char → debounce fires after delay
 *   - User moves cursor → cancel pending, start fresh
 *   - Multiple rapid changes → only last one matters
 */

export interface ThrottleConfig {
  /** Delay after last keystroke before sending request (ms) */
  debounceMs: number;
  /** Minimum time between consecutive API requests (ms) */
  minIntervalMs: number;
  /** Maximum number of pending requests (usually 1) */
  maxPending: number;
}

export const DEFAULT_THROTTLE_CONFIG: ThrottleConfig = {
  debounceMs: 300,
  minIntervalMs: 500,
  maxPending: 1,
};

/**
 * Request fingerprint for deduplication.
 */
export interface RequestFingerprint {
  documentUri: string;
  positionLine: number;
  positionCharacter: number;
  contextHash: string;
}

/**
 * Manages debouncing and cancellation for autocomplete requests.
 *
 * Usage:
 *   const throttle = new RequestThrottle(config);
 *
 *   // In provideInlineCompletionItems:
 *   const fp = computeFingerprint(document, position);
 *   if (throttle.shouldSkip(fp)) return [];
 *
 *   const controller = throttle.beginRequest(fp);
 *   try {
 *     const result = await doAutocomplete(controller.signal);
 *     return result;
 *   } finally {
 *     throttle.endRequest(controller);
 *   }
 */
export class RequestThrottle {
  private _config: ThrottleConfig;
  private _lastRequestTime = 0;
  private _pendingController: AbortController | null = null;
  private _pendingFingerprint: RequestFingerprint | null = null;
  private _debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private _requestHistory: Array<{ timestamp: number; fingerprint: RequestFingerprint }> = [];

  constructor(config?: Partial<ThrottleConfig>) {
    this._config = { ...DEFAULT_THROTTLE_CONFIG, ...config };
  }

  /**
   * Check if a request should be skipped.
   * Skips when a request is already in flight — prevents abort cascade
   * where each keystroke kills the previous request before it finishes.
   * VS Code calls provideInlineCompletionItems on EVERY keystroke, so
   * without this guard, the API request never completes.
   */
  shouldSkip(_fingerprint: RequestFingerprint): boolean {
    if (this._pendingController) {
      return true;
    }
    return false;
  }

  /**
   * Start a new request. Cancels the previous one.
   */
  beginRequest(fingerprint: RequestFingerprint): AbortController {
    if (this._pendingController) {
      this._pendingController.abort();
    }

    const controller = new AbortController();
    this._pendingController = controller;
    this._pendingFingerprint = fingerprint;
    this._lastRequestTime = Date.now();

    this._requestHistory.push({ timestamp: Date.now(), fingerprint });
    if (this._requestHistory.length > 50) {
      this._requestHistory = this._requestHistory.slice(-50);
    }

    return controller;
  }

  /**
   * Mark a request as completed.
   */
  endRequest(controller: AbortController): void {
    if (this._pendingController === controller) {
      this._pendingController = null;
      this._pendingFingerprint = null;
    }
  }

  /**
   * Cancel the current pending request (e.g., when user changes focus).
   */
  cancelPending(): void {
    if (this._pendingController) {
      this._pendingController.abort();
      this._pendingController = null;
      this._pendingFingerprint = null;
    }
  }

  /**
   * Get debounce delay. Returns a promise that resolves after the debounce
   * delay, or rejects if cancelled.
   */
  debounce(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this._debounceTimer) {
        clearTimeout(this._debounceTimer);
      }
      this._debounceTimer = setTimeout(() => {
        this._debounceTimer = undefined;
        resolve();
      }, this._config.debounceMs);
    });
  }

  /**
   * Cancel the debounce timer.
   */
  cancelDebounce(): void {
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = undefined;
    }
  }

  /**
   * Check if there's a pending request.
   */
  get hasPending(): boolean {
    return this._pendingController !== null;
  }

  /**
   * Get recent request history for debugging.
   */
  get history(): ReadonlyArray<{ timestamp: number; fingerprint: RequestFingerprint }> {
    return this._requestHistory;
  }

  /**
   * Clean up all timers and controllers.
   */
  dispose(): void {
    this.cancelPending();
    this.cancelDebounce();
    this._requestHistory = [];
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Compute a fingerprint for a request based on document state and cursor position.
 */
export function computeFingerprint(
  documentUri: string,
  positionLine: number,
  positionCharacter: number,
  context: string,
): RequestFingerprint {
  // Simple hash of the context string (first 1000 chars for performance)
  const sample = context.slice(0, 1000);
  let hash = 0;
  for (let i = 0; i < sample.length; i++) {
    const char = sample.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }

  return {
    documentUri,
    positionLine,
    positionCharacter,
    contextHash: hash.toString(36),
  };
}

/**
 * Extract code context around the cursor position.
 * Includes enough context for the model to understand the code,
 * but not so much that it exceeds token limits.
 */
export function extractCodeContext(
  document: { getText: () => string; lineCount: number },
  positionLine: number,
  maxLinesAbove: number = 100,
  maxLinesBelow: number = 50,
): string {
  const fullText = document.getText();
  const lines = fullText.split("\n");

  const startLine = Math.max(0, positionLine - maxLinesAbove);
  const endLine = Math.min(lines.length, positionLine + maxLinesBelow + 1);

  const contextLines = lines.slice(startLine, endLine);
  return contextLines.join("\n");
}
