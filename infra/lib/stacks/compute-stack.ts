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
import { HttpIamAuthorizer, HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers'
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations'
import { Construct } from 'constructs'
import { SSM } from '../config'
import { DurableOrchestrator } from '../constructs/durable-orchestrator'
import { ResearchAgentDashboard } from '../constructs/dashboard'

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
      tracing: lambda.Tracing.ACTIVE,
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

    // ── Phase 5: WebSocket API ────────────────────────────────────────────
    const wsConnectFn = new nodejs.NodejsFunction(this, 'WsConnect', {
      ...fnDefaults,
      entry: path.join(REPO_ROOT, 'backend/src/ws/wsConnect.ts'),
      environment: {
        CONNECTIONS_TABLE: connectionsTable.tableName,
        SESSIONS_TABLE: sessionsTable.tableName,
        EVENTS_TABLE: eventsTable.tableName,
        COGNITO_USER_POOL_ID: userPool.userPoolId,
        COGNITO_USER_POOL_CLIENT_ID: appClient.userPoolClientId,
      },
    })
    connectionsTable.grantReadWriteData(wsConnectFn)
    sessionsTable.grantReadWriteData(wsConnectFn)
    eventsTable.grantReadData(wsConnectFn)

    const wsDisconnectFn = new nodejs.NodejsFunction(this, 'WsDisconnect', {
      ...fnDefaults,
      entry: path.join(REPO_ROOT, 'backend/src/ws/wsDisconnect.ts'),
      environment: {
        CONNECTIONS_TABLE: connectionsTable.tableName,
      },
    })
    connectionsTable.grantReadWriteData(wsDisconnectFn)

    const wsApi = new apigwv2.CfnApi(this, 'ResearchAgentWsApi', {
      name: 'ResearchAgentWsApi',
      protocolType: 'WEBSOCKET',
      routeSelectionExpression: '$request.body.action',
    })

    const wsConnectIntegration = new apigwv2.CfnIntegration(this, 'WsConnectIntegration', {
      apiId: wsApi.ref,
      integrationType: 'AWS_PROXY',
      integrationUri: `arn:aws:apigateway:${this.region}:lambda:path/2015-03-31/functions/${wsConnectFn.functionArn}/invocations`,
    })
    const wsDisconnectIntegration = new apigwv2.CfnIntegration(this, 'WsDisconnectIntegration', {
      apiId: wsApi.ref,
      integrationType: 'AWS_PROXY',
      integrationUri: `arn:aws:apigateway:${this.region}:lambda:path/2015-03-31/functions/${wsDisconnectFn.functionArn}/invocations`,
    })

    const wsConnectRoute = new apigwv2.CfnRoute(this, 'WsConnectRoute', {
      apiId: wsApi.ref,
      routeKey: '$connect',
      target: `integrations/${wsConnectIntegration.ref}`,
    })
    const wsDisconnectRoute = new apigwv2.CfnRoute(this, 'WsDisconnectRoute', {
      apiId: wsApi.ref,
      routeKey: '$disconnect',
      target: `integrations/${wsDisconnectIntegration.ref}`,
    })

    const wsStage = new apigwv2.CfnStage(this, 'WsStage', {
      apiId: wsApi.ref,
      stageName: 'prod',
      autoDeploy: true,
      defaultRouteSettings: {
        detailedMetricsEnabled: true,
        throttlingBurstLimit: 100,
        throttlingRateLimit: 50,
      },
    })
    wsStage.addDependency(wsConnectRoute)
    wsStage.addDependency(wsDisconnectRoute)

    // Allow API Gateway to invoke the WebSocket Lambda handlers
    wsConnectFn.addPermission('WsConnectPermission', {
      principal: new iam.ServicePrincipal('apigateway.amazonaws.com'),
      sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:${wsApi.ref}/*/$connect`,
    })
    wsDisconnectFn.addPermission('WsDisconnectPermission', {
      principal: new iam.ServicePrincipal('apigateway.amazonaws.com'),
      sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:${wsApi.ref}/*/$disconnect`,
    })

    const wsApiEndpoint = `https://${wsApi.ref}.execute-api.${this.region}.amazonaws.com/prod`

    // Allow wsConnect to post events back over WebSocket during replay
    wsConnectFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['execute-api:ManageConnections'],
        resources: [`arn:aws:execute-api:${this.region}:${this.account}:${wsApi.ref}/*`],
      }),
    )

    // ── Phase 4: eventBroadcaster (DynamoDB Streams → WebSocket) ─────────
    const eventBroadcasterFn = new nodejs.NodejsFunction(this, 'EventBroadcaster', {
      ...fnDefaults,
      entry: path.join(REPO_ROOT, 'backend/src/ws/eventBroadcaster.ts'),
      environment: {
        CONNECTIONS_TABLE: connectionsTable.tableName,
        SESSIONS_TABLE: sessionsTable.tableName,
        WEBSOCKET_API_ENDPOINT: wsApiEndpoint,
      },
    })
    connectionsTable.grantReadWriteData(eventBroadcasterFn)
    sessionsTable.grantReadData(eventBroadcasterFn)

    eventBroadcasterFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['execute-api:ManageConnections'],
        resources: [`arn:aws:execute-api:${this.region}:${this.account}:${wsApi.ref}/*`],
      }),
    )

    eventBroadcasterFn.addEventSource(
      new lambda_event_sources.DynamoEventSource(eventsTable as dynamodb.Table, {
        startingPosition: lambda.StartingPosition.LATEST,
        batchSize: 10,
        bisectBatchOnError: true,
      }),
    )

    // ── Phase 5: HTTP API with Cognito JWT authorizer ─────────────────────
    const jwtAuthorizer = new HttpJwtAuthorizer('CognitoJwtAuthorizer', userPool.userPoolProviderUrl, {
      jwtAudience: [appClient.userPoolClientId],
    })

    const startResearchFn = new nodejs.NodejsFunction(this, 'StartResearch', {
      ...fnDefaults,
      entry: path.join(REPO_ROOT, 'backend/src/api/startResearch.ts'),
      environment: {
        SESSIONS_TABLE: sessionsTable.tableName,
        ORCHESTRATOR_FUNCTION_NAME: orchestrator.handler.functionName,
      },
    })
    sessionsTable.grantReadWriteData(startResearchFn)
    orchestrator.handler.grantInvoke(startResearchFn)

    const cancelResearchFn = new nodejs.NodejsFunction(this, 'CancelResearch', {
      ...fnDefaults,
      entry: path.join(REPO_ROOT, 'backend/src/api/cancelResearch.ts'),
      environment: {
        SESSIONS_TABLE: sessionsTable.tableName,
      },
    })
    sessionsTable.grantReadWriteData(cancelResearchFn)

    const listSessionsFn = new nodejs.NodejsFunction(this, 'ListSessions', {
      ...fnDefaults,
      entry: path.join(REPO_ROOT, 'backend/src/api/listSessions.ts'),
      environment: {
        SESSIONS_TABLE: sessionsTable.tableName,
      },
    })
    sessionsTable.grantReadData(listSessionsFn)

    const getSessionFn = new nodejs.NodejsFunction(this, 'GetSession', {
      ...fnDefaults,
      entry: path.join(REPO_ROOT, 'backend/src/api/getSession.ts'),
      environment: {
        SESSIONS_TABLE: sessionsTable.tableName,
        ASSETS_BUCKET: assetsBucket.bucketName,
      },
    })
    sessionsTable.grantReadData(getSessionFn)
    assetsBucket.grantRead(getSessionFn, 'reports/*')

    const chatWithReportFn = new nodejs.NodejsFunction(this, 'ChatWithReport', {
      ...fnDefaults,
      entry: path.join(REPO_ROOT, 'backend/src/api/chatWithReport.ts'),
      environment: {
        SESSIONS_TABLE: sessionsTable.tableName,
        ASSETS_BUCKET: assetsBucket.bucketName,
        ANTHROPIC_API_KEY_SSM_PATH: SSM.ANTHROPIC_API_KEY,
      },
    })
    sessionsTable.grantReadData(chatWithReportFn)
    assetsBucket.grantRead(chatWithReportFn, 'reports/*')
    chatWithReportFn.addToRolePolicy(anthropicGrant)

    const researchApi = new apigwv2.HttpApi(this, 'ResearchAgentHttpApi', {
      apiName: 'ResearchAgentHttpApi',
      corsPreflight: {
        allowOrigins: ['https://esaheki.com', 'http://localhost:5173'],
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.DELETE,
          apigwv2.CorsHttpMethod.OPTIONS,
        ],
        allowHeaders: ['Authorization', 'Content-Type'],
      },
    })

    researchApi.addRoutes({
      path: '/research',
      methods: [apigwv2.HttpMethod.POST],
      integration: new HttpLambdaIntegration('StartResearchIntegration', startResearchFn),
      authorizer: jwtAuthorizer,
    })
    researchApi.addRoutes({
      path: '/research/{sessionId}',
      methods: [apigwv2.HttpMethod.DELETE],
      integration: new HttpLambdaIntegration('CancelResearchIntegration', cancelResearchFn),
      authorizer: jwtAuthorizer,
    })
    researchApi.addRoutes({
      path: '/research/history',
      methods: [apigwv2.HttpMethod.GET],
      integration: new HttpLambdaIntegration('ListSessionsIntegration', listSessionsFn),
      authorizer: jwtAuthorizer,
    })
    researchApi.addRoutes({
      path: '/research/{sessionId}',
      methods: [apigwv2.HttpMethod.GET],
      integration: new HttpLambdaIntegration('GetSessionIntegration', getSessionFn),
      authorizer: jwtAuthorizer,
    })
    researchApi.addRoutes({
      path: '/research/{sessionId}/chat',
      methods: [apigwv2.HttpMethod.POST],
      integration: new HttpLambdaIntegration('ChatWithReportIntegration', chatWithReportFn),
      authorizer: jwtAuthorizer,
    })

    // ── Phase 8: API Gateway detailed metrics ─────────────────────────────
    // HTTP API (L2 stage, accessed via escape hatch)
    const cfnHttpStage = researchApi.defaultStage!.node.defaultChild as apigwv2.CfnStage
    cfnHttpStage.addPropertyOverride('DefaultRouteSettings.DetailedMetricsEnabled', true)

    // ── Phase 8: CloudWatch dashboard ─────────────────────────────────────
    const allFunctions: lambda.Function[] = [
      postAuthFn,
      preTokenGenFn,
      listUsersFn,
      updateUserStatusFn,
      decomposeQueryFn,
      tavilySearchFn,
      rankUrlsFn,
      fetchPageFn,
      extractKeyPointsFn,
      synthesizeReportFn,
      persistReportFn,
      orchestrator.handler,
      eventBroadcasterFn,
      wsConnectFn,
      wsDisconnectFn,
      startResearchFn,
      cancelResearchFn,
      listSessionsFn,
      getSessionFn,
      chatWithReportFn,
    ]

    new ResearchAgentDashboard(this, 'Dashboard', {
      orchestratorFunction: orchestrator.handler,
      synthesizeReportFunction: synthesizeReportFn,
      allFunctions,
    })

    // ── Phase 9: GitHub Actions OIDC deploy role ──────────────────────────
    // Import the existing OIDC provider (created manually in the AWS account)
    const githubOidcProvider = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
      this,
      'GitHubOidcProvider',
      `arn:aws:iam::${this.account}:oidc-provider/token.actions.githubusercontent.com`,
    )

    const deployRole = new iam.Role(this, 'GitHubActionsDeployRole', {
      roleName: 'GitHubActions-ResearchAgent',
      description: 'Assumed by GitHub Actions via OIDC to deploy this project',
      assumedBy: new iam.WebIdentityPrincipal(githubOidcProvider.openIdConnectProviderArn, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
        },
        StringLike: {
          // Scope to the exact repo + branch — change if the repo is renamed
          'token.actions.githubusercontent.com:sub':
            'repo:esaheki/research-agent:ref:refs/heads/main',
        },
      }),
    })

    // CDK deploy operations go through the CDK bootstrap roles
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'CdkBootstrapRoles',
        actions: ['sts:AssumeRole'],
        resources: [`arn:aws:iam::${this.account}:role/cdk-*`],
      }),
    )

    // S3 sync for the frontend bucket (name is CDK-generated so we use a prefix pattern)
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'FrontendS3Sync',
        actions: [
          's3:GetObject',
          's3:PutObject',
          's3:DeleteObject',
          's3:ListBucket',
          's3:GetBucketLocation',
        ],
        resources: [
          `arn:aws:s3:::researchagentfrontendstack-frontendbucket*`,
          `arn:aws:s3:::researchagentfrontendstack-frontendbucket*/*`,
        ],
      }),
    )

    // CloudFront invalidation (scoped to the specific distribution at deploy time via SSM)
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'CloudFrontInvalidation',
        actions: ['cloudfront:CreateInvalidation'],
        resources: [`arn:aws:cloudfront::${this.account}:distribution/*`],
      }),
    )

    // Read SSM + describe stacks to resolve post-deploy values
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'CicdReadonly',
        actions: ['ssm:GetParameter', 'cloudformation:DescribeStacks'],
        resources: ['*'],
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
    new cdk.CfnOutput(this, 'HttpApiUrl', {
      value: researchApi.apiEndpoint,
      exportName: 'ResearchAgent-HttpApiUrl',
    })
    new cdk.CfnOutput(this, 'WebSocketApiUrl', {
      value: `wss://${wsApi.ref}.execute-api.${this.region}.amazonaws.com/prod`,
      exportName: 'ResearchAgent-WebSocketApiUrl',
    })
    new cdk.CfnOutput(this, 'GitHubActionsRoleArn', {
      value: deployRole.roleArn,
      exportName: 'ResearchAgent-GitHubActionsRoleArn',
      description: 'Set this value as the AWS_ROLE_ARN secret in the GitHub repository',
    })
  }
}
