/**
 * How JavaScript dialogs (alert/confirm/prompt/beforeunload) are answered, per tab.
 *
 * The policy is applied in two places. The primary one is the page preload's main-world shim
 * over `window.alert/confirm/prompt`, which asks the main process for this policy from inside
 * the call: Electron answers every JS dialog raised in a `BrowserView` with Cancel within
 * milliseconds and does not implement `window.prompt` at all, so nothing that has to make a
 * CDP round trip can decide the answer. The secondary one is the hub's Playwright
 * `page.on("dialog")` handler, which is left in place for the dialogs the shim cannot reach —
 * `beforeunload`, and anything raised before the preload ran.
 *
 * Nothing here is persisted: policies are a per-session choice, and a stale "accept
 * everything" rule surviving a restart would be a trap rather than a convenience.
 *
 * No Electron import, so this module is unit-test-bundleable.
 */

export type DialogPolicy = { action: "accept" | "dismiss"; promptText?: string };

export type DialogSeen = {
  type: string;
  message: string;
  handledAs: "accept" | "dismiss";
  at: string;
};

const DEFAULT_POLICY: DialogPolicy = { action: "dismiss" };

export class DialogPolicies {
  private policies = new Map<string, DialogPolicy>();
  private seen = new Map<string, DialogSeen>();

  /** The policy for a tab, defaulting to `dismiss` — the safe answer for an unattended browser. */
  get(tabId: string): DialogPolicy {
    return this.policies.get(tabId) ?? { ...DEFAULT_POLICY };
  }

  set(tabId: string, p: DialogPolicy): void {
    const action = p.action === "accept" ? "accept" : "dismiss";
    const policy: DialogPolicy = { action };
    if (typeof p.promptText === "string") policy.promptText = p.promptText;
    this.policies.set(tabId, policy);
  }

  note(tabId: string, seen: DialogSeen): void {
    this.seen.set(tabId, seen);
  }

  last(tabId: string): DialogSeen | null {
    return this.seen.get(tabId) ?? null;
  }

  /** Drops both the policy and the last-seen record for a closed tab. */
  forget(tabId: string): void {
    this.policies.delete(tabId);
    this.seen.delete(tabId);
  }
}
