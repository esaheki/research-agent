import * as path from 'path'
import * as cdk from 'aws-cdk-lib'
import * as cognito from 'aws-cdk-lib/aws-cognito'
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs'
import * as sns from 'aws-cdk-lib/aws-sns'
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions'
import * as ssm from 'aws-cdk-lib/aws-ssm'
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2'
import { HttpIamAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers'
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations'
import { Construct } from 'constructs'
import { SSM } from '../config'

// Root of the repo, used to resolve backend source paths
const REPO_ROOT = path.join(__dirname, '../../..')

interface ComputeStackProps extends cdk.StackProps {
  approvalsTable: dynamodb.ITable
}

export class ResearchAgentComputeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ComputeStackProps) {
    super(scope, id, props)

    const { approvalsTable } = props

    // ── Shared Lambda defaults ────────────────────────────────────────────
    const fnDefaults: Omit<nodejs.NodejsFunctionProps, 'entry'> = {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      bundling: { minify: true, sourceMap: false },
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
    }

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
    // Ensure the client is created after the Google provider
    appClient.node.addDependency(googleProvider)

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
  }
}
