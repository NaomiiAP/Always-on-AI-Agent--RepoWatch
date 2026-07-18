import assert from "node:assert/strict";
import test from "node:test";

import { formatComment, parseDecision } from "./index.mjs";

const validDecision = {
  severity: "high",
  reason: "Authentication is unavailable to all users.",
  complexity: "medium",
  assignee_area: "backend",
  is_good_first_issue: false,
  summary: "Login requests fail after the latest deployment.",
  implementation_plan: "1. Reproduce the failure\n2. Inspect auth logs\n3. Add a regression test",
};

test("parseDecision strips text surrounding valid JSON", () => {
  const response = `Here is the result:\n${JSON.stringify(validDecision)}\nDone.`;
  assert.deepEqual(parseDecision(response), validDecision);
});

test("parseDecision rejects malformed or out-of-schema output", () => {
  assert.throws(() => parseDecision("not json"), /did not contain/);
  assert.throws(
    () => parseDecision(JSON.stringify({ ...validDecision, severity: "critical" })),
    /required schema/,
  );
});

test("formatComment renders the marker and mapped severity emoji", () => {
  const comment = formatComment(validDecision);

  assert.ok(comment.startsWith("🤖 **Auto-triage**"));
  assert.match(comment, /\*\*Severity:\*\* 🔴 high/);
  assert.match(comment, /\*\*Suggested Area:\*\* backend/);
  assert.match(comment, /1\. Reproduce the failure/);
});
