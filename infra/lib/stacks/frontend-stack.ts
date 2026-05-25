import * as cdk from 'aws-cdk-lib'
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as s3 from 'aws-cdk-lib/aws-s3'
import * as ssm from 'aws-cdk-lib/aws-ssm'
import { Construct } from 'constructs'
import { SSM } from '../config'
import { CloudFrontDistributionPatcher } from '../constructs/cloudfront-patcher'

export class ResearchAgentFrontendStack extends cdk.Stack {
  public readonly frontendBucket: s3.Bucket

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props)

    // Read the existing distribution ID from SSM (set once manually before deploy)
    const distributionId = ssm.StringParameter.valueForStringParameter(
      this,
      SSM.EXISTING_CF_DISTRIBUTION_ID,
    )

    // Private S3 bucket for frontend SPA assets (separate from the reports bucket)
    this.frontendBucket = new s3.Bucket(this, 'FrontendBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    })

    // Origin Access Control — CloudFront signs requests to S3 with SigV4
    const oac = new cloudfront.CfnOriginAccessControl(this, 'FrontendOAC', {
      originAccessControlConfig: {
        name: 'ResearchAgentFrontendOAC',
        originAccessControlOriginType: 's3',
        signingBehavior: 'always',
        signingProtocol: 'sigv4',
      },
    })

    // Bucket policy: only the specific distribution may read objects via OAC
    this.frontendBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowCloudFrontOAC',
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal('cloudfront.amazonaws.com')],
        actions: ['s3:GetObject'],
        resources: [this.frontendBucket.arnForObjects('*')],
        conditions: {
          StringEquals: {
            'AWS:SourceArn': cdk.Stack.of(this).formatArn({
              service: 'cloudfront',
              region: '',
              resource: 'distribution',
              resourceName: distributionId,
            }),
          },
        },
      }),
    )

    // CloudFront Function: serve index.html for any /research path without a file extension.
    // This covers /research (exact), /research/ (slash), and deep links like /research/session/x.
    // Assets (/research/assets/*.js) have an extension and pass through unchanged.
    const spaRewriteFn = new cloudfront.Function(this, 'SpaRewriteFn', {
      functionName: 'ResearchAgentSpaRewrite',
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(
        [
          'function handler(event) {',
          '  var uri = event.request.uri;',
          "  if (!uri.match(/\\.[a-zA-Z0-9]+$/)) {",
          "    event.request.uri = '/research/index.html';",
          '  }',
          '  return event.request;',
          '}',
        ].join('\n'),
      ),
    })

    // Lambda-backed custom resource: adds the /research/* origin + behavior to the
    // existing distribution without touching any other origins or behaviors.
    new CloudFrontDistributionPatcher(this, 'DistributionPatcher', {
      distributionId,
      bucketDomainName: this.frontendBucket.bucketRegionalDomainName,
      bucketOriginId: 'ResearchAgentSpaOrigin',
      oacId: oac.attrId,
      spaRewriteFunctionArn: spaRewriteFn.functionArn,
    })

    // ── Outputs ────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'FrontendBucketName', {
      value: this.frontendBucket.bucketName,
      exportName: 'ResearchAgent-FrontendBucketName',
      description: 'S3 bucket for frontend SPA assets — target of aws s3 sync',
    })
    new cdk.CfnOutput(this, 'ExistingDistributionId', {
      value: distributionId,
      exportName: 'ResearchAgent-ExistingDistributionId',
      description: 'CloudFront distribution ID (for cache invalidation in CI/CD)',
    })
    new cdk.CfnOutput(this, 'SpaRewriteFunctionArn', {
      value: spaRewriteFn.functionArn,
      description: 'ARN of the SPA rewrite CloudFront Function',
    })
  }
}
