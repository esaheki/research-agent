import * as path from 'path'
import * as cdk from 'aws-cdk-lib'
import * as cr from 'aws-cdk-lib/custom-resources'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs'
import { Construct } from 'constructs'

const REPO_ROOT = path.join(__dirname, '../../..')

export interface CloudFrontPatcherProps {
  /** CloudFormation token or literal ID of the existing distribution */
  distributionId: string
  /** Regional S3 domain name for the new origin */
  bucketDomainName: string
  /** Stable identifier for the origin (used to find/remove it on stack delete) */
  bucketOriginId: string
  /** OAC ID to attach to the origin */
  oacId: string
  /** ARN of the CloudFront Function to attach for SPA rewriting */
  spaRewriteFunctionArn: string
}

/**
 * CDK construct that adds (and removes on delete) a `/research/*` cache behavior
 * and matching S3 origin to an externally-managed CloudFront distribution.
 *
 * Uses a Lambda-backed custom resource because the CloudFront update requires
 * two sequential API calls (GetDistributionConfig + UpdateDistribution) that
 * cannot be expressed with AwsCustomResource's single-call model.
 */
export class CloudFrontDistributionPatcher extends Construct {
  constructor(scope: Construct, id: string, props: CloudFrontPatcherProps) {
    super(scope, id)

    const patcherFn = new nodejs.NodejsFunction(this, 'Handler', {
      entry: path.join(
        REPO_ROOT,
        'backend/src/customResources/cfDistributionPatcher.ts',
      ),
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.minutes(5),
      bundling: { minify: true, sourceMap: false },
    })

    patcherFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['cloudfront:GetDistributionConfig', 'cloudfront:UpdateDistribution'],
        // CloudFront ARNs are global (no region component) — wildcard required
        resources: ['*'],
      }),
    )

    const provider = new cr.Provider(this, 'Provider', {
      onEventHandler: patcherFn,
    })

    new cdk.CustomResource(this, 'Resource', {
      serviceToken: provider.serviceToken,
      resourceType: 'Custom::CloudFrontBehaviorPatcher',
      properties: {
        DistributionId: props.distributionId,
        BucketDomainName: props.bucketDomainName,
        BucketOriginId: props.bucketOriginId,
        OacId: props.oacId,
        SpaRewriteFunctionArn: props.spaRewriteFunctionArn,
      },
    })
  }
}
