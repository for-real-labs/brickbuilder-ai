import { afterEach, describe, expect, it, vi } from 'vitest';
import { BUILDING_AGENT_LABELS, inProcessAgent, isBuildingAgent } from '../src/utils/buildingAgents';
import { NovaToBricksApiService } from '../src/services/novaToBricksApi';

describe('building agents', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('names every agent and treats everything but Nova as built in the API', () => {
    expect(BUILDING_AGENT_LABELS['fable-claude-fable-5-2']).toBe('Fable · Claude Fable 5.2');
    expect(BUILDING_AGENT_LABELS['fable-lean-gpt-6.1-sol']).toBe('Fable Lean · GPT-6.1 Sol');
    expect(BUILDING_AGENT_LABELS['fable-lean-gpt-6.2-sol']).toBe('Fable Lean · GPT-6.2 Sol');
    expect(BUILDING_AGENT_LABELS['fable-thorough-v2-gpt-6.2-sol']).toBe('Fable Thorough v2 · GPT-6.2 Sol');
    expect(BUILDING_AGENT_LABELS['fable-lean-v2-gpt-6.2-sol']).toBe('Fable Lean v2 · GPT-6.2 Sol');
    expect(BUILDING_AGENT_LABELS['fable-gpt-6.2-sol']).toBe('Fable · GPT-6.2 Sol');
    expect(BUILDING_AGENT_LABELS['fable-lean-low-claude-fable-5-2']).toBe('Fable Lean · Claude Fable 5.2 (low effort)');
    expect(Object.keys(BUILDING_AGENT_LABELS).filter(agent => agent.startsWith('fable-'))).toHaveLength(9);
    expect(inProcessAgent('astrology')).toBe('astrology');
    expect(inProcessAgent('fable-gpt-6.2-sol')).toBe('fable-gpt-6.2-sol');
    for (const other of ['nova', 'toString', 'fable-unknown', undefined, null, 7]) {
      expect(inProcessAgent(other)).toBeUndefined();
    }
    expect(isBuildingAgent('nova')).toBe(true);
    expect(isBuildingAgent('constructor')).toBe(false);
  });

  it('offers only agents the backend lists and this app knows, and always Nova', async () => {
    const reply = (body: unknown, ok = true) => vi.stubGlobal('fetch', vi.fn(async () => ({
      ok, status: ok ? 200 : 500, json: async () => body, headers: new Headers(),
    })));
    const signal = new AbortController().signal;

    reply({ agents: ['nova', 'astrology', 'fable-gpt-6.1-sol', 'agent-from-the-future', 42] });
    expect(await NovaToBricksApiService.buildingAgents('token', signal)).toEqual(['nova', 'astrology', 'fable-gpt-6.1-sol']);
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(String(url)).toContain('/generation-settings/building-agents');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer token');

    reply({ agents: ['fable-gpt-6.2-sol'] });
    expect(await NovaToBricksApiService.buildingAgents('token', signal)).toEqual(['nova', 'fable-gpt-6.2-sol']);
    reply({ agents: 'nova' });
    expect(await NovaToBricksApiService.buildingAgents('token', signal)).toEqual(['nova']);
    reply({}, false);
    expect(await NovaToBricksApiService.buildingAgents('token', signal)).toEqual(['nova']);
  });
});
