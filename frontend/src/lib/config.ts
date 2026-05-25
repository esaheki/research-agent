export const config = {
  httpApiUrl: import.meta.env.VITE_HTTP_API_URL as string,
  wsApiUrl: import.meta.env.VITE_WS_API_URL as string,
  cognitoDomain: import.meta.env.VITE_COGNITO_DOMAIN as string,
  cognitoClientId: import.meta.env.VITE_COGNITO_CLIENT_ID as string,
  cognitoRedirectUri:
    (import.meta.env.VITE_COGNITO_REDIRECT_URI as string | undefined) ??
    `${window.location.origin}/research/callback`,
}
