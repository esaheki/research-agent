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
Each `ctx.callActivity(...)` call is a durable checkpoint — the orchestrator can replay safely from any step.

| Step | Activity | Model / Service |
|------|----------|-----------------|
| 1 | `decomposeQuery` | Claude Haiku 4.5 — produces 3-5 sub-queries |
| 2-N | `tavilySearch` | Tavily API — one call per sub-query |
| N+1 | `rankUrls` | Claude Haiku 4.5 — deduplicates, selects top 8 URLs |
| N+2..N+9 | `fetchPage` | Jina Reader (r.jina.ai) — URL → clean markdown |
| N+10..N+17 | `extractKeyPoints` | Claude Haiku 4.5 — key points + conflict detection per page |
| N+18 | `synthesizeReport` | Claude Sonnet 4.6 + extended thinking (`budget_tokens: 8000`) |
| N+19 | `persistReport` | S3 + DynamoDB |

**Replay safety rule**: never put non-deterministic code (timestamps, random, direct HTTP calls, LLM calls) outside of an activity function. The orchestrator body must be pure replay-safe logic.

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
- **New users are blocked by default.** `cognitoPostAuth` (PostAuthentication trigger) writes a `pending` record to `UserApprovals` and emails the admin via SNS. `cognitoPreTokenGen` (PreTokenGeneration trigger) checks approval status and throws if not `approved` — Cognito never issues a token to unapproved users.
- Admin approval routes (`GET|PATCH /admin/users/...`) are IAM-secured on a separate API Gateway stage — invoked via CLI or the pre-signed URL in the notification email.

### CDK stacks (infra/lib/stacks/)
1. `ResearchAgentNetworkStack` — Route 53 + ACM cert for esaheki.com/research
2. `ResearchAgentStorageStack` — DynamoDB tables, private S3 bucket, SSM SecureString params
3. `ResearchAgentComputeStack` — all Lambdas, Durable orchestrator construct, API Gateway (HTTP + WebSocket), Cognito User Pool + triggers
4. `ResearchAgentFrontendStack` — CloudFront distribution with OAC for private S3

### Secrets
All in SSM Parameter Store under `/research-agent/`:
`tavily-api-key`, `anthropic-api-key`, `google-client-id`, `google-client-secret`, `admin-email`

## Key Constraints

- **`synthesizeReport` Lambda**: 3008 MB, 10-min timeout (extended thinking is slow). All others: 512 MB, 30s.
- **All Lambdas**: Node.js 22, ARM64 (Graviton).
- **Session cap**: max 8 sources fetched, 10-minute hard timeout on the orchestrator. One active session per user.
- **Reports are always private** — S3 bucket is private, served via CloudFront OAC. No sharing feature in MVP.
- **Q&A context**: full report markdown + all source texts (up to ~80KB) dumped directly into Claude's context window — no vector DB or embeddings.

## CI/CD

GitHub Actions on push to `main`: CDK deploy (OIDC-assumed role, no stored AWS credentials) → Vite build → S3 sync → CloudFront invalidation.
