import * as path from 'path'
import * as cdk from 'aws-cdk-lib'
import * as cognito from 'aws-cdk-lib/aws-cognito'
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as lambda_event_sources from 'aws-cdk-lib/aws-lambda-event-sources'
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs'
import * as s3 from 'aws-cdk-lib/aws-s3'
import * as sns from 'aws-cdk-lib/aws-sns'
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions'
import * as ssm from 'aws-cdk-lib/aws-ssm'
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2'
import { HttpIamAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers'
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations'
import { Construct } from 'constructs'
import { SSM } from '../config'
import { DurableOrchestrator } from '../constructs/durable-orchestrator'

// Root of the repo, used to resolve backend source paths
const REPO_ROOT = path.join(__dirname, '../../..')

interface ComputeStackProps extends cdk.StackProps {
  approvalsTable: dynamodb.ITable
  sessionsTable: dynamodb.ITable
  eventsTable: dynamodb.ITable
  connectionsTable: dynamodb.ITable
  assetsBucket: s3.IBucket
}

export class ResearchAgentComputeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ComputeStackProps) {
    super(scope, id, props)

    const { approvalsTable, sessionsTable, eventsTable, connectionsTable, assetsBucket } = props

    // ── Shared Lambda defaults ────────────────────────────────────────────
    const fnDefaults: Omit<nodejs.NodejsFunctionProps, 'entry'> = {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      bundling: { minify: true, sourceMap: false },
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
    }

    // SSM param ARNs for IAM grants
    const anthropicKeyArn = `arn:aws:ssm:${this.region}:${this.account}:parameter${SSM.ANTHROPIC_API_KEY}`
    const tavilyKeyArn = `arn:aws:ssm:${this.region}:${this.account}:parameter${SSM.TAVILY_API_KEY}`

    // ── SNS: new-user notification ────────────────────────────────────────
    const newUserTopic = new sns.Topic(this, 'NewUserRegistrationTopic', {
      topicName: 'ResearchAgentNewUserTopic',
      displayName: 'Research Agent — New User Registration',
    })
    const adminEmail = ssm.StringParameter.valueForStringParameter(this, SSM.ADMIN_EMAIL)
    newUserTopic.addSubscription(new subscriptions.EmailSubscription(adminEmail))

    // ── Cognito trigger Lambdas ───────────────────────────────────────────
    const postAuthFn = new nodejs.NodejsFunction(this, 'CognitoPostAuth', {
      ...fnDefaults,
      entry: path.join(REPO_ROOT, 'backend/src/cognito/cognitoPostAuth.ts'),
      environment: {
        USER_APPROVALS_TABLE: approvalsTable.tableName,
        NEW_USER_TOPIC_ARN: newUserTopic.topicArn,
      },
    })
    approvalsTable.grantReadWriteData(postAuthFn)
    newUserTopic.grantPublish(postAuthFn)

    const preTokenGenFn = new nodejs.NodejsFunction(this, 'CognitoPreTokenGen', {
      ...fnDefaults,
      entry: path.join(REPO_ROOT, 'backend/src/cognito/cognitoPreTokenGen.ts'),
      environment: {
        USER_APPROVALS_TABLE: approvalsTable.tableName,
      },
    })
    approvalsTable.grantReadData(preTokenGenFn)

    // ── Admin Lambdas ─────────────────────────────────────────────────────
    const listUsersFn = new nodejs.NodejsFunction(this, 'AdminListUsers', {
      ...fnDefaults,
      entry: path.join(REPO_ROOT, 'backend/src/admin/listUsers.ts'),
      environment: { USER_APPROVALS_TABLE: approvalsTable.tableName },
    })
    approvalsTable.grantReadData(listUsersFn)

    const updateUserStatusFn = new nodejs.NodejsFunction(this, 'AdminUpdateUserStatus', {
      ...fnDefaults,
      entry: path.join(REPO_ROOT, 'backend/src/admin/updateUserStatus.ts'),
      environment: { USER_APPROVALS_TABLE: approvalsTable.tableName },
    })
    approvalsTable.grantWriteData(updateUserStatusFn)

    // ── Admin API Gateway (IAM auth) ──────────────────────────────────────
    const adminApi = new apigwv2.HttpApi(this, 'AdminApi', {
      apiName: 'ResearchAgentAdminApi',
    })
    const iamAuth = new HttpIamAuthorizer()

    adminApi.addRoutes({
      path: '/admin/users',
      methods: [apigwv2.HttpMethod.GET],
      integration: new HttpLambdaIntegration('ListUsersIntegration', listUsersFn),
      authorizer: iamAuth,
    })
    adminApi.addRoutes({
      path: '/admin/users/{userId}/{action}',
      methods: [apigwv2.HttpMethod.PATCH],
      integration: new HttpLambdaIntegration('UpdateUserStatusIntegration', updateUserStatusFn),
      authorizer: iamAuth,
    })

    // ── Cognito User Pool ─────────────────────────────────────────────────
    const userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: 'ResearchAgentUserPool',
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      lambdaTriggers: {
        postAuthentication: postAuthFn,
        preTokenGeneration: preTokenGenFn,
      },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    })

    const googleProvider = new cognito.UserPoolIdentityProviderOidc(this, 'GoogleProvider', {
      userPool,
      name: 'Google',
      clientId: ssm.StringParameter.valueForStringParameter(this, SSM.GOOGLE_CLIENT_ID),
      clientSecret: ssm.StringParameter.valueForSecureStringParameter(
        this,
        SSM.GOOGLE_CLIENT_SECRET,
        1,
      ),
      issuerUrl: 'https://accounts.google.com',
      attributeMapping: {
        email: cognito.ProviderAttribute.other('email'),
        givenName: cognito.ProviderAttribute.other('given_name'),
        familyName: cognito.ProviderAttribute.other('family_name'),
      },
      scopes: ['openid', 'email', 'profile'],
    })

    userPool.addDomain('UserPoolDomain', {
      cognitoDomain: { domainPrefix: 'research-agent-esaheki' },
    })

    const appClient = userPool.addClient('SpaClient', {
      userPoolClientName: 'ResearchAgentSpaClient',
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: [
          'https://esaheki.com/research/callback',
          'http://localhost:5173/research/callback',
        ],
        logoutUrls: ['https://esaheki.com/research', 'http://localhost:5173/research'],
      },
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.custom('Google')],
      refreshTokenValidity: cdk.Duration.days(30),
      preventUserExistenceErrors: true,
    })
    appClient.node.addDependency(googleProvider)

    // ── Phase 4: Activity Lambda functions ────────────────────────────────

    const anthropicEnv = { ANTHROPIC_API_KEY_SSM_PATH: SSM.ANTHROPIC_API_KEY }
    const anthropicGrant = new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [anthropicKeyArn],
    })

    const decomposeQueryFn = new nodejs.NodejsFunction(this, 'DecomposeQuery', {
      ...fnDefaults,
      entry: path.join(REPO_ROOT, 'backend/src/activities/decomposeQuery.ts'),
      environment: anthropicEnv,
    })
    decomposeQueryFn.addToRolePolicy(anthropicGrant)

    const tavilySearchFn = new nodejs.NodejsFunction(this, 'TavilySearch', {
      ...fnDefaults,
      entry: path.join(REPO_ROOT, 'backend/src/activities/tavilySearch.ts'),
      environment: { TAVILY_API_KEY_SSM_PATH: SSM.TAVILY_API_KEY },
    })
    tavilySearchFn.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['ssm:GetParameter'], resources: [tavilyKeyArn] }),
    )

    const rankUrlsFn = new nodejs.NodejsFunction(this, 'RankUrls', {
      ...fnDefaults,
      entry: path.join(REPO_ROOT, 'backend/src/activities/rankUrls.ts'),
      environment: anthropicEnv,
    })
    rankUrlsFn.addToRolePolicy(anthropicGrant)

    const fetchPageFn = new nodejs.NodejsFunction(this, 'FetchPage', {
      ...fnDefaults,
      entry: path.join(REPO_ROOT, 'backend/src/activities/fetchPage.ts'),
      timeout: cdk.Duration.seconds(30),
    })

    const extractKeyPointsFn = new nodejs.NodejsFunction(this, 'ExtractKeyPoints', {
      ...fnDefaults,
      entry: path.join(REPO_ROOT, 'backend/src/activities/extractKeyPoints.ts'),
      environment: anthropicEnv,
    })
    extractKeyPointsFn.addToRolePolicy(anthropicGrant)

    const synthesizeReportFn = new nodejs.NodejsFunction(this, 'SynthesizeReport', {
      ...fnDefaults,
      memorySize: 3008,
      timeout: cdk.Duration.seconds(600),
      entry: path.join(REPO_ROOT, 'backend/src/activities/synthesizeReport.ts'),
      environment: {
        ...anthropicEnv,
        EVENTS_TABLE: eventsTable.tableName,
      },
    })
    synthesizeReportFn.addToRolePolicy(anthropicGrant)
    eventsTable.grantWriteData(synthesizeReportFn)

    const persistReportFn = new nodejs.NodejsFunction(this, 'PersistReport', {
      ...fnDefaults,
      entry: path.join(REPO_ROOT, 'backend/src/activities/persistReport.ts'),
      environment: {
        SESSIONS_TABLE: sessionsTable.tableName,
        ASSETS_BUCKET: assetsBucket.bucketName,
      },
    })
    sessionsTable.grantWriteData(persistReportFn)
    assetsBucket.grantWrite(persistReportFn)

    // ── Phase 4: Durable orchestrator ─────────────────────────────────────
    const orchestrator = new DurableOrchestrator(this, 'ResearchOrchestrator', {
      entry: path.join(REPO_ROOT, 'backend/src/orchestrator/researchOrchestrator.ts'),
      activities: {
        decomposeQuery: decomposeQueryFn,
        tavilySearch: tavilySearchFn,
        rankUrls: rankUrlsFn,
        fetchPage: fetchPageFn,
        extractKeyPoints: extractKeyPointsFn,
        synthesizeReport: synthesizeReportFn,
        persistReport: persistReportFn,
      },
      environment: {
        EVENTS_TABLE: eventsTable.tableName,
        SESSIONS_TABLE: sessionsTable.tableName,
      },
    })
    sessionsTable.grantReadWriteData(orchestrator.handler)
    eventsTable.grantWriteData(orchestrator.handler)

    // ── Phase 4: eventBroadcaster (DynamoDB Streams → WebSocket) ─────────
    const eventBroadcasterFn = new nodejs.NodejsFunction(this, 'EventBroadcaster', {
      ...fnDefaults,
      entry: path.join(REPO_ROOT, 'backend/src/ws/eventBroadcaster.ts'),
      environment: {
        CONNECTIONS_TABLE: connectionsTable.tableName,
        SESSIONS_TABLE: sessionsTable.tableName,
        // WEBSOCKET_API_ENDPOINT set in Phase 5 once the WebSocket API is created
        WEBSOCKET_API_ENDPOINT: '',
      },
    })
    connectionsTable.grantReadWriteData(eventBroadcasterFn)
    sessionsTable.grantReadData(eventBroadcasterFn)

    // Grant execute-api for posting to WebSocket connections (Phase 5 will scope this)
    eventBroadcasterFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['execute-api:ManageConnections'],
        resources: [`arn:aws:execute-api:${this.region}:${this.account}:*`],
      }),
    )

    eventBroadcasterFn.addEventSource(
      new lambda_event_sources.DynamoEventSource(eventsTable as dynamodb.Table, {
        startingPosition: lambda.StartingPosition.LATEST,
        batchSize: 10,
        bisectBatchOnError: true,
      }),
    )

    // ── Outputs ───────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'UserPoolId', {
      value: userPool.userPoolId,
      exportName: 'ResearchAgent-UserPoolId',
    })
    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: appClient.userPoolClientId,
      exportName: 'ResearchAgent-UserPoolClientId',
    })
    new cdk.CfnOutput(this, 'CognitoDomain', {
      value: `research-agent-esaheki.auth.${this.region}.amazoncognito.com`,
    })
    new cdk.CfnOutput(this, 'AdminApiUrl', {
      value: adminApi.apiEndpoint,
      description: 'Invoke with AWS SigV4 signing (IAM auth required)',
    })
    new cdk.CfnOutput(this, 'OrchestratorFunctionName', {
      value: orchestrator.handler.functionName,
      exportName: 'ResearchAgent-OrchestratorFunctionName',
    })
  }
}
