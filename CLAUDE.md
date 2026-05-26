# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Is

Autonomous Research & Report Agent — a web app where authenticated users submit a research question and an AI agent searches the web, reads sources, reasons with Claude's extended thinking, and streams a structured report live. Hosted at esaheki.com/research. See SPEC.md for the full product and technical specification.

## Monorepo Structure

```
infra/      CDK app (TypeScript) — all AWS infrastructure
backend/    Lambda function source (TypeScript)
frontend/   React + Vite SPA (TypeScript)
```

Each package has its own `package.json`. Run commands from within the relevant directory.

## Commands

### Infrastructure (infra/)
```bash
npm run build          # compile CDK TypeScript
npm run synth          # cdk synth (validate without deploying)
npx cdk deploy --all   # deploy all stacks
npx cdk diff           # show pending changes
```

### Backend (backend/)
```bash
npm run build          # tsc compile
npm run test           # run tests
npm run test -- --testPathPattern=<file>   # run a single test file
```

### Frontend (frontend/)
```bash
npm run dev            # local dev server (Vite)
npm run build          # production build → dist/
npm run preview        # preview production build locally
npm run typecheck      # tsc --noEmit
```

## Architecture

### Request flow
1. Browser authenticates via Cognito Hosted UI (Google OAuth, PKCE)
2. User submits question → `POST /research` (HTTP API, Cognito JWT authorizer) → `startResearch` Lambda
3. `startResearch` launches a Lambda Durable Functions orchestrator and returns a `sessionId`
4. Browser opens a WebSocket to API Gateway WebSocket API using the session ID
5. Orchestrator runs its pipeline (see below); each step writes events to the `ResearchEvents` DynamoDB table
6. DynamoDB Streams triggers `eventBroadcaster` Lambda → pushes events to the browser over WebSocket
7. Browser renders events in the left pane (action cards + thinking tokens) and assembles the report in the right pane

### Lambda Durable orchestrator pipeline (`backend/src/orchestrator/researchOrchestrator.ts`)
Uses the official `@aws/durable-execution-sdk-js` SDK (`withDurableExecution` wrapper). Each `ctx.invoke()` call is a durable checkpoint — the orchestrator suspends between calls and the durable runtime resumes from the last checkpoint after any interruption. Each `emitEvent` (DynamoDB write) is wrapped in a `ctx.step()` so it is also checkpointed and not repeated on replay.

The orchestrator Lambda has `durableConfig` set (10-min execution timeout, 30-day checkpoint retention) and must be invoked via its `live` alias ARN — durable functions require a qualified ARN.

| Step | SDK call | Activity / Service |
|------|----------|--------------------|
| emit | `ctx.step('emit-decomposing')` | DynamoDB write (checkpointed) |
| 1 | `ctx.invoke('decomposeQuery')` | Claude Haiku 4.5 — produces 3-5 sub-queries |
| emit × N | `ctx.step('emit-searching-N')` | DynamoDB write |
| 2-N | `ctx.invoke('tavilySearch-N')` | Tavily API — one call per sub-query |
| emit | `ctx.step('emit-ranking')` | DynamoDB write |
| N+1 | `ctx.invoke('rankUrls')` | Claude Haiku 4.5 — deduplicates, selects top 8 URLs |
| emit × 8 | `ctx.step('emit-fetching-N')` | DynamoDB write |
| N+2..N+9 | `ctx.invoke('fetchPage-N')` | Jina Reader (r.jina.ai) — URL → clean markdown |
| emit × 8 | `ctx.step('emit-extracting-N')` | DynamoDB write |
| N+10..N+17 | `ctx.invoke('extractKeyPoints-N')` | Claude Haiku 4.5 — key points + conflict detection |
| emit | `ctx.step('emit-synthesizing')` | DynamoDB write |
| N+18 | `ctx.invoke('synthesizeReport')` | Claude Sonnet 4.6 + extended thinking |
| N+19 | `ctx.invoke('persistReport')` | S3 + DynamoDB |
| emit | `ctx.step('emit-complete')` | DynamoDB write |

**Replay safety rules**:
- Any side effect that must not repeat on replay (DynamoDB writes, HTTP calls, etc.) must be inside a `ctx.step()` or `ctx.invoke()`.
- Step and invoke names within loops must include the loop index (`-N`) so replay can match them to their checkpoints deterministically.
- `ctx.invoke()` calls activity Lambdas by function name (unqualified ARN is fine for non-durable activities).

### Real-time event streaming
`ResearchEvents` DynamoDB table (append-only, TTL 30 days) → DynamoDB Streams (NEW_IMAGE) → `eventBroadcaster` Lambda → `ApiGatewayManagementApi.postToConnection` → browser WebSocket.

Event types: `DECOMPOSING`, `SEARCHING`, `RANKING_SOURCES`, `FETCHING_PAGE`, `EXTRACTING`, `SYNTHESIZING`, `THINKING_CHUNK`, `REPORT_CHUNK`, `COMPLETE`, `PARTIAL_COMPLETE`, `ERROR`. See SPEC.md for the full TypeScript union type.

### DynamoDB tables
- **`Sessions`** — PK: `sessionId`; GSI: `userId-startedAt-index` (history queries)
- **`ResearchEvents`** — PK: `sessionId`, SK: `eventId`; has DynamoDB Streams enabled
- **`WebSocketConnections`** — PK: `connectionId`; TTL 2h
- **`UserApprovals`** — PK: `userId`; GSI: `status-registeredAt-index` (admin queries)

### Auth & user approval
- Cognito User Pool + Google OIDC. HTTP API uses Cognito JWT authorizer. WebSocket `$connect` uses a custom Lambda authorizer.
- **New users are blocked by default.** Registration and approval gating are both handled by a single `PreTokenGeneration` trigger (`cognitoPreTokenGen`). `PostAuthentication` does **not** fire for Hosted UI + Google federated sign-ins, so it is not used. On first sign-in, `cognitoPreTokenGen` writes a `pending` record to `UserApprovals` and publishes to SNS (admin email). On every sign-in it checks `status`; throws `USER_PENDING_APPROVAL` if not `approved`. The `userId` key is always the Cognito `sub` UUID, not the federated username.
- Admin approval routes (`GET|PATCH /admin/users/...`) are IAM-secured on a separate API Gateway stage — invoked via CLI or the pre-signed URL in the notification email.

### CDK stacks (infra/lib/stacks/)
1. `ResearchAgentStorageStack` — DynamoDB tables, private S3 bucket (app assets + reports), SSM SecureString params
2. `ResearchAgentComputeStack` — all Lambdas, Durable orchestrator construct, API Gateway (HTTP + WebSocket), Cognito User Pool + triggers
3. `ResearchAgentFrontendStack` — adds a `/research/*` origin + behavior to the **existing** `esaheki.com` CloudFront distribution (imported by ID from SSM); does NOT create a new distribution

### Secrets
All in SSM Parameter Store under `/research-agent/`:
`tavily-api-key`, `anthropic-api-key`, `google-client-id`, `google-client-secret`, `admin-email`, `existing-cloudfront-distribution-id`

## Key Constraints

- **Do not replace or recreate the existing CloudFront distribution** — `esaheki.com` already has a live site. `ResearchAgentFrontendStack` only adds a `/research/*` cache behavior (new S3 origin with OAC + CloudFront Function for SPA routing) to the existing distribution via the L1 `CfnDistribution` escape hatch. The root `/*` behavior is never modified.
- **SPA routing** — a CloudFront Function on the `/research/*` behavior rewrites requests with no file extension to `/research/index.html` so React Router handles them.

- **`synthesizeReport` Lambda**: 3008 MB, 10-min invocation timeout. **`researchOrchestrator`**: 512 MB, 30-s invocation timeout, 10-min durable execution timeout. All others: 512 MB, 30s.
- **All Lambdas**: Node.js 22, ARM64 (Graviton).
- **Orchestrator invocation**: always use the `live` alias ARN — durable functions require a qualified ARN. `startResearch` has IAM `lambda:InvokeFunction` on the alias, not the function itself.
- **Session cap**: max 8 sources fetched, 10-minute durable execution timeout. One active session per user.
- **Reports are always private** — S3 bucket is private, served via CloudFront OAC. No sharing feature in MVP.
- **Q&A context**: full report markdown + all source texts (up to ~80KB) dumped directly into Claude's context window — no vector DB or embeddings.

## CI/CD

GitHub Actions on push to `main`: CDK deploy (OIDC-assumed role, no stored AWS credentials) → Vite build → S3 sync → CloudFront invalidation.
