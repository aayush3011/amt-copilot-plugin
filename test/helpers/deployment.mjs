export function fixtureDeployment(gatewayBase = 'https://gateway.example/inference/memory') {
  return {
    version: 1, gatewayBase,
    entra: {
      tenantId: '33333333-3333-3333-3333-333333333333',
      scope: 'https://dbinference.azure.com/.default',
    },
  };
}
