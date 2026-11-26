export function isAllPartsAgentEndpoint(endpoint?: string | null): boolean {
  return endpoint === 'novaToBricks' || endpoint === 'pipModelCall';
}

export function isAgentGeneration(endpoint?: string): boolean {
  return endpoint === 'llmToBricks' || isAllPartsAgentEndpoint(endpoint);
}
