import * as cdk from 'aws-cdk-lib'
import { ResearchAgentStorageStack } from '../lib/stacks/storage-stack'
import { ResearchAgentComputeStack } from '../lib/stacks/compute-stack'

const app = new cdk.App()

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
}

const storage = new ResearchAgentStorageStack(app, 'ResearchAgentStorageStack', { env })

new ResearchAgentComputeStack(app, 'ResearchAgentComputeStack', {
  env,
  approvalsTable: storage.approvalsTable,
})

// Phase 7: ResearchAgentFrontendStack
