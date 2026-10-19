const MODEL_FACT_HISTORY_KEY = 'brickbuilder.model-fact-history';
const MAX_MODELS = 20;
const MAX_FACTS = 8;

type FactHistory = Record<string, string[]>;

function readHistory(): FactHistory {
  try {
    const saved = JSON.parse(localStorage.getItem(MODEL_FACT_HISTORY_KEY) || '{}');
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return Object.create(null);
    const history: FactHistory = Object.create(null);
    for (const [id, facts] of Object.entries(saved).slice(-MAX_MODELS)) {
      if (Array.isArray(facts)) history[id] = facts.filter((fact): fact is string => typeof fact === 'string'
        && !!fact.trim() && fact.length <= 240).slice(-MAX_FACTS);
    }
    return history;
  } catch { return Object.create(null); }
}

export function recentModelFacts(modelId: string): string[] {
  return readHistory()[modelId] || [];
}

export function rememberModelFact(modelId: string, fact: string): void {
  if (!/^(Fun fact:|Did you know\b|Here’s something neat:)/.test(fact) || fact.length > 240) return;
  try {
    const history = readHistory();
    const facts = (history[modelId] || []).filter(previous => previous !== fact);
    delete history[modelId];
    history[modelId] = [...facts, fact].slice(-MAX_FACTS);
    const ids = Object.keys(history);
    for (const id of ids.slice(0, -MAX_MODELS)) delete history[id];
    localStorage.setItem(MODEL_FACT_HISTORY_KEY, JSON.stringify(history));
  } catch { /* Facts can still load when browser storage is unavailable. */ }
}
