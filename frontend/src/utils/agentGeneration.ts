export function isAgentGeneration(endpoint?: string): boolean {
  return endpoint === 'llmToBricks' || endpoint === 'novaToBricks';
}
