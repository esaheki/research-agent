import * as cdk from 'aws-cdk-lib'

const app = new cdk.App()

// Stacks are added phase by phase:
// Phase 2: ResearchAgentStorageStack
// Phase 3: ResearchAgentComputeStack (Cognito + user approval)
// Phase 4: ResearchAgentComputeStack (orchestrator + activities)
// Phase 5: ResearchAgentComputeStack (API layer)
// Phase 7: ResearchAgentNetworkStack + ResearchAgentFrontendStack

void app
