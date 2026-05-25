import {
  CloudFrontClient,
  GetDistributionConfigCommand,
  UpdateDistributionCommand,
  type CacheBehavior,
} from '@aws-sdk/client-cloudfront'

const cf = new CloudFrontClient({})

interface Props {
  DistributionId: string
  BucketDomainName: string
  BucketOriginId: string
  OacId: string
  SpaRewriteFunctionArn: string
}

interface CrEvent {
  RequestType: 'Create' | 'Update' | 'Delete'
  ResourceProperties: Props & { ServiceToken: string }
  PhysicalResourceId?: string
}

export const handler = async (event: CrEvent) => {
  const { DistributionId, BucketDomainName, BucketOriginId, OacId, SpaRewriteFunctionArn } =
    event.ResourceProperties

  const physicalId = `${DistributionId}-${BucketOriginId}`

  if (event.RequestType === 'Delete') {
    await removeOriginAndBehavior(DistributionId, BucketOriginId)
    return { PhysicalResourceId: event.PhysicalResourceId ?? physicalId }
  }

  await upsertOriginAndBehavior(
    DistributionId,
    BucketDomainName,
    BucketOriginId,
    OacId,
    SpaRewriteFunctionArn,
  )
  return { PhysicalResourceId: physicalId }
}

async function upsertOriginAndBehavior(
  distributionId: string,
  bucketDomainName: string,
  originId: string,
  oacId: string,
  spaRewriteFunctionArn: string,
): Promise<void> {
  const res = await cf.send(new GetDistributionConfigCommand({ Id: distributionId }))
  const config = res.DistributionConfig
  const etag = res.ETag
  if (!config || !etag) throw new Error('Failed to retrieve distribution config')

  // Upsert origin
  const origins = config.Origins!
  origins.Items = (origins.Items ?? []).filter((o) => o.Id !== originId)
  origins.Items.push({
    Id: originId,
    DomainName: bucketDomainName,
    // OAC requires empty OAI string
    S3OriginConfig: { OriginAccessIdentity: '' },
    OriginAccessControlId: oacId,
  })
  origins.Quantity = origins.Items.length

  // Upsert /research/* cache behavior
  const cacheBehaviors = config.CacheBehaviors ?? { Items: [], Quantity: 0 }
  cacheBehaviors.Items = (cacheBehaviors.Items ?? []).filter(
    (b) => b.PathPattern !== '/research/*',
  )

  const newBehavior: CacheBehavior = {
    PathPattern: '/research/*',
    TargetOriginId: originId,
    ViewerProtocolPolicy: 'redirect-to-https',
    // Managed-CachingOptimized policy
    CachePolicyId: '658327ea-f89d-4fab-a63d-7e88639e58f6',
    Compress: true,
    AllowedMethods: {
      Quantity: 2,
      Items: ['GET', 'HEAD'],
      CachedMethods: { Quantity: 2, Items: ['GET', 'HEAD'] },
    },
    FunctionAssociations: {
      Quantity: 1,
      Items: [{ FunctionARN: spaRewriteFunctionArn, EventType: 'viewer-request' }],
    },
    LambdaFunctionAssociations: { Quantity: 0, Items: [] },
    TrustedSigners: { Enabled: false, Quantity: 0 },
    TrustedKeyGroups: { Enabled: false, Quantity: 0 },
    FieldLevelEncryptionId: '',
    SmoothStreaming: false,
  }

  cacheBehaviors.Items.push(newBehavior)
  cacheBehaviors.Quantity = cacheBehaviors.Items.length
  config.CacheBehaviors = cacheBehaviors

  await cf.send(
    new UpdateDistributionCommand({
      Id: distributionId,
      IfMatch: etag,
      DistributionConfig: config,
    }),
  )
}

async function removeOriginAndBehavior(distributionId: string, originId: string): Promise<void> {
  const res = await cf.send(new GetDistributionConfigCommand({ Id: distributionId }))
  const config = res.DistributionConfig
  const etag = res.ETag
  if (!config || !etag) throw new Error('Failed to retrieve distribution config')

  const origins = config.Origins!
  origins.Items = (origins.Items ?? []).filter((o) => o.Id !== originId)
  origins.Quantity = origins.Items.length

  if (config.CacheBehaviors) {
    config.CacheBehaviors.Items = (config.CacheBehaviors.Items ?? []).filter(
      (b) => b.TargetOriginId !== originId,
    )
    config.CacheBehaviors.Quantity = config.CacheBehaviors.Items.length
  }

  await cf.send(
    new UpdateDistributionCommand({
      Id: distributionId,
      IfMatch: etag,
      DistributionConfig: config,
    }),
  )
}
