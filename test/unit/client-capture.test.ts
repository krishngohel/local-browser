import { test } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { mcpClientKind, prefersLeanCaptures } from "../../src/main/mcp-sessions";

/** A minimal request stand-in: identify() only reads headers off it. */
function fakeReq(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

test("Claude Desktop keeps the full-detail capture; every other client goes lean", () => {
  assert.equal(prefersLeanCaptures("claude"), false);
  assert.equal(prefersLeanCaptures("chatgpt"), true);
  assert.equal(prefersLeanCaptures("cursor"), true);
  assert.equal(prefersLeanCaptures("other"), true);
});

test("mcpClientKind reads the X-Echo-Client tag the connect configs write", () => {
  assert.equal(mcpClientKind(fakeReq({ "x-echo-client": "claude" })), "claude");
  assert.equal(mcpClientKind(fakeReq({ "x-echo-client": "chatgpt" })), "chatgpt");
  assert.equal(mcpClientKind(fakeReq({ "x-echo-client": "cursor" })), "cursor");
  // No tag, no recognizable UA -> unknown client, which still gets the lean path.
  assert.equal(mcpClientKind(fakeReq({ "user-agent": "node" })), "other");
});

test("the tag and the MCP initialize name both route Claude to the full path", () => {
  // Tag missing but the MCP client announces itself as Claude.
  assert.equal(mcpClientKind(fakeReq({}), { name: "claude-ai", version: "1.0" }), "claude");
  // A ChatGPT/Codex client stays lean even when the header is absent.
  assert.equal(prefersLeanCaptures(mcpClientKind(fakeReq({ "user-agent": "openai-codex" }))), true);
  // Claude Desktop stays full-detail end to end.
  assert.equal(prefersLeanCaptures(mcpClientKind(fakeReq({ "x-echo-client": "claude" }))), false);
});
