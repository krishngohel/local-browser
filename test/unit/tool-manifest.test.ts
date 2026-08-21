import { test } from "node:test";
import assert from "node:assert/strict";
import { TOOL_MANIFEST } from "../../src/shared/tool-manifest";
import { TOOL_GROUP_COUNTS } from "../../src/main/transfer-prefs";

test("manifest counts per group match TOOL_GROUP_COUNTS (evaluate excluded)", () => {
  const counts: Record<string, number> = {};
  for (const t of TOOL_MANIFEST) if (t.name !== "evaluate") counts[t.group] = (counts[t.group] ?? 0) + 1;
  for (const [group, n] of Object.entries(TOOL_GROUP_COUNTS)) assert.equal(counts[group], n, group);
  assert.equal(new Set(TOOL_MANIFEST.map((t) => t.name)).size, TOOL_MANIFEST.length, "unique names");
});
