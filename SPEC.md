# Research Agent — Product & Technical Specification

**URL**: esaheki.com/research  
**Type**: Portfolio project — autonomous AI research assistant

---

## Overview

A web app where authenticated users submit a research question and an AI agent autonomously searches the web, reads sources, reasons step-by-step using Claude's extended thinking, and produces a structured report — all streamed live in a split-pane UI.

---

## Architecture Summary

```
Browser (React + Vite)
  ↕ WebSocket (API Gateway WebSocket API)
  ↕ HTTPS (API Gateway HTTP API)
     ↓
Lambda Functions (CDK TypeScript)
  - POST /research    → starts Durable orchestrator
  - WebSocket handler → push events to connected client
  - Q&A endpoint      → post-report chat
     ↓
Lambda Durable Functions (orchestrator)
  Steps:
    1. Query decomposition (Claude Haiku 4.5)
    2-N. Tavily search per sub-query
    N+1. URL ranking + dedup (Claude Haiku 4.5)
    N+2..N+9. Page fetch per URL (Jina Reader r.jina.ai)
    N+10..N+17. Key-point extraction per page (Claude Haiku 4.5)
    N+18. Synthesis + report generation (Claude Sonnet 4.6 + extended thinking)
    N+19. Store report + source texts to S3
     ↓
DynamoDB (session state + event log)
  → DynamoDB Streams → Lambda → API Gateway WebSocket → Browser
     ↓
S3 (report markdown + raw source texts, private)
  → CloudFront (Cognito-authenticated, OAC)
     ↓
Cognito User Pool (Google OAuth IdP)
```

---

## Frontend (React + Vite → S3 + CloudFront)

### Pages
- `/research` — main interface (requires auth)
- `/research/history` — list of past sessions (DynamoDB query by userId)
- `/research/session/:id` — view a completed report

### Main Interface: Split-Pane Layout

**Left pane — Live action + thinking stream:**
- Structured event cards appear as the agent works:
  - "Decomposing question…"
  - "Searching Tavily for [sub-query]…"
  - "Reading [domain]…"
  - "Extracting insights from [domain]…"
  - "Synthesizing report…"
- Each card has a collapsible "View reasoning" section that streams Claude's extended thinking tokens as monospace text

**Right pane — Report materializing in real-time:**
- Markdown rendered as sections stream in
- Final report structure: Executive Summary → Key Findings → Detailed Analysis → Conflicting Views
- Inline hyperlinks for all citations (no separate bibliography section)
- `[CONFLICT]` markers rendered as highlighted callout blocks

### Auth Flow
- Cognito Hosted UI with Google OAuth (Authorization Code + PKCE)
- ID token stored in memory; refresh token in httpOnly cookie
- All API calls: `Authorization: Bearer <id_token>`
- WebSocket `$connect`: token passed in query string, validated by Lambda authorizer

### Session Enforcement
- One active research session per user at a time
- If user submits a new question while a session is running → "Cancel current research?" modal
- Active session state: DynamoDB `Sessions.status = 'running'`

---

## Backend Lambda Functions (CDK TypeScript)

### API Gateway HTTP API
Cognito JWT authorizer on all routes.

| Method | Route | Handler | Description |
|--------|-------|---------|-------------|
| POST | /research | `startResearch` | Validates request, starts Durable orchestrator, returns `sessionId` |
| DELETE | /research/:id | `cancelResearch` | Sends cancel signal to running orchestrator |
| GET | /research/history | `listSessions` | Returns last 20 sessions for the authenticated user |
| GET | /research/:id | `getSession` | Returns session metadata; if complete, returns report from S3 |
| POST | /research/:id/chat | `chatWithReport` | Post-report Q&A (SSE streaming response) |

### API Gateway WebSocket API
Custom Lambda authorizer on `$connect` validates Cognito token.

| Route | Handler | Description |
|-------|---------|-------------|
| $connect | `wsConnect` | Stores `connectionId → sessionId` mapping in DynamoDB |
| $disconnect | `wsDisconnect` | Removes connectionId from DynamoDB |

### Event Broadcaster
DynamoDB Streams on `ResearchEvents` table → `eventBroadcaster` Lambda → `ApiGatewayManagementApi.postToConnection` → browser.

---

## Lambda Durable Orchestrator

Uses the official AWS Lambda Durable Functions SDK (`@aws/durable-execution-sdk-js`, announced re:Invent 2025). The orchestrator Lambda has `durableConfig` enabled with a 10-minute execution timeout, is invoked via a `live` alias (required for durable functions), and carries the `AWSLambdaBasicDurableExecutionRolePolicy` for checkpoint permissions.

The durable runtime checkpoints after every `ctx.invoke()` and `ctx.step()` call. If the orchestrator Lambda is interrupted, the runtime replays from the last checkpoint — no step is re-executed.

### Orchestrator: `researchOrchestrator`

```typescript
export const handler = withDurableExecution(async (event: OrchestratorInput, ctx: DurableContext) => {
  // Step 1: Decompose into 3-5 diverse sub-queries
  // emitEvent (a DynamoDB write) is wrapped in ctx.step() so it is checkpointed
  // and not re-executed on replay when the orchestrator resumes after each invoke.
  await ctx.step('emit-decomposing', async () => {
    await emitEvent(ddb, EVENTS_TABLE, sessionId, 'DECOMPOSING', { question })
  })
  const subQueries = await ctx.invoke('decomposeQuery', ACTIVITY.decomposeQuery, { question })

  // Steps 2..N: Search each sub-query via Tavily
  const searchResults = []
  for (let i = 0; i < subQueries.length; i++) {
    await ctx.step(`emit-searching-${i}`, async () => {
      await emitEvent(ddb, EVENTS_TABLE, sessionId, 'SEARCHING', { query: subQueries[i], queryIndex: i })
    })
    const results = await ctx.invoke(`tavilySearch-${i}`, ACTIVITY.tavilySearch, { query: subQueries[i] })
    searchResults.push(...results)
  }

  // Step N+1: LLM-rank and deduplicate, select top 8 URLs
  await ctx.step('emit-ranking', () => emitEvent(...'RANKING_SOURCES'...))
  const rankedUrls = await ctx.invoke('rankUrls', ACTIVITY.rankUrls, { question, searchResults })

  // Steps N+2..N+17: fetch + extract (same pattern — step then invoke per URL)
  // ...

  // Step N+18: Full synthesis with extended thinking (Claude Sonnet 4.6)
  await ctx.step('emit-synthesizing', () => emitEvent(...'SYNTHESIZING'...))
  const { report } = await ctx.invoke('synthesizeReport', ACTIVITY.synthesizeReport, { sessionId, question, extractions })

  // Step N+19: Persist to S3 + update DynamoDB
  await ctx.invoke('persistReport', ACTIVITY.persistReport, { sessionId, userId, report, sources: pageContents })

  await ctx.step('emit-complete', () => emitEvent(...'COMPLETE'...))
})
```

### Replay Safety Rule
Any side effect that must not repeat on replay (DynamoDB writes, SNS publishes, etc.) must be inside a `ctx.step()`. `ctx.invoke()` results are also checkpointed — activity Lambdas are never re-invoked if the orchestrator resumes from a checkpoint past that call.

### Hard Caps
- Max sources fetched: 8 URLs
- Max durable execution timeout: 10 minutes (`durableConfig.executionTimeout`)
- Per-invocation Lambda timeout: 30 s (the durable runtime suspends between `ctx.invoke()` calls; no compute is billed while waiting)

---

## Activity Functions

**`decomposeQuery`** — Claude Haiku 4.5  
Input: question → Output: 3-5 diverse, non-redundant sub-query strings

**`tavilySearch`** — Tavily API  
Input: query → Output: `{ url, title, snippet, score }[]`  
Config: `search_depth: "advanced"`, `max_results: 10`

**`rankUrls`** — Claude Haiku 4.5  
Input: question + all search results → Output: ordered list of top 8 unique URLs  
Deduplication (same URL from multiple sub-queries) happens here

**`fetchPage`** — HTTP GET `https://r.jina.ai/{url}`  
Input: URL → Output: clean markdown of the page  
Timeout: 15s; fallback on 4xx/5xx: `{ error: 'inaccessible', url }`

**`extractKeyPoints`** — Claude Haiku 4.5  
Input: question + url + page content (truncated to 8K tokens)  
Output: `{ url, keyPoints: string[], relevance: number, conflictsFound: boolean }`

**`synthesizeReport`** — Claude Sonnet 4.6 + extended thinking  
Config: `thinking: { type: 'enabled', budget_tokens: 8000 }`  
Thinking tokens written to `ResearchEvents` table in real-time as `THINKING_CHUNK` events  
Output: structured markdown:
1. Executive Summary (2-3 sentences)
2. Key Findings (bullet list)
3. Detailed Analysis (themed subsections, inline hyperlinks)
4. Conflicting Views (rendered only if `conflictsFound === true` in any extraction)

Conflicts are marked as `[CONFLICT]` inline; frontend renders these as highlighted callout blocks.

**`persistReport`** — S3 + DynamoDB  
S3 keys:
- `reports/{userId}/{sessionId}/report.md`
- `reports/{userId}/{sessionId}/sources/{i}.txt` (raw Jina output, used for Q&A context)

DynamoDB: updates `Sessions` item — `status = 'complete'`, `reportKey`, `completedAt`

---

## Event Schema

All events appended to `ResearchEvents` table: `{ sessionId (PK), eventId (SK), type, payload, timestamp }`

```typescript
type ResearchEvent =
  | { type: 'DECOMPOSING';     payload: { question: string } }
  | { type: 'SEARCHING';       payload: { query: string; queryIndex: number } }
  | { type: 'RANKING_SOURCES'; payload: {} }
  | { type: 'FETCHING_PAGE';   payload: { url: string; domain: string; pageIndex: number } }
  | { type: 'EXTRACTING';      payload: { url: string; pageIndex: number } }
  | { type: 'SYNTHESIZING';    payload: {} }
  | { type: 'THINKING_CHUNK';  payload: { text: string } }
  | { type: 'REPORT_CHUNK';    payload: { markdown: string } }
  | { type: 'COMPLETE';        payload: { sessionId: string } }
  | { type: 'PARTIAL_COMPLETE';payload: { sessionId: string; failedSteps: string[] } }
  | { type: 'ERROR';           payload: { step: string; message: string } }
```

---

## DynamoDB Tables

**`Sessions`**
- PK: `sessionId` (UUID)
- Attributes: `userId`, `question`, `status` (`pending | running | complete | partial-complete | failed | cancelled`), `startedAt`, `completedAt`, `reportKey`, `subQueries`, `fetchedUrls`
- GSI: `userId-startedAt-index` (history page: query by userId, sort by time)

**`ResearchEvents`** (append-only)
- PK: `sessionId`, SK: `eventId` (timestamp + random suffix)
- TTL: 30 days
- DynamoDB Streams: NEW_IMAGE only → `eventBroadcaster` Lambda

**`WebSocketConnections`**
- PK: `connectionId`
- Attributes: `sessionId`, `userId`, `connectedAt`
- TTL: 2 hours

---

## Post-Report Q&A

**POST /research/:id/chat** (SSE streaming response):
1. Verify session belongs to authenticated user
2. Load from S3: `report.md` + all `sources/*.txt`
3. Call Claude Sonnet 4.6 with full context:
   ```
   System: Answer using only the provided research report and source texts.
   [full report markdown]
   [source texts, labeled by URL]
   ```
4. Stream response via Lambda function URL or API Gateway SSE

No durable functions — simple Lambda streaming invocation.

---

## Auth & Security

- **Cognito User Pool** with Google as federated OIDC IdP
- **App Client**: SPA (no client secret), Authorization Code + PKCE
- **HTTP API**: Cognito JWT authorizer; `userId` injected into Lambda context
- **WebSocket $connect**: Custom Lambda authorizer validates Cognito ID token
- **S3 reports**: Private bucket; served via CloudFront with OAC (Origin Access Control)
- **Scopes**: `openid email profile`

### User Approval Flow

New users cannot use the app until an admin manually approves them.

**Registration + approval gate — both handled by `PreTokenGeneration`:**

> **Note**: Cognito's `PostAuthentication` trigger does **not** fire for Hosted UI + Google federated sign-ins. All sign-in logic lives in a single `PreTokenGeneration` trigger (`cognitoPreTokenGen`).

1. User signs in with Google — Cognito fires the `PreTokenGeneration` trigger before issuing any token
2. Lambda queries `UserApprovals` for the user's Cognito `sub` (UUID)
3. **First-time user** (no record found): Lambda writes `{ userId (sub), email, name, status: 'pending', registeredAt }` to `UserApprovals` (conditional put — idempotent on replay), then publishes to `NewUserRegistrationTopic` → admin email with approval link. Throws `USER_PENDING_APPROVAL` — Cognito rejects the sign-in.
4. **Returning pending user**: throws `USER_PENDING_APPROVAL` — same rejection.
5. **Approved user**: no-op — token issuance proceeds normally.

The `userId` key in `UserApprovals` is always the Cognito `sub` (a UUID), **not** the federated username (`Google_<id>`).

**Admin approval endpoint:**

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| GET | /admin/users | IAM (admin only) | List all users with their approval status |
| PATCH | /admin/users/:userId/approve | IAM (admin only) | Set `status = 'approved'`; updates `approvedAt` |
| PATCH | /admin/users/:userId/reject | IAM (admin only) | Set `status = 'rejected'` |

Admin routes are on a separate API Gateway HTTP API stage secured by **IAM auth** (not Cognito) — invoked via `aws apigateway` CLI or AWS Console. No admin UI needed; the approval email contains a pre-signed API URL the admin can `curl`.

**`UserApprovals`** DynamoDB table:
- PK: `userId` (Cognito sub)
- Attributes: `email`, `name`, `status` (`pending | approved | rejected`), `registeredAt`, `approvedAt`
- GSI: `status-registeredAt-index` (admin list endpoint: query by status, sorted by registration time)

---

## Infrastructure (AWS CDK TypeScript)

### Stacks
1. `ResearchAgentStorageStack` — DynamoDB tables, private versioned S3 bucket (app assets + reports), SSM SecureString parameters
2. `ResearchAgentComputeStack` — All Lambda functions, Durable orchestrator construct, API Gateway (HTTP + WebSocket), Cognito User Pool
3. `ResearchAgentFrontendStack` — adds a `/research/*` origin + cache behavior to the **existing** `esaheki.com` CloudFront distribution; no new distribution is created

> **Note on existing infrastructure**: `esaheki.com` is already served by an S3 + CloudFront setup. The research agent must not touch the existing origin or root behavior. The existing distribution ID is stored in SSM (`/research-agent/existing-cloudfront-distribution-id`) and imported in CDK via `Distribution.fromDistributionAttributes()`. New behaviors are added using the L1 `CfnDistribution` escape hatch.

### Secrets (SSM Parameter Store)
- `/research-agent/tavily-api-key` (SecureString)
- `/research-agent/anthropic-api-key` (SecureString)
- `/research-agent/google-client-id`
- `/research-agent/google-client-secret` (SecureString)
- `/research-agent/admin-email` — receives new-user notification emails and pre-signed approval links
- `/research-agent/existing-cloudfront-distribution-id` — ID of the existing `esaheki.com` distribution; used by `ResearchAgentFrontendStack` to import and extend it

### Lambda Runtime Configs
All functions: Node.js 22, ARM64 (Graviton)

| Function | Memory | Invocation timeout | Notes |
|----------|--------|--------------------|-------|
| `synthesizeReport` | 3008 MB | 10 min | Extended thinking; single synchronous invocation |
| `fetchPage` | 512 MB | 30 s | |
| `researchOrchestrator` | 512 MB | 30 s | Durable execution timeout: 10 min. Per-invocation timeout is short because the durable runtime suspends between `ctx.invoke()` calls — no compute billed while waiting. |
| All others | 512 MB | 30 s | |

---

## Observability

- **X-Ray tracing** on all Lambda functions and API Gateway stages
- **Structured JSON logging** from all Lambdas: `{ sessionId, userId, step, durationMs, ... }`
- **CloudWatch Dashboard** (`ResearchAgentDashboard`):
  - Active research sessions (Sessions where status=running)
  - Research completion rate (complete / complete+failed)
  - Average research duration (p50, p95)
  - Error rate by Lambda function
  - Estimated token cost per session (from Claude API usage metadata)

---

## CI/CD (GitHub Actions)

Triggered on push to `main`:

1. `npm ci` in `/infra`
2. `npx cdk deploy --all` — OIDC-assumed IAM role (no long-lived AWS credentials stored in GitHub)
3. `npm run build` in `/frontend`
4. `aws s3 sync dist/ s3://{frontendBucket}/ --delete`
5. `aws cloudfront create-invalidation --distribution-id {existingDistributionId} --paths "/research/*"`

---

## Project Structure

```
research-agent/
├── infra/                         # CDK app (TypeScript)
│   ├── bin/app.ts
│   ├── lib/
│   │   ├── stacks/
│   │   └── constructs/
│   └── package.json
├── backend/                       # Lambda source (TypeScript)
│   ├── src/
│   │   ├── orchestrator/
│   │   │   └── researchOrchestrator.ts
│   │   ├── activities/
│   │   │   ├── decomposeQuery.ts
│   │   │   ├── tavilySearch.ts
│   │   │   ├── rankUrls.ts
│   │   │   ├── fetchPage.ts
│   │   │   ├── extractKeyPoints.ts
│   │   │   ├── synthesizeReport.ts
│   │   │   └── persistReport.ts
│   │   ├── cognito/
│   │   │   ├── cognitoPostAuth.ts      # registers new users as 'pending', sends SNS notification
│   │   │   └── cognitoPreTokenGen.ts   # blocks token issuance for non-approved users
│   │   ├── api/
│   │   │   ├── startResearch.ts
│   │   │   ├── cancelResearch.ts
│   │   │   ├── listSessions.ts
│   │   │   ├── getSession.ts
│   │   │   └── chatWithReport.ts
│   │   ├── admin/
│   │   │   ├── listUsers.ts
│   │   │   └── updateUserStatus.ts
│   │   └── ws/
│   │       ├── wsConnect.ts
│   │       ├── wsDisconnect.ts
│   │       └── eventBroadcaster.ts
│   └── package.json
├── frontend/                      # React + Vite (TypeScript)
│   ├── src/
│   │   ├── pages/
│   │   ├── components/
│   │   │   ├── SplitPane/
│   │   │   ├── EventStream/
│   │   │   └── ReportViewer/
│   │   ├── hooks/
│   │   │   ├── useWebSocket.ts
│   │   │   └── useResearch.ts
│   │   └── lib/
│   │       └── cognito.ts
│   └── package.json
└── SPEC.md
```

---

## External APIs & Estimated Cost

| Service | Purpose | Cost |
|---------|---------|------|
| Tavily API | Web search | ~$0.04/session (3-5 searches @ $0.01 each) |
| Jina Reader (r.jina.ai) | URL → clean markdown | Free tier: 1M tokens/month |
| Anthropic API — Haiku 4.5 | Decomposition, ranking, extraction | ~$0.01/session |
| Anthropic API — Sonnet 4.6 + thinking | Report synthesis | ~$0.05–0.15/session |

**Estimated total per research session: ~$0.10–0.25**

---

## Out of Scope (MVP)

- Public report sharing / permalink (reports are always private to the owner)
- Per-user monthly quota (per-session hard cap is sufficient for now)
- Email notification on research completion
- Report PDF export
- Concurrent research sessions (one active session per user)
