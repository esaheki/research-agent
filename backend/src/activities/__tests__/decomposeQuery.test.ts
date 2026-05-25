import { mockClient } from 'aws-sdk-client-mock'
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm'

const ssmMock = mockClient(SSMClient)

const mockCreate = jest.fn()
jest.mock('@anthropic-ai/sdk', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ messages: { create: mockCreate } })),
}))

import { handler } from '../decomposeQuery'
import { clearSecretsCache } from '../../lib/secrets'

beforeAll(() => {
  process.env.ANTHROPIC_API_KEY_SSM_PATH = '/research-agent/anthropic-api-key'
})

beforeEach(() => {
  clearSecretsCache()
  ssmMock.reset()
  mockCreate.mockReset()
  ssmMock.on(GetParameterCommand).resolves({ Parameter: { Value: 'test-key' } })
})

describe('decomposeQuery', () => {
  it('returns parsed array of sub-queries', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: '["query 1", "query 2", "query 3"]' }],
    })

    const result = await handler({ question: 'What is quantum computing?' })

    expect(result).toEqual(['query 1', 'query 2', 'query 3'])
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-haiku-4-5-20251001' }),
    )
  })

  it('caps output at 5 sub-queries', async () => {
    mockCreate.mockResolvedValue({
      content: [
        { type: 'text', text: '["q1","q2","q3","q4","q5","q6","q7"]' },
      ],
    })

    const result = await handler({ question: 'test' })
    expect(result).toHaveLength(5)
  })

  it('extracts JSON array when model adds surrounding text', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'Here are the queries:\n["a","b","c"]' }],
    })

    const result = await handler({ question: 'test' })
    expect(result).toEqual(['a', 'b', 'c'])
  })

  it('throws when response cannot be parsed', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'sorry, I cannot help' }],
    })

    await expect(handler({ question: 'test' })).rejects.toThrow()
  })

  it('fetches API key from SSM on cold start', async () => {
    mockCreate.mockResolvedValue({ content: [{ type: 'text', text: '["q1"]' }] })

    await handler({ question: 'test' })
    expect(ssmMock.commandCalls(GetParameterCommand)).toHaveLength(1)
  })
})
