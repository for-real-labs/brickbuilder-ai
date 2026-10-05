import React from 'react';
import { Bot } from 'lucide-react';
import posthog from 'posthog-js';
import { LLM_MODEL_OPTIONS, getLlmModelOption, type LlmProvider } from '../services/llmToBricksApi';
import type { NovaBuilderOptions as NovaOptions } from '../services/novaToBricksApi';

export function NovaBuilderOptions({ options, onChange, local, disabled = false }: {
  options: NovaOptions;
  onChange: (options: NovaOptions) => void;
  local: boolean;
  disabled?: boolean;
}) {
  const provider = getLlmModelOption(options.model)?.provider || 'anthropic';
  const update = <K extends keyof NovaOptions>(key: K, value: NovaOptions[K]) => {
    posthog.capture('landing_nova_option_changed', { option: key, value, provider });
    onChange({ ...options, [key]: value });
  };
  return <section aria-label="Full set agent options" className="w-full max-w-xl rounded-2xl border border-red-100 bg-white p-4 text-left shadow-sm">
    <div className="flex items-start gap-3">
      <div className="rounded-xl bg-red-50 p-2"><Bot aria-hidden="true" className="h-5 w-5 text-red-500" /></div>
      <div className="min-w-0"><h2 className="text-sm font-semibold text-slate-900">Nova full set agent</h2>
        <p className="mt-1 text-xs leading-5 text-slate-500">Uses Nova’s own agent, tools, rendering, and build workflow. Describe your model or add a reference image. Results and follow-up edits are saved in BrickBuilder.</p>
      </div>
    </div>
    <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
      <label className="text-xs font-medium text-slate-600" htmlFor="nova-provider">Provider
        <select id="nova-provider" value={provider} disabled={disabled} className="mt-1.5 min-h-10 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm font-normal text-slate-800" onChange={event => {
          const next = event.target.value as LlmProvider;
          const model = LLM_MODEL_OPTIONS.find(option => option.provider === next)!.id;
          posthog.capture('landing_nova_provider_selected', { provider: next });
          onChange({ ...options, model });
        }}><option value="anthropic">Anthropic · Claude</option><option value="openai">OpenAI · ChatGPT</option></select>
      </label>
      <label className="text-xs font-medium text-slate-600" htmlFor="nova-model">Agent model
        <select id="nova-model" value={options.model} disabled={disabled} className="mt-1.5 min-h-10 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm font-normal text-slate-800" onChange={event => update('model', event.target.value)}>
          {LLM_MODEL_OPTIONS.filter(option => option.provider === provider).map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
        </select>
      </label>
      {local && <label className="text-xs font-medium text-slate-600 sm:col-span-2" htmlFor="nova-connection">Provider connection
        <select id="nova-connection" value={options.authMode} disabled={disabled} className="mt-1.5 min-h-10 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm font-normal text-slate-800" onChange={event => update('authMode', event.target.value as NovaOptions['authMode'])}><option value="api_key">Project API key</option><option value="native">{provider === 'openai' ? 'Signed in to ChatGPT' : 'Signed in to Claude'} · local account</option></select>
        <span className="mt-1.5 block font-normal leading-5 text-slate-500">Connect your account or attach a key in Local provider connections below.</span>
      </label>}
    </div>
    <p className="mt-3 text-xs leading-5 text-slate-500">Nova runs automatically and can execute build scripts in its isolated workspace. Search uses Jev when configured. Complex models can take several minutes.</p>
  </section>;
}
