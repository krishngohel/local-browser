/**
 * How JavaScript dialogs (alert/confirm/prompt/beforeunload) are answered, per tab.
 *
 * The policy is applied by the Playwright `page.on("dialog")` handler the hub attaches the
 * first time it resolves a page for a tab, so a policy set before Playwright attaches is
 * remembered and takes effect as soon as it does. Nothing here is persisted: policies are a
 * per-session choice, and a stale "accept everything" rule surviving a restart would be a
 * trap rather than a convenience.
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
