/**
 * RequestThrottle — deduplication for autocomplete requests.
 *
 * Prevents concurrent requests to the same document.
 * VS Code calls provideInlineCompletionItems on EVERY keystroke;
 * this ensures we only fire one API call at a time.
 */

export interface RequestFingerprint {
  documentUri: string;
  positionLine: number;
  positionCharacter: number;
  contextHash: string;
}

export class RequestThrottle {
  private _pendingController: AbortController | null = null;

  /**
   * If a request is already in flight, returns true (caller should skip).
   * Otherwise returns false (caller should proceed).
   */
  shouldSkip(): boolean {
    return this._pendingController !== null;
  }

  /**
   * Mark that a request has started. Returns an AbortController.
   */
  beginRequest(): AbortController {
    // Safety: abort any stale request (shouldn't happen if shouldSkip is checked)
    if (this._pendingController) {
      this._pendingController.abort();
    }
    const controller = new AbortController();
    this._pendingController = controller;
    return controller;
  }

  /**
   * Mark that a request has completed.
   */
  endRequest(controller: AbortController): void {
    if (this._pendingController === controller) {
      this._pendingController = null;
    }
  }

  dispose(): void {
    this._pendingController?.abort();
    this._pendingController = null;
  }
}
