# Implementation Plan

Phases are sequential. Each phase has a **verification** step that must pass before moving to the next.

---

## Phase 1 — Monorepo Scaffolding

Set up the three-package TypeScript monorepo with shared tooling.

**Tasks:**
- [x] Create `infra/`, `backend/`, `frontend/` directories with `package.json` in each
- [x] Configure `tsconfig.json` in each package (strict mode, `ES2022` target)
- [x] Add root-level `package.json` with `workspaces` and scripts that forward to each package
- [x] Add `.gitignore` (node_modules, dist, cdk.out, .env*)
- [x] Add `backend/` ESLint + Prettier config shared across infra and backend

**Verification:**
```bash
npm run build          # runs tsc in infra/ and backend/ — zero errors
cd frontend && npm run typecheck  # zero errors
```

---

## Phase 2 — Storage Stack

Define all persistent infrastructure: DynamoDB tables, S3 bucket, SSM parameter placeholders.

**Tasks:**
- [x] `infra/lib/stacks/storage-stack.ts` — define all four DynamoDB tables with correct keys, GSIs, TTL attributes, and Streams config on `ResearchEvents`
- [x] S3 bucket: private, versioned, CORS policy for CloudFront origin
- [x] SSM Parameter Store string placeholders for all five secrets (values set manually — see README)
- [x] Export table names, bucket name, and ARNs as CDK stack outputs

**Verification:**
```bash
cd infra && npx cdk synth ResearchAgentStorageStack
# CloudFormation template emitted with no errors;
# grep confirms: 4 DynamoDB tables, 1 S3 bucket, StreamSpecification on ResearchEvents table
```

---

## Phase 3 — Auth: Cognito + User Approval

Cognito User Pool with Google IdP, two Lambda triggers enforcing the approval gate, and IAM-secured admin endpoints.

**Tasks:**
- [x] `backend/src/cognito/cognitoPostAuth.ts` — on first sign-in, write `pending` record to `UserApprovals`; publish to SNS topic with user email + pre-signed approval URL
- [x] `backend/src/cognito/cognitoPreTokenGen.ts` — query `UserApprovals`; throw if status is not `approved`
- [x] `backend/src/admin/listUsers.ts` — query `UserApprovals` by status GSI
- [x] `backend/src/admin/updateUserStatus.ts` — set status to `approved` or `rejected`, write `approvedAt`
- [x] Cognito User Pool CDK construct: Google OIDC IdP, Hosted UI, SPA app client (PKCE), PostAuthentication + PreTokenGeneration trigger attachments
- [x] SNS topic `NewUserRegistrationTopic` with email subscription to `ADMIN_EMAIL`
- [x] Admin API Gateway HTTP API (IAM auth): `GET /admin/users`, `PATCH /admin/users/:userId/approve`, `PATCH /admin/users/:userId/reject`

**Verification:**
```bash
cd infra && npx cdk synth ResearchAgentComputeStack
# Template contains: CognitoUserPool, UserPoolIdentityProviderOidc (Google),
#   LambdaConfig with PostAuthentication + PreTokenGeneration triggers,
#   SNS Topic, admin API Gateway with AWS_IAM authorizationType
```
```bash
cd backend && npm run test -- --testPathPattern=cognito
# Unit tests pass: postAuth writes pending record + publishes SNS;
#   preTokenGen throws for pending user, passes for approved user
```

---

## Phase 4 — Research Orchestrator

All activity Lambda functions and the Lambda Durable orchestrator that sequences them.

**Tasks:**
- [x] `backend/src/activities/decomposeQuery.ts` — Claude Haiku 4.5 call; returns 3-5 sub-query strings
- [x] `backend/src/activities/tavilySearch.ts` — Tavily API call (`search_depth: advanced`, `max_results: 10`); returns `{ url, title, snippet, score }[]`
- [x] `backend/src/activities/rankUrls.ts` — Claude Haiku 4.5 call; deduplicates across sub-queries, returns top 8 URLs
- [x] `backend/src/activities/fetchPage.ts` — GET `https://r.jina.ai/{url}`; 15s timeout; graceful fallback on error
- [x] `backend/src/activities/extractKeyPoints.ts` — Claude Haiku 4.5 call; input truncated to 8K tokens; returns `{ url, keyPoints, relevance, conflictsFound }`
- [x] `backend/src/activities/synthesizeReport.ts` — Claude Sonnet 4.6 with `thinking: { type: 'enabled', budget_tokens: 8000 }`; streams `THINKING_CHUNK` and `REPORT_CHUNK` events to `ResearchEvents` table; returns structured markdown
- [x] `backend/src/activities/persistReport.ts` — writes `report.md` and `sources/{i}.txt` to S3; updates `Sessions` DynamoDB item to `complete`
- [x] `backend/src/orchestrator/researchOrchestrator.ts` — wires all activities into a durable sequence; emits progress events; retry policy (3x, exponential backoff); hard cap: 8 sources, 10-minute timeout; `PARTIAL_COMPLETE` path on activity exhaustion
- [x] `backend/src/ws/eventBroadcaster.ts` — DynamoDB Streams handler; posts events to connected WebSocket client via `ApiGatewayManagementApi`
- [x] CDK constructs for: all activity Lambdas (Node.js 22, ARM64), `synthesizeReport` at 3008 MB / 10 min, Durable orchestrator construct, `eventBroadcaster` Lambda with DynamoDB Streams event source

**Verification:**
```bash
cd backend && npm run test -- --testPathPattern=activities
# Unit tests pass for all activity functions (mocked Anthropic + Tavily clients)
```
```bash
cd backend && npm run test -- --testPathPattern=orchestrator
# Orchestrator integration test: runs full pipeline against mocked activities,
#   asserts events emitted in correct order, partial-complete path works
```
```bash
cd infra && npx cdk synth ResearchAgentComputeStack
# synthesizeReport Lambda has MemorySize: 3008, Timeout: 600;
# DurableOrchestrator construct present in template
```

---

## Phase 5 — API Layer

HTTP API endpoints for starting, cancelling, and querying research sessions, plus the WebSocket connection handlers and the post-report Q&A endpoint.

**Tasks:**
- [x] `backend/src/api/startResearch.ts` — validates request, checks for existing `running` session (returns 409 if found), starts orchestrator, writes `pending` session to DynamoDB, returns `{ sessionId }`
- [x] `backend/src/api/cancelResearch.ts` — verifies ownership, sends cancel signal to orchestrator, updates session status to `cancelled`
- [x] `backend/src/api/listSessions.ts` — queries `userId-startedAt-index` GSI, returns last 20 sessions
- [x] `backend/src/api/getSession.ts` — returns session metadata; if complete, returns report markdown from S3
- [x] `backend/src/api/chatWithReport.ts` — loads report + source texts from S3; streams Claude Sonnet 4.6 response via SSE; verifies session ownership
- [x] `backend/src/ws/wsConnect.ts` — validates Cognito token, writes `connectionId → sessionId` to `WebSocketConnections`; replays all existing `ResearchEvents` for the session so reconnecting clients catch up
- [x] `backend/src/ws/wsDisconnect.ts` — deletes connection record
- [x] CDK: HTTP API with Cognito JWT authorizer on all `/research` routes; WebSocket API with custom Lambda authorizer on `$connect`; all route integrations wired

**Verification:**
```bash
cd backend && npm run test -- --testPathPattern=api
# Unit tests pass for all API handlers (mocked DynamoDB + orchestrator client)
```
```bash
cd infra && npx cdk deploy ResearchAgentComputeStack
# Deploy succeeds; CDK outputs: HttpApiUrl, WebSocketApiUrl

# Smoke test — unauthenticated request is rejected:
curl -X POST <HttpApiUrl>/research
# → 401 Unauthorized

# Smoke test — WebSocket connects with valid token:
wscat -c "<WebSocketApiUrl>?token=<valid-cognito-token>&sessionId=test"
# → connected (or immediate close with auth error if token invalid — both confirm the authorizer is wired)
```

---

## Phase 6 — Frontend

React + Vite SPA with Cognito auth, split-pane research UI, WebSocket client, and report renderer.

**Tasks:**
- [ ] `frontend/src/lib/cognito.ts` — Cognito Hosted UI redirect helpers, token storage (ID token in memory, refresh token in httpOnly cookie via a thin Lambda proxy), token refresh logic
- [ ] `frontend/src/hooks/useWebSocket.ts` — connects to API Gateway WebSocket, handles reconnection, dispatches typed `ResearchEvent` objects, replays events on reconnect
- [ ] `frontend/src/hooks/useResearch.ts` — orchestrates session lifecycle: submit question → POST /research → open WebSocket → accumulate events → derive UI state
- [ ] `frontend/src/components/EventStream/` — left pane; renders event cards per event type; streams `THINKING_CHUNK` tokens into a collapsible monospace block; auto-scrolls
- [ ] `frontend/src/components/ReportViewer/` — right pane; renders growing markdown with `[CONFLICT]` markers as highlighted callout blocks; shows partial-report warning banner
- [ ] `frontend/src/components/SplitPane/` — resizable split-pane layout wrapper
- [ ] `frontend/src/pages/ResearchPage.tsx` — question input, active session enforcement (cancel modal), wires EventStream + ReportViewer
- [ ] `frontend/src/pages/HistoryPage.tsx` — lists past sessions from `GET /research/history`, links to session view
- [ ] `frontend/src/pages/SessionPage.tsx` — loads completed report via `GET /research/:id`, renders it with the Q&A chat panel
- [ ] Q&A chat panel — sends messages to `POST /research/:id/chat`, streams SSE response

**Verification:**
```bash
cd frontend && npm run build   # zero TypeScript errors, no Vite build warnings
cd frontend && npm run preview  # app loads at localhost:4173
```

Manual checks (run `npm run dev`, open browser):
- [ ] Unauthenticated visit to `/research` redirects to Cognito Hosted UI
- [ ] After Google sign-in as a pending user, app shows "Your account is pending admin approval."
- [ ] After approval, question submission shows split-pane with live event cards appearing
- [ ] `[CONFLICT]` text in a mock report renders as a highlighted callout block
- [ ] History page lists past sessions; clicking one renders the report

---

## Phase 7 — Frontend Hosting & Domain

Add the research app as a new origin + cache behavior on the **existing** `esaheki.com` CloudFront distribution. The existing site and its root `/*` behavior must remain untouched.

**Tasks:**
- [ ] Store the existing CloudFront distribution ID in SSM: `/research-agent/existing-cloudfront-distribution-id`
- [ ] `infra/lib/stacks/frontend-stack.ts`:
  - Import the existing distribution with `Distribution.fromDistributionAttributes()`
  - Create a new private S3 bucket for frontend assets with OAC
  - Add a CloudFront Function (`spaRewrite`) that rewrites requests with no file extension under `/research/*` to `/research/index.html`
  - Use the `CfnDistribution` escape hatch to add the new S3 origin and a `/research/*` cache behavior with the `spaRewrite` function — without modifying any existing origins or behaviors
- [ ] CI/CD invalidation path updated to `/research/*` (not `/*`, which would bust the existing site's cache)

**Verification:**
```bash
# Store the existing distribution ID first (one-time manual step):
aws ssm put-parameter --name /research-agent/existing-cloudfront-distribution-id \
  --type String --value <your-existing-distribution-id>

cd infra && npx cdk deploy ResearchAgentFrontendStack
```
```bash
# Existing site is unaffected:
curl -I https://esaheki.com
# → HTTP/2 200

# Research app is reachable:
curl -I https://esaheki.com/research
# → HTTP/2 200

# SPA routing works (deep link returns index.html, not 403/404):
curl -I https://esaheki.com/research/session/some-id
# → HTTP/2 200

# Private report assets are blocked without auth:
curl -I https://esaheki.com/research/reports/some-uuid/report.md
# → HTTP/2 403
```

---

## Phase 8 — Observability

X-Ray tracing, structured logging, and the CloudWatch dashboard.

**Tasks:**
- [ ] Enable X-Ray active tracing on all Lambda functions and both API Gateway stages in CDK
- [ ] Confirm all Lambda handlers emit structured JSON logs with at minimum `{ sessionId, userId, step, durationMs }`
- [ ] `infra/lib/constructs/dashboard.ts` — CloudWatch dashboard `ResearchAgentDashboard` with widgets: active sessions, completion rate, p50/p95 research duration, error rate by function, estimated token cost

**Verification:**
```bash
cd infra && npx cdk deploy ResearchAgentComputeStack
# All Lambda functions in AWS Console show X-Ray: Active
```
```bash
aws cloudwatch get-dashboard --dashboard-name ResearchAgentDashboard
# → JSON response (dashboard exists)
```
Run one end-to-end research session, then:
```bash
aws xray get-service-graph --start-time $(date -v-10M +%s) --end-time $(date +%s)
# → Service graph includes Lambda functions and API Gateway nodes
```

---

## Phase 9 — CI/CD

GitHub Actions pipeline that deploys infrastructure and frontend on every push to `main`.

**Tasks:**
- [ ] `.github/workflows/deploy.yml` — steps: checkout → configure AWS via OIDC → `npm ci` in infra/ → `cdk deploy --all --require-approval never` → `npm ci && npm run build` in frontend/ → `aws s3 sync` → CloudFront invalidation
- [ ] IAM OIDC provider for GitHub Actions in CDK (or document the manual setup step)
- [ ] GitHub repository secret: `AWS_ROLE_ARN` (the OIDC-assumed role ARN)
- [ ] Confirm the IAM role has least-privilege permissions scoped to CDK deploy + S3 sync + CloudFront invalidation

**Verification:**
- Push a whitespace change to `main`; GitHub Actions workflow completes green
- CloudFront invalidation appears in the AWS Console distribution's invalidation history
- The deployed frontend reflects the pushed change within 60 seconds of the workflow completing
