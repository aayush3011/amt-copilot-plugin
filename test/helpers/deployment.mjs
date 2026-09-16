export function fixtureDeployment(gatewayBase = 'https://gateway.example/inference/memory') {
  return {
    version: 1, gatewayBase,
    entra: {
      tenantId: '33333333-3333-3333-3333-333333333333',
      clientId: '11111111-1111-1111-1111-111111111111',
      scope: 'api://22222222-2222-2222-2222-222222222222/memory.access',
      redirectUri: 'http://127.0.0.1:0/callback',
    },
  };
}
