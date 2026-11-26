import { afterEach, describe, expect, it, vi } from 'vitest';
import { AGENT_MODEL_LABELS, BUILDING_AGENT_LABELS, inProcessAgent, isAgentModel, isBuildingAgent } from '../src/utils/buildingAgents';
import { NovaToBricksApiService } from '../src/services/novaToBricksApi';

describe('building agents', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('names every agent and treats everything but Nova as built in the API', () => {
    expect(BUILDING_AGENT_LABELS['fable-claude-fable-5-2']).toBe('Fable · Claude Fable 5.2');
    expect(BUILDING_AGENT_LABELS['fable-lean-gpt-6.1-sol']).toBe('Fable Lean · GPT-6.1 Sol');
    expect(BUILDING_AGENT_LABELS['fable-lean-gpt-6.2-sol']).toBe('Fable Lean · GPT-6.2 Sol');
    expect(BUILDING_AGENT_LABELS['fable-thorough-v2-gpt-6.2-sol']).toBe('Fable Thorough v2 · GPT-6.2 Sol');
    expect(BUILDING_AGENT_LABELS['pip-agent']).toBe('Pip agent');
    expect(BUILDING_AGENT_LABELS['fable-lean-v2-gpt-6.2-sol']).toBe('Pip agent (first release)');
    expect(inProcessAgent('pip-agent')).toBe('pip-agent');
    expect(Object.keys(AGENT_MODEL_LABELS)).toEqual(['gpt-6.2-sol', 'gpt-6.2-astra', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-2']);
    expect(isAgentModel('claude-opus-5-5')).toBe(true);
    expect(isAgentModel('gpt-6.1-sol')).toBe(false);
    expect(isAgentModel('toString')).toBe(false);
    expect(BUILDING_AGENT_LABELS['fable-gpt-6.2-sol']).toBe('Fable · GPT-6.2 Sol');
    expect(BUILDING_AGENT_LABELS['fable-lean-low-claude-fable-5-2']).toBe('Fable Lean · Claude Fable 5.2 (low effort)');
    expect(Object.keys(BUILDING_AGENT_LABELS).filter(agent => agent.startsWith('fable-'))).toHaveLength(9);
    expect(Object.keys(BUILDING_AGENT_LABELS)).toHaveLength(12);
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
    expect(await NovaToBricksApiService.buildingAgents('token', signal)).toEqual({ agents: ['nova', 'astrology', 'fable-gpt-6.1-sol'], models: {}, examples: [] });
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(String(url)).toContain('/generation-settings/building-agents');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer token');

    reply({ agents: ['fable-gpt-6.2-sol'] });
    expect(await NovaToBricksApiService.buildingAgents('token', signal)).toEqual({ agents: ['nova', 'fable-gpt-6.2-sol'], models: {}, examples: [] });
    reply({ agents: 'nova' });
    expect(await NovaToBricksApiService.buildingAgents('token', signal)).toEqual({ agents: ['nova'], models: {}, examples: [] });
    reply({}, false);
    expect(await NovaToBricksApiService.buildingAgents('token', signal)).toEqual({ agents: ['nova'], models: {}, examples: [] });
    // Models are kept only for listed agents, and only models this app knows.
    reply({ agents: ['nova', 'pip-agent'], models: {
      'pip-agent': ['gpt-6.2-sol', 'claude-opus-5-5', 'model-from-the-future'], 'fable-gpt-6.1-sol': ['gpt-6.2-sol'],
    } });
    expect(await NovaToBricksApiService.buildingAgents('token', signal)).toEqual({
      agents: ['nova', 'pip-agent'], models: { 'pip-agent': ['gpt-6.2-sol', 'claude-opus-5-5'] }, examples: [] });
    reply({ agents: ['pip-agent'], models: 'all' });
    expect(await NovaToBricksApiService.buildingAgents('token', signal)).toEqual({ agents: ['nova', 'pip-agent'], models: {}, examples: [] });
    // Example builds are offered only for listed agents this app knows.
    reply({ agents: ['nova', 'pip-agent'], examples: ['pip-agent', 'fable-gpt-6.1-sol', 'agent-from-the-future', 7] });
    expect(await NovaToBricksApiService.buildingAgents('token', signal)).toEqual({
      agents: ['nova', 'pip-agent'], models: {}, examples: ['pip-agent'] });
    reply({ agents: ['nova', 'pip-agent'], examples: 'all' });
    expect((await NovaToBricksApiService.buildingAgents('token', signal)).examples).toEqual([]);
  });

  it('sends the examples setting only when it is on', async () => {
    const sent = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ generation_id: 'g', message: 'ok' }), headers: new Headers() }));
    vi.stubGlobal('fetch', sent);
    const request = { model: 'claude-opus-5-5', authMode: 'api_key' as const, prompt: 'A red boat', buildingAgent: 'pip-agent' as const };
    await NovaToBricksApiService.generate({ ...request, useExamples: true }, 'token');
    await NovaToBricksApiService.generate(request, 'token');
    const bodies = sent.mock.calls.map(call => JSON.parse(String((call as unknown as [string, RequestInit])[1].body)));
    expect(bodies[0].use_examples).toBe(true);
    expect('use_examples' in bodies[1]).toBe(false);
  });
});
