# Research Agent

An autonomous AI research assistant that decomposes a question, searches the web, reads and cross-references sources, and streams a structured report live — while you watch it think.

**Live demo**: [esaheki.com/research](https://esaheki.com/research)

---

## What makes this interesting

Most AI demos either block until done or fake streaming with pre-generated text. This one shows the actual work — sub-query decomposition, source selection reasoning, key-point extraction, and Claude's extended thinking tokens — all arriving in real-time via WebSocket as the pipeline executes.

A few deliberate architectural choices worth calling out:

**Lambda Durable Functions for orchestration.** The multi-step pipeline (decompose → search → fetch → extract × 8 → synthesize → persist) runs inside a single durable Lambda orchestrator using `@aws/durable-execution-sdk-js` (AWS re:Invent 2025). The runtime checkpoints after every `ctx.invoke()` and `ctx.step()` call, so if the orchestrator is interrupted at any point, it replays from the last checkpoint rather than starting over. No separate workflow service, no SQS polling loop — just a function that can be paused and resumed.

**DynamoDB Streams as the event bus.** Rather than having activity Lambdas write directly to the WebSocket, every event (search started, page fetched, thinking token, report chunk) is appended to a `ResearchEvents` table. A DynamoDB Streams trigger picks up new items and fans them out to the connected WebSocket client. This means the event log is the source of truth: a reconnecting browser can replay all events and reconstruct exactly where the pipeline is.

**Tiered Claude usage.** Fast, cheap Haiku 4.5 handles the high-frequency steps (decompose query → 3-5 sub-queries, rank ~30 URLs → top 8, extract key points from each page). Sonnet 4.6 with extended thinking (`budget_tokens: 8000`) handles synthesis once — the step where reasoning quality matters most. Total per-session cost: ~$0.10–0.25.

**Split-pane live UI.** The left pane surfaces each pipeline step as it happens, with collapsible "View reasoning" sections that stream Claude's raw thinking tokens. The right pane assembles the final report markdown incrementally. Both update from the same WebSocket event stream.

---

## Tech stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18, Vite, TypeScript |
| Auth | Cognito Hosted UI, Google OAuth, PKCE |
| HTTP API | API Gateway HTTP API, Cognito JWT authorizer |
| WebSocket | API Gateway WebSocket API, Lambda authorizer |
| Orchestration | Lambda Durable Functions (`@aws/durable-execution-sdk-js`) |
| AI pipeline | Claude Haiku 4.5 × 3 steps, Claude Sonnet 4.6 + extended thinking |
| Web search | Tavily (advanced depth, 3-5 queries/session) |
| Page extraction | Jina Reader (`r.jina.ai`) |
| Event streaming | DynamoDB Streams → Lambda → WebSocket |
| Storage | DynamoDB (sessions, events, connections), S3 (reports + source texts) |
| Infrastructure | AWS CDK (TypeScript), 3 stacks |
| CI/CD | GitHub Actions, OIDC-assumed IAM role (no stored credentials) |
| Runtime | Node.js 22, ARM64 (Graviton) |
| Hosting | S3 + CloudFront (injected as a `/research/*` behavior into an existing distribution) |

---

## Architecture

```
Browser (React + Vite)
  │
  ├── HTTPS ──────────────────────────► API Gateway HTTP API
  │                                          │
  │                                     startResearch Lambda
  │                                          │
  │                                     researchOrchestrator (Durable)
  │                                          │
  │                                     ┌────▼────────────────────────┐
  │                                     │  ctx.invoke('decomposeQuery') │  Claude Haiku 4.5
  │                                     │  ctx.invoke('tavilySearch-N') │  Tavily API × N
  │                                     │  ctx.invoke('rankUrls')       │  Claude Haiku 4.5
  │                                     │  ctx.invoke('fetchPage-N')    │  Jina Reader × 8
  │                                     │  ctx.invoke('extractKeyPoints')│ Claude Haiku 4.5 × 8
  │                                     │  ctx.invoke('synthesizeReport')│ Claude Sonnet 4.6 + thinking
  │                                     │  ctx.invoke('persistReport')  │  S3 + DynamoDB
  │                                     └────┬────────────────────────┘
  │                                          │ emits events via ctx.step()
  │                                          ▼
  │                                     ResearchEvents (DynamoDB)
  │                                          │
  │                                     DynamoDB Streams
  │                                          │
  │                                     eventBroadcaster Lambda
  │                                          │
  └── WebSocket ◄──────────────────────── API Gateway WebSocket API
```

Each pipeline step first checkpoints a `DECOMPOSING` / `SEARCHING` / etc. event to DynamoDB (inside a `ctx.step()`), then runs the activity Lambda (inside a `ctx.invoke()`). Both writes are checkpointed, so neither repeats if the orchestrator replays after an interruption.

---

## Pipeline detail

| Step | Model / Service | Output |
|------|----------------|--------|
| Decompose | Claude Haiku 4.5 | 3–5 diverse sub-queries |
| Search × N | Tavily (advanced) | ~30 ranked results |
| Rank & dedup | Claude Haiku 4.5 | Top 8 unique URLs |
| Fetch × 8 | Jina Reader | Clean markdown per page |
| Extract × 8 | Claude Haiku 4.5 | Key points + conflict flag |
| Synthesize | Claude Sonnet 4.6 + thinking | Structured report markdown |
| Persist | S3 + DynamoDB | `reports/{userId}/{sessionId}/` |

The synthesis step uses `thinking: { type: 'enabled', budget_tokens: 8000 }`. Thinking tokens arrive as `THINKING_CHUNK` events and stream directly to the UI's "View reasoning" panel.

Report structure: Executive Summary → Key Findings → Detailed Analysis → Conflicting Views (rendered only when sources disagree). All citations are inline hyperlinks.

---

## Auth & access control

Sign-in is Google OAuth via Cognito Hosted UI (Authorization Code + PKCE). New users are gated: the `PreTokenGeneration` trigger writes a `pending` record to `UserApprovals` and sends an admin notification before rejecting the sign-in. The app is invite-only — no token is issued until an admin approves.

> **Note**: Cognito's `PostAuthentication` trigger does not fire for Hosted UI + federated Google sign-ins. All registration and approval logic lives in `PreTokenGeneration`, the only trigger that fires reliably for every sign-in path.

---

## Infrastructure

Three CDK stacks, all TypeScript:

- **StorageStack** — DynamoDB tables (Sessions, ResearchEvents, WebSocketConnections, UserApprovals), private S3 bucket, SSM SecureString parameters
- **ComputeStack** — all Lambda functions, Durable orchestrator construct, HTTP API + WebSocket API, Cognito User Pool + triggers
- **FrontendStack** — adds a `/research/*` cache behavior and S3 origin to the _existing_ `esaheki.com` CloudFront distribution via the L1 `CfnDistribution` escape hatch. No new distribution; the root `/*` behavior is never touched.

Lambda configs: Node.js 22, ARM64. `synthesizeReport` is allocated 3008 MB and a 10-minute invocation timeout (extended thinking is slow). The orchestrator itself has a 30-second invocation timeout — the durable runtime suspends between `ctx.invoke()` calls, so no compute is billed while waiting on activity results.

---

## Setup

### 1. Store secrets in SSM

```bash
aws ssm put-parameter --name /research-agent/tavily-api-key       --type SecureString --value <key>
aws ssm put-parameter --name /research-agent/anthropic-api-key    --type SecureString --value <key>
aws ssm put-parameter --name /research-agent/google-client-id     --type String       --value <id>
aws ssm put-parameter --name /research-agent/google-client-secret --type SecureString --value <secret>
aws ssm put-parameter --name /research-agent/admin-email          --type String       --value <your-email>
aws ssm put-parameter --name /research-agent/existing-cloudfront-distribution-id --type String --value <id>
```

### 2. Deploy

```bash
cd infra && npm ci && npx cdk deploy --all
```

### 3. Deploy the frontend

```bash
cd frontend && npm ci && npm run build
aws s3 sync dist/ s3://<frontend-bucket>/ --delete
aws cloudfront create-invalidation --distribution-id <id> --paths "/research/*"
```

CDK outputs include the bucket name and distribution ID.

---

## Local development

```bash
# Frontend
cd frontend && npm ci && npm run dev    # http://localhost:5173

# Backend
cd backend && npm ci && npm run build && npm run test
```

Copy `frontend/.env.example` to `frontend/.env.local` and fill in your deployed API Gateway and Cognito values. The orchestrator requires a deployed environment with `durableConfig` enabled; integration tests can use `LocalDurableTestRunner` from `@aws/durable-execution-sdk-js-testing`.

---

## CI/CD

Push to `main` → GitHub Actions: CDK deploy → Vite build → S3 sync → CloudFront invalidation. The workflow assumes an IAM role via OIDC — no AWS credentials stored in GitHub secrets.

---

## Cost

Each research session costs roughly **$0.10–0.25**:

| Service | Per session |
|---------|------------|
| Tavily (3-5 searches) | ~$0.04 |
| Jina Reader | Free tier |
| Claude Haiku 4.5 (decompose, rank, extract × 8) | ~$0.01 |
| Claude Sonnet 4.6 + extended thinking (synthesis) | ~$0.05–0.15 |
