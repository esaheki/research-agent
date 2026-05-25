import * as cdk from 'aws-cdk-lib'
import { ResearchAgentStorageStack } from '../lib/stacks/storage-stack'

const app = new cdk.App()

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
}

new ResearchAgentStorageStack(app, 'ResearchAgentStorageStack', { env })

// Added phase by phase:
// Phase 3-5: ResearchAgentComputeStack
// Phase 7:   ResearchAgentFrontendStack
