/**
 * Agents that can build an "All parts" model. The Pip agent is the default for every account. Nova
 * runs in its own service; the others run in the API. Choosing an agent or a model is offered only
 * to accounts on the backend's allowlist (GET /generation-settings/building-agents).
 */
export const BUILDING_AGENT_LABELS = {
  nova: 'Nova',
  astrology: 'Astrology',
  'fable-claude-fable-5-2': 'Fable · Claude Fable 5.2',
  'fable-gpt-6.2-sol': 'Fable · GPT-6.2 Sol',
  'fable-thorough-v2-gpt-6.2-sol': 'Fable Thorough v2 · GPT-6.2 Sol',
  'fable-gpt-6.1-sol': 'Fable · GPT-6.1 Sol',
  'fable-lean-claude-fable-5-2': 'Fable Lean · Claude Fable 5.2',
  'fable-lean-low-claude-fable-5-2': 'Fable Lean · Claude Fable 5.2 (low effort)',
  'fable-lean-gpt-6.2-sol': 'Fable Lean · GPT-6.2 Sol',
  'pip-agent': 'Pip agent',
  // Pip's first release, no longer offered for new builds; kept so its builds still show who built them.
  'fable-lean-v2-gpt-6.2-sol': 'Pip agent (first release)',
  'fable-lean-gpt-6.1-sol': 'Fable Lean · GPT-6.1 Sol',
} as const;

export type BuildingAgent = keyof typeof BUILDING_AGENT_LABELS;

export const DEFAULT_BUILDING_AGENT: BuildingAgent = 'pip-agent';
export function allPartsAgentEndpoint(agent: BuildingAgent = DEFAULT_BUILDING_AGENT) {
  return agent === 'pip-agent' || agent === 'fable-lean-v2-gpt-6.2-sol' ? 'pipModelCall' : 'novaToBricks';
}

export type InProcessAgent = Exclude<BuildingAgent, 'nova'>;

export const isBuildingAgent = (value: unknown): value is BuildingAgent =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(BUILDING_AGENT_LABELS, value);

/** Models an agent may offer a choice of (the Pip agent). The backend decides which each agent offers. */
export const AGENT_MODEL_LABELS = {
  'gpt-6.2-sol': 'GPT-6.2 Sol',
  'gpt-6.2-astra': 'GPT-6.2 Astra',
  'claude-opus-5-5': 'Claude Opus 5.5',
  'claude-sonnet-5-5': 'Claude Sonnet 5.5',
  'claude-fable-5-2': 'Claude Fable 5.2',
} as const;

export type AgentModel = keyof typeof AGENT_MODEL_LABELS;

export const isAgentModel = (value: unknown): value is AgentModel =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(AGENT_MODEL_LABELS, value);

/** The agent when it is not Nova: such builds have no Nova source, resume or provider connection. */
export const inProcessAgent = (value: unknown): InProcessAgent | undefined =>
  isBuildingAgent(value) && value !== 'nova' ? value : undefined;
