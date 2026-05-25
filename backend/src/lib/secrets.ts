import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm'

const ssm = new SSMClient({})
const cache = new Map<string, string>()

export async function getSecret(paramName: string): Promise<string> {
  if (cache.has(paramName)) return cache.get(paramName)!
  const res = await ssm.send(new GetParameterCommand({ Name: paramName, WithDecryption: true }))
  const value = res.Parameter?.Value
  if (!value) throw new Error(`SSM parameter not found: ${paramName}`)
  cache.set(paramName, value)
  return value
}

export function clearSecretsCache(): void {
  cache.clear()
}
