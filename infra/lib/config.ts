// Central place for resource names and SSM parameter paths.
// SecureString params must be created manually via CLI before deploying ComputeStack — see README.
export const SSM = {
  TAVILY_API_KEY: '/research-agent/tavily-api-key',               // SecureString
  ANTHROPIC_API_KEY: '/research-agent/anthropic-api-key',         // SecureString
  GOOGLE_CLIENT_ID: '/research-agent/google-client-id',           // String
  GOOGLE_CLIENT_SECRET: '/research-agent/google-client-secret',   // SecureString
  ADMIN_EMAIL: '/research-agent/admin-email',                     // String
  EXISTING_CF_DISTRIBUTION_ID: '/research-agent/existing-cloudfront-distribution-id', // String
} as const
