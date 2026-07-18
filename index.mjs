import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";

const AUTO_TRIAGE_PREFIX = "🤖 Auto-triage";
const DEFAULT_MODEL_ID = "amazon.nova-lite-v1:0";
const GITHUB_API_BASE = "https://api.github.com";
const VALID_SEVERITIES = new Set(["low", "medium", "high"]);
const VALID_COMPLEXITIES = new Set(["small", "medium", "large"]);
const VALID_AREAS = new Set(["frontend", "backend", "docs", "testing"]);

const bedrock = new BedrockRuntimeClient({});

/**
 * Make an authenticated GitHub API request and turn non-2xx responses into
 * useful errors that include GitHub's response message.
 */
async function githubRequest(path, token, options = {}) {
  const response = await fetch(`${GITHUB_API_BASE}${path}`, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "repowatch-lambda",
      ...options.headers,
    },
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(
      `GitHub ${options.method ?? "GET"} ${path} failed (${response.status}): ${details}`,
    );
  }

  return response.status === 204 ? null : response.json();
}

/**
 * Follow GitHub pagination until every page has been read. The explicit page
 * loop avoids silently ignoring repositories with more than 100 open issues
 * or issues with more than 100 comments.
 */
async function githubGetAll(path, token) {
  const separator = path.includes("?") ? "&" : "?";
  const results = [];

  for (let page = 1; ; page += 1) {
    const pageResults = await githubRequest(
      `${path}${separator}per_page=100&page=${page}`,
      token,
    );
    results.push(...pageResults);

    if (pageResults.length < 100) {
      return results;
    }
  }
}

function requiredConfig() {
  const config = {
    token: process.env.GITHUB_TOKEN,
    owner: process.env.GITHUB_OWNER,
    repo: process.env.GITHUB_REPO,
    modelId: process.env.BEDROCK_MODEL_ID || DEFAULT_MODEL_ID,
  };

  const missing = [
    ["GITHUB_TOKEN", config.token],
    ["GITHUB_OWNER", config.owner],
    ["GITHUB_REPO", config.repo],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }

  return config;
}

/**
 * Extract the first complete-looking JSON object, even if the model adds a
 * preamble or markdown after being instructed not to.
 */
export function parseDecision(modelText) {
  const firstBrace = modelText.indexOf("{");
  const lastBrace = modelText.lastIndexOf("}");

  if (firstBrace === -1 || lastBrace <= firstBrace) {
    throw new Error("Bedrock response did not contain a JSON object");
  }

  let decision;
  try {
    decision = JSON.parse(modelText.slice(firstBrace, lastBrace + 1));
  } catch (error) {
    throw new Error(`Could not parse Bedrock decision JSON: ${error.message}`);
  }

  if (
    !VALID_SEVERITIES.has(decision.severity) ||
    !VALID_COMPLEXITIES.has(decision.complexity) ||
    !VALID_AREAS.has(decision.assignee_area) ||
    typeof decision.is_good_first_issue !== "boolean" ||
    typeof decision.reason !== "string" ||
    typeof decision.summary !== "string" ||
    typeof decision.implementation_plan !== "string"
  ) {
    throw new Error("Bedrock decision did not match the required schema");
  }

  return decision;
}

/** Ask Nova for one structured engineering triage decision. */
async function triageIssue(issue, modelId) {
  const command = new ConverseCommand({
    modelId,
    system: [
      {
        text: `You are a senior engineer triaging a GitHub issue.
Return STRICT JSON ONLY: no markdown fences, no preamble, and no trailing explanation.
The response must match this exact schema:
{
  "severity": "low" | "medium" | "high",
  "reason": "one sentence",
  "complexity": "small" | "medium" | "large",
  "assignee_area": "frontend" | "backend" | "docs" | "testing",
  "is_good_first_issue": true | false,
  "summary": "one or two sentences",
  "implementation_plan": "2-3 short numbered steps as a single string"
}`,
      },
    ],
    messages: [
      {
        role: "user",
        content: [
          {
            text: `Issue title: ${issue.title}\n\nIssue body:\n${issue.body || "(No body provided)"}`,
          },
        ],
      },
    ],
    inferenceConfig: {
      maxTokens: 800,
      temperature: 0.2,
    },
  });

  const response = await bedrock.send(command);
  const modelText = (response.output?.message?.content ?? [])
    .map((block) => block.text ?? "")
    .join("");

  return parseDecision(modelText);
}

/** Render the exact GitHub comment users see. */
export function formatComment(decision) {
  const severityEmoji = {
    low: "🟢",
    medium: "🟡",
    high: "🔴",
  };

  return `${AUTO_TRIAGE_PREFIX.replace("Auto-triage", "**Auto-triage**")}

**Severity:** ${severityEmoji[decision.severity]} ${decision.severity}
**Reason:** ${decision.reason}

**Estimated Complexity:** ${decision.complexity}
**Suggested Area:** ${decision.assignee_area}

**Summary:** ${decision.summary}

**Suggested first steps:**
${decision.implementation_plan}`;
}

function labelsFor(decision) {
  const labels = [
    `${decision.severity}-priority`,
    decision.assignee_area,
  ];

  if (decision.is_good_first_issue) {
    labels.push("good-first-issue");
  }

  return labels;
}

/**
 * Lambda entry point. It intentionally ignores the event so scheduled and
 * manual test invocations execute exactly the same workflow.
 */
export const handler = async (_event) => {
  const summary = {
    issuesChecked: 0,
    issuesProcessed: 0,
    errors: [],
  };

  let config;
  try {
    config = requiredConfig();
  } catch (error) {
    summary.errors.push({ issue: null, error: error.message });
    console.error("RepoWatch configuration error", error);
    console.log("RepoWatch run summary", JSON.stringify(summary));
    return summary;
  }

  try {
    // GitHub's issues endpoint also returns pull requests, so exclude those.
    const items = await githubGetAll(
      `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/issues?state=open&sort=created&direction=desc`,
      config.token,
    );
    const issues = items.filter((item) => !item.pull_request);
    summary.issuesChecked = issues.length;

    for (const issue of issues) {
      // Each issue is isolated so a bad model response or API failure cannot
      // prevent the remaining issues from being triaged.
      try {
        const issuePath = `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/issues/${issue.number}`;
        const comments = await githubGetAll(
          `${issuePath}/comments?sort=created&direction=desc`,
          config.token,
        );

        const alreadyProcessed = comments.some((comment) =>
          // The displayed heading uses Markdown bold markers. Removing those
          // makes the stored comment begin with the required plain marker.
          comment.body?.replaceAll("**", "").startsWith(AUTO_TRIAGE_PREFIX),
        );
        if (alreadyProcessed) {
          continue;
        }

        const decision = await triageIssue(issue, config.modelId);

        // Add the marker comment first; future runs use it as deduplication.
        await githubRequest(`${issuePath}/comments`, config.token, {
          method: "POST",
          body: JSON.stringify({ body: formatComment(decision) }),
        });

        // Preserve all current labels and add the triage labels without
        // creating duplicates.
        const existingLabels = (issue.labels ?? []).map((label) =>
          typeof label === "string" ? label : label.name,
        );
        const labels = [...new Set([...existingLabels, ...labelsFor(decision)])];
        await githubRequest(issuePath, config.token, {
          method: "PATCH",
          body: JSON.stringify({ labels }),
        });

        summary.issuesProcessed += 1;
      } catch (error) {
        const issueError = {
          issue: issue.number,
          error: error instanceof Error ? error.message : String(error),
        };
        summary.errors.push(issueError);
        console.error(`RepoWatch failed on issue #${issue.number}`, error);
      }
    }
  } catch (error) {
    summary.errors.push({
      issue: null,
      error: error instanceof Error ? error.message : String(error),
    });
    console.error("RepoWatch could not fetch repository issues", error);
  }

  console.log("RepoWatch run summary", JSON.stringify(summary));
  return summary;
};
