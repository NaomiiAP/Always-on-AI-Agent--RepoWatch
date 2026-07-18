# REPOWATCH — GitHub Issue Watcher

REPOWATCH is a Node.js 20 AWS Lambda that checks open GitHub issues, asks
Amazon Bedrock Nova to triage each new issue, posts the decision, and adds
labels. An existing auto-triage comment is the only state and deduplication
mechanism.

## Demo screenshots

The screenshots below walk through a full run: a new issue is opened, REPOWATCH
triages it with Amazon Bedrock Nova, posts a comment, and applies labels — all
on a 10-minute EventBridge schedule.

| # | What it shows | File |
| - | ------------- | ---- |
| 1 | New issue created by the repo owner (NaomiiAP) | `screenshots/01-issue-created.png` |
| 2 | REPOWATCH posts an AI triage comment as the bot account (just-googleit) | `screenshots/02-auto-triage-comment.png` |
| 3 | Severity and area labels applied automatically | `screenshots/03-labels-applied.png` |
| 4 | Lambda console test run summary (issuesChecked / issuesProcessed / errors) | `screenshots/04-lambda-console.png` |
| 5 | EventBridge schedule running every 10 minutes | `screenshots/05-eventbridge-schedule.png` |
| 6 | CloudFormation stack (REPOWATCH) in UPDATE_COMPLETE | `screenshots/06-cloudformation-stack.png` |

**1. New issue created by the repo owner (NaomiiAP)**

![New issue created by the repo owner](screenshots/01-issue-created.png)

**2. REPOWATCH posts an AI triage comment as the bot account (just-googleit)**

![REPOWATCH posts an AI triage comment as the bot account](screenshots/02-auto-triage-comment.png)

**3. Severity and area labels applied automatically**

![Severity and area labels applied automatically](screenshots/03-labels-applied.png)

**4. Lambda console test run summary (issuesChecked / issuesProcessed / errors)**

![Lambda console test run summary](screenshots/04-lambda-console.png)

**5. EventBridge schedule running every 10 minutes**

![EventBridge schedule running every 10 minutes](screenshots/05-eventbridge-schedule.png)

**6. CloudFormation stack (REPOWATCH) in UPDATE_COMPLETE**

![CloudFormation stack in UPDATE_COMPLETE](screenshots/06-cloudformation-stack.png)

## Required environment variables

- `GITHUB_TOKEN` — fine-grained GitHub personal access token
- `GITHUB_OWNER` — repository owner or organization
- `GITHUB_REPO` — repository name without the owner
- `BEDROCK_MODEL_ID` — optional; defaults to `amazon.nova-lite-v1:0`

The Lambda execution role needs CloudWatch Logs permissions (the
`AWSLambdaBasicExecutionRole` managed policy) and `bedrock:InvokeModel`.
Confirm that the selected Nova model is available in the Lambda's AWS Region.
Set the Lambda timeout to 120 seconds.

## Create the GitHub token

1. In GitHub, open **Settings → Developer settings → Personal access tokens →
   Fine-grained tokens**, then select **Generate new token**.
2. Choose the repository owner and select only the repository REPOWATCH will
   monitor.
3. Under **Repository permissions**, set **Issues** to **Read and write**.
   Leave unrelated permissions at their defaults.
4. Generate the token, copy it once, and set it as `GITHUB_TOKEN` in the
   Lambda environment variables.

For production, store the token in AWS Secrets Manager instead of a plain
environment variable. This implementation uses environment variables as
required by the project specification.

## Create the repository labels

Create all of these under **GitHub repository → Issues → Labels** before the
first run:

- `high-priority`
- `medium-priority`
- `low-priority`
- `frontend`
- `backend`
- `docs`
- `testing`
- `good-first-issue`

## Zip and deploy through the Lambda console

From the `REPOWATCH` directory, run:

```powershell
npm install
npm run package
```

This creates `repowatch.zip` with `index.mjs`, `package.json`, and production
dependencies at the ZIP root.

1. In AWS Lambda, create a function named **REPOWATCH** with the **Node.js
   20.x** runtime and an execution role with the permissions described above.
2. Open **Code → Upload from → .zip file** and upload `repowatch.zip`.
3. Set the handler to `index.handler` under **Runtime settings**.
4. Add the environment variables above under **Configuration**.
5. Set the timeout to two minutes under **General configuration**.
6. Use an empty JSON object (`{}`) for a manual console test.
7. Create the 10-minute EventBridge Scheduler separately and select this
   Lambda as its target.

The test result and CloudWatch log contain `issuesChecked`,
`issuesProcessed`, and per-issue `errors`.

## Optional deployment with AWS SAM CLI

The included `template.yaml` creates the same Lambda and IAM permissions:

```powershell
npm install
sam build
sam deploy --guided
```

The schedule is intentionally not included because it is configured manually.

## Local checks

```powershell
npm test
```

---

_Built for the **AWS Builder Center Always-On Agent Weekend Challenge**._
