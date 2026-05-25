import * as cdk from 'aws-cdk-lib'
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb'
import * as s3 from 'aws-cdk-lib/aws-s3'
import * as ssm from 'aws-cdk-lib/aws-ssm'
import { Construct } from 'constructs'
import { SSM } from '../config'

export class ResearchAgentStorageStack extends cdk.Stack {
  public readonly sessionsTable: dynamodb.Table
  public readonly eventsTable: dynamodb.Table
  public readonly connectionsTable: dynamodb.Table
  public readonly approvalsTable: dynamodb.Table
  public readonly assetsBucket: s3.Bucket

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props)

    // ── DynamoDB Tables ──────────────────────────────────────────────────────

    this.sessionsTable = new dynamodb.Table(this, 'SessionsTable', {
      tableName: 'ResearchAgentSessions',
      partitionKey: { name: 'sessionId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    })
    this.sessionsTable.addGlobalSecondaryIndex({
      indexName: 'userId-startedAt-index',
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'startedAt', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    })

    // Streams enabled so eventBroadcaster Lambda can push events to WebSocket clients.
    this.eventsTable = new dynamodb.Table(this, 'ResearchEventsTable', {
      tableName: 'ResearchAgentEvents',
      partitionKey: { name: 'sessionId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'eventId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      stream: dynamodb.StreamViewType.NEW_IMAGE,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    })

    // Ephemeral connection state — safe to destroy on stack removal.
    this.connectionsTable = new dynamodb.Table(this, 'ConnectionsTable', {
      tableName: 'ResearchAgentConnections',
      partitionKey: { name: 'connectionId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    })

    this.approvalsTable = new dynamodb.Table(this, 'UserApprovalsTable', {
      tableName: 'ResearchAgentUserApprovals',
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    })
    this.approvalsTable.addGlobalSecondaryIndex({
      indexName: 'status-registeredAt-index',
      partitionKey: { name: 'status', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'registeredAt', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    })

    // ── S3 Bucket ────────────────────────────────────────────────────────────
    // Layout: /assets/* (frontend SPA), /reports/{userId}/{sessionId}/report.md,
    //         /reports/{userId}/{sessionId}/sources/{i}.txt
    this.assetsBucket = new s3.Bucket(this, 'AssetsBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: true,
      cors: [
        {
          allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.HEAD],
          allowedOrigins: ['https://esaheki.com'],
          allowedHeaders: ['Authorization'],
          maxAge: 3000,
        },
      ],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    })

    // ── SSM Parameter placeholders (non-sensitive String params) ─────────────
    // SecureString params (TAVILY_API_KEY, ANTHROPIC_API_KEY, GOOGLE_CLIENT_SECRET)
    // must be created manually via AWS CLI before deploying ComputeStack — see README.
    new ssm.StringParameter(this, 'SsmGoogleClientId', {
      parameterName: SSM.GOOGLE_CLIENT_ID,
      stringValue: 'REPLACE_ME',
      description: 'Google OAuth client ID for Cognito federated IdP',
    })
    new ssm.StringParameter(this, 'SsmAdminEmail', {
      parameterName: SSM.ADMIN_EMAIL,
      stringValue: 'REPLACE_ME',
      description: 'Admin email — receives new-user approval notifications',
    })
    new ssm.StringParameter(this, 'SsmExistingCfDistributionId', {
      parameterName: SSM.EXISTING_CF_DISTRIBUTION_ID,
      stringValue: 'REPLACE_ME',
      description: 'ID of the existing esaheki.com CloudFront distribution',
    })

    // ── Stack Outputs ─────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'SessionsTableName', {
      value: this.sessionsTable.tableName,
      exportName: 'ResearchAgent-SessionsTableName',
    })
    new cdk.CfnOutput(this, 'EventsTableName', {
      value: this.eventsTable.tableName,
      exportName: 'ResearchAgent-EventsTableName',
    })
    new cdk.CfnOutput(this, 'EventsTableStreamArn', {
      value: this.eventsTable.tableStreamArn!,
      exportName: 'ResearchAgent-EventsTableStreamArn',
    })
    new cdk.CfnOutput(this, 'ConnectionsTableName', {
      value: this.connectionsTable.tableName,
      exportName: 'ResearchAgent-ConnectionsTableName',
    })
    new cdk.CfnOutput(this, 'ApprovalsTableName', {
      value: this.approvalsTable.tableName,
      exportName: 'ResearchAgent-ApprovalsTableName',
    })
    new cdk.CfnOutput(this, 'AssetsBucketName', {
      value: this.assetsBucket.bucketName,
      exportName: 'ResearchAgent-AssetsBucketName',
    })
    new cdk.CfnOutput(this, 'AssetsBucketArn', {
      value: this.assetsBucket.bucketArn,
      exportName: 'ResearchAgent-AssetsBucketArn',
    })
  }
}
