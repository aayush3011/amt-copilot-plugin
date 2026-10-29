export function fixtureDeployment(gatewayBase = 'https://gateway.example/inference/memory') {
  return {
    version: 1, gatewayBase,
    entra: {
      tenantId: '33333333-3333-3333-3333-333333333333',
      clientId: '44444444-4444-4444-4444-444444444444',
      scope: 'https://dbinference.azure.com/.default',
      mcpScope: 'api://inference-service-mcp/Logs.Read',
      redirectUri: 'http://127.0.0.1:33418',
    },
  };
}
