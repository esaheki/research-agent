# Research Agent

An autonomous AI research assistant that takes a question, searches the web, reads and synthesizes multiple sources, and produces a structured report — all streamed live so you can watch it think.

**Live**: [esaheki.com/research](https://esaheki.com/research)

---

## How it works

1. You type a research question and hit submit
2. The agent decomposes your question into sub-queries and searches via [Tavily](https://tavily.com)
3. It ranks and fetches the most relevant pages using [Jina Reader](https://jina.ai/reader)
4. Each page is summarized by Claude Haiku; conflicts between sources are flagged
5. Claude Sonnet synthesizes everything into a structured report using extended thinking
6. The entire process streams live in a split-pane UI — agent actions on the left, the report materializing on the right

Reports include an executive summary, key findings, detailed analysis, conflicting viewpoints, and inline citations.

---

## Architecture

```
React + Vite (S3 + CloudFront)
    ↕ WebSocket (API Gateway)
    ↕ HTTPS (API Gateway HTTP API)
          ↓
    Lambda Functions (CDK / TypeScript)
          ↓
    Lambda Durable Functions (orchestrator)
    Tavily → Jina Reader → Claude Haiku → Claude Sonnet
          ↓
    DynamoDB → DynamoDB Streams → WebSocket → Browser
          ↓
    S3 (private reports)   Cognito (Google OAuth)
```

All infrastructure is defined in AWS CDK (TypeScript). See [SPEC.md](./SPEC.md) for the full technical specification.

---

## Prerequisites

- Node.js 22+
- AWS CLI configured with credentials for your account
- CDK bootstrapped: `npx cdk bootstrap`
- API keys for [Tavily](https://tavily.com) and [Anthropic](https://console.anthropic.com)
- A Google OAuth app (Client ID + Secret) from [Google Cloud Console](https://console.cloud.google.com)
- A Route 53 hosted zone for your domain

## Setup

### 1. Store secrets in SSM Parameter Store

```bash
aws ssm put-parameter --name /research-agent/tavily-api-key      --type SecureString --value <key>
aws ssm put-parameter --name /research-agent/anthropic-api-key   --type SecureString --value <key>
aws ssm put-parameter --name /research-agent/google-client-id    --type String       --value <id>
aws ssm put-parameter --name /research-agent/google-client-secret --type SecureString --value <secret>
aws ssm put-parameter --name /research-agent/admin-email         --type String       --value <your-email>
```

### 2. Deploy infrastructure

```bash
cd infra
npm ci
npx cdk deploy --all
```

### 3. Build and deploy the frontend

```bash
cd frontend
npm ci
npm run build
aws s3 sync dist/ s3://<frontend-bucket-name>/ --delete
aws cloudfront create-invalidation --distribution-id <id> --paths "/*"
```

The CDK deploy output includes the bucket name and CloudFront distribution ID.

---

## Local development

### Frontend

```bash
cd frontend
npm ci
npm run dev       # http://localhost:5173
```

Copy `frontend/.env.example` to `frontend/.env.local` and fill in your deployed API Gateway and Cognito values.

### Backend

```bash
cd backend
npm ci
npm run build
npm run test
```

Individual Lambda functions can be invoked locally with the AWS SAM CLI or by writing unit tests against the handler directly. The orchestrator uses the official AWS Lambda Durable Functions SDK (`@aws/durable-execution-sdk-js`); end-to-end testing requires a deployed environment with `durableConfig` enabled. Integration tests can use `LocalDurableTestRunner` from `@aws/durable-execution-sdk-js-testing`.

---

## User access

New users who sign in with Google are placed in a **pending** state and cannot use the app until approved. When someone registers, you receive an email at your `admin-email` address with a one-click approval link.

To list pending users or approve/reject manually:

```bash
# List all pending users
aws apigateway test-invoke-method ...   # or curl the pre-signed URL from the email

# Approve a user directly in DynamoDB
aws dynamodb update-item \
  --table-name UserApprovals \
  --key '{"userId": {"S": "<cognito-sub>"}}' \
  --update-expression "SET #s = :approved, approvedAt = :now" \
  --expression-attribute-names '{"#s": "status"}' \
  --expression-attribute-values '{":approved": {"S": "approved"}, ":now": {"S": "'$(date -u +%FT%TZ)'"}}'
```

---

## CI/CD

Push to `main` triggers a GitHub Actions workflow that deploys infrastructure and syncs the frontend. The workflow assumes an IAM role via OIDC — no AWS credentials are stored in GitHub secrets.

---

## Cost

Each research session costs roughly **$0.10–0.25** in external API fees:

| Service | Cost |
|---------|------|
| Tavily (3-5 searches) | ~$0.04 |
| Jina Reader | Free tier |
| Claude Haiku (decompose, rank, extract) | ~$0.01 |
| Claude Sonnet + extended thinking (synthesis) | ~$0.05–0.15 |
