import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { GROUP_LABELS, TOOL_MANIFEST, type ToolGroup } from "../../src/shared/tool-manifest";

/** Walks up from the bundled test file until it finds the repo root (the one with package.json). */
function repoRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error(`Could not find the repo root from ${__dirname}`);
}

const DOC = path.join(repoRoot(), "skills", "ECHO-SKILL-TREE.md");

/** Rows of the "Every tool" table in section 6, as { name, description }. */
function section6Rows(): { name: string; description: string }[] {
  const doc = fs.readFileSync(DOC, "utf8");
  const start = doc.indexOf("\n## 6.");
  assert.notEqual(start, -1, "skill tree has no section 6");
  const rest = doc.slice(start + 1);
  const end = rest.indexOf("\n## ");
  const section = end === -1 ? rest : rest.slice(0, end);

  const rows: { name: string; description: string }[] = [];
  for (const line of section.split("\n")) {
    const match = /^\|\s*`([a-z_]+)`\s*\|\s*(.*?)\s*\|$/.exec(line.trim());
    if (match) rows.push({ name: match[1], description: match[2] });
  }
  return rows;
}

test("skill tree section 6 lists every tool exactly once", () => {
  const rows = section6Rows();
  assert.equal(rows.length, TOOL_MANIFEST.length, "row count");

  const seen = new Set<string>();
  for (const row of rows) {
    assert.equal(seen.has(row.name), false, `${row.name} is listed twice`);
    seen.add(row.name);
  }
  for (const entry of TOOL_MANIFEST) {
    assert.equal(seen.has(entry.name), true, `${entry.name} is missing from the skill tree`);
  }
});

test("skill tree section 6 quotes each tool description verbatim", () => {
  const byName = new Map(section6Rows().map((row) => [row.name, row.description]));
  for (const entry of TOOL_MANIFEST) {
    // The generator escapes pipes so they do not break the markdown table.
    const expected = entry.description.replace(/\|/g, "\|");
    assert.equal(byName.get(entry.name), expected, `${entry.name} description drifted`);
  }
});

test("skill tree section 6 heads each group with its label and count", () => {
  const doc = fs.readFileSync(DOC, "utf8");
  const groups = new Set(TOOL_MANIFEST.map((entry) => entry.group));
  for (const group of groups) {
    const n = TOOL_MANIFEST.filter((entry) => entry.group === group).length;
    const heading = `### ${GROUP_LABELS[group as ToolGroup]} (${n})`;
    assert.equal(doc.includes(heading), true, `missing heading: ${heading}`);
  }
});
