/**
 * Which URLs an assistant (or a page) may steer Echo to.
 *
 * `normalizeUrl` passes any `scheme:` string straight through, which is what the address bar
 * needs — the user typing `file:///C:/notes.txt` means it. An MCP client is not the user: the
 * read tools (`html`, `get_text`, `pdf_text`) turn a `file:` navigation into a clean
 * text-extraction primitive over the whole disk, and `toolsBrowse` / `toolsRead` are both on
 * by default. So every navigation that originates outside the omnibox — MCP tools, recording
 * replay, and a page calling `window.open` — is limited to the web.
 *
 * Kept free of `electron` imports so it can be unit tested.
 */

/** Refusal text for a navigation an assistant is not allowed to make. */
export const ASSISTANT_NAV_REFUSAL =
  "Echo only opens http(s) pages from an assistant. Open local files yourself in the address bar.";

/** Leading `scheme:` of an input, lowercased and including the colon, or "" for bare input. */
function schemeOf(trimmed: string): string {
  // Matches `normalizeUrl`'s own scheme test so the two agree on what counts as a scheme:
  // anything it would pass through verbatim is what this has to judge.
  const match = /^[a-z][a-z0-9+.-]*:/i.exec(trimmed);
  return match ? match[0].toLowerCase() : "";
}

/**
 * True when an assistant-driven navigation to `input` is allowed.
 *
 * Bare words and bare hosts are allowed because `normalizeUrl` turns them into an https URL
 * or a web search — they can never reach another scheme. Of the real schemes only http(s),
 * `about:blank`, and `data:` pass; `file:`, `javascript:`, `chrome:` and friends do not.
 */
export function isAssistantNavigable(input: string): boolean {
  const trimmed = (input ?? "").trim();
  // Empty means "the home page", which the hub supplies.
  if (!trimmed) return true;
  const scheme = schemeOf(trimmed);
  // No scheme: normalizeUrl makes it `https://…` or a Google search.
  if (!scheme) return true;
  if (scheme === "http:" || scheme === "https:") return true;
  if (scheme === "data:") return true;
  // `about:` is only useful as a blank page; `about:config`-style pages are not ours to open.
  if (scheme === "about:") return /^about:blank(?:[?#].*)?$/i.test(trimmed);
  return false;
}
