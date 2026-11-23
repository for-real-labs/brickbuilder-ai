/**
 * Agents that can build an "All parts" model. Nova is the default and runs in its own service.
 * The others run in the API and are offered only to accounts on the backend's allowlist, which
 * decides what a signed-in account may choose (GET /generation-settings/building-agents).
 */
export const BUILDING_AGENT_LABELS = {
  nova: 'Nova',
  astrology: 'Astrology',
  'fable-claude-fable-5-2': 'Fable · Claude Fable 5.2',
  'fable-gpt-6.2-sol': 'Fable · GPT-6.2 Sol',
  'fable-gpt-6.1-sol': 'Fable · GPT-6.1 Sol',
  'fable-lean-claude-fable-5-2': 'Fable Lean · Claude Fable 5.2',
  'fable-lean-low-claude-fable-5-2': 'Fable Lean · Claude Fable 5.2 (low effort)',
  'fable-lean-gpt-6.1-sol': 'Fable Lean · GPT-6.1 Sol',
} as const;

export type BuildingAgent = keyof typeof BUILDING_AGENT_LABELS;
export type InProcessAgent = Exclude<BuildingAgent, 'nova'>;

export const isBuildingAgent = (value: unknown): value is BuildingAgent =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(BUILDING_AGENT_LABELS, value);

/** The agent when it is not Nova: such builds have no Nova source, resume or provider connection. */
export const inProcessAgent = (value: unknown): InProcessAgent | undefined =>
  isBuildingAgent(value) && value !== 'nova' ? value : undefined;
