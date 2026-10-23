"""Install per-turn spending guards without changing Nova's agent implementation."""
from contextvars import ContextVar
from decimal import Decimal
from functools import wraps
import json
import os
import uuid

from .generation_budget import GenerationBudget, GenerationBudgetExceeded, MAX_GENERATION_COST_USD, input_token_bound

current_budget = ContextVar('brickbuilder_generation_budget', default=None)
current_usage_id = ContextVar('brickbuilder_usage_id', default=None)


def account_usage(budget, reported, speed='standard', *, call_id=None):
    usage = (reported.model_dump() if hasattr(reported, 'model_dump') else dict(reported)) if reported is not None else None
    if budget.model.startswith('claude-') and usage is not None:
        details = usage.get('prompt_tokens_details') or {}
        cached = details.get('cached_tokens', 0) or 0
        written = details.get('cache_creation_tokens', 0) or 0
        usage = {'input_tokens': usage.get('prompt_tokens', 0) - cached - written,
                 'output_tokens': usage.get('completion_tokens', 0),
                 'cache_read_input_tokens': cached, 'cache_creation_input_tokens': written,
                 # Conservatively charge writes as 1h if TTL is not exposed.
                 'cache_creation': {'ephemeral_1h_input_tokens': written},
                 'speed': usage.get('speed') or speed}
    budget.record_usage(usage, 'anthropic' if budget.model.startswith('claude-') else 'openai', call_id=call_id)


def install_cost_limits(agent, llm_config, litellm, claude_agent):
    original_start = agent.start_turn
    original_completion = litellm.acompletion
    original_options = claude_agent.ClaudeAgentOptions
    original_receive = claude_agent.ClaudeSDKClient.receive_response

    @wraps(original_start)
    async def start_turn(store, chat_id, text, llm_model_id, *args, **kwargs):
        entry = llm_config.get(llm_model_id) if llm_model_id else None
        if entry is None:
            _, default_id = llm_config.builder_entries()
            entry = llm_config.get(default_id) if default_id else None
        if entry is None:
            raise ValueError('No model configured for the generation cost limit.')
        # asyncio.create_task inherits this context; every tool round uses one budget.
        budget = GenerationBudget(entry['litellm_params']['model'])
        usage_id = current_usage_id.get()
        if usage_id:
            path = store.chat_dir(chat_id) / f'.brickbuilder-usage-{usage_id}.json'
            def save_usage(records):
                # A hidden, private file survives worker restarts and is excluded
                # from model exports. Each generation gets its own turn totals.
                temporary = path.with_suffix('.tmp')
                with temporary.open('w') as handle:
                    json.dump({'generation_id': usage_id, 'calls': records}, handle)
                    handle.flush()
                    os.fsync(handle.fileno())
                os.replace(temporary, path)
            budget.on_usage = save_usage
            save_usage([])
        token = current_budget.set(budget)
        try:
            return await original_start(store, chat_id, text, llm_model_id, *args, **kwargs)
        finally:
            current_budget.reset(token)

    @wraps(original_completion)
    async def completion(*args, **kwargs):
        # Nova's Settings connection test also calls this adapter, outside an
        # agent turn. Give that one call its own budget and preserve non-streaming.
        budget = current_budget.get() or GenerationBudget(kwargs.get('model', ''))
        requested = kwargs.pop('max_completion_tokens', None) or kwargs.pop('max_tokens', None) or 65536
        bound = input_token_bound({'messages': kwargs.get('messages'), 'tools': kwargs.get('tools')})
        key = 'max_tokens' if budget.model.startswith('claude-') else 'max_completion_tokens'
        # API calls use LiteLLM; native Claude SDK sessions keep their own settings.
        speed = 'fast' if kwargs.get('model') == 'anthropic/claude-opus-5-5' else 'standard'
        if speed == 'fast':
            kwargs['speed'] = speed
        kwargs[key] = budget.output_limit(bound, requested, speed=speed)
        # Automatic retries can charge twice without observable usage.
        kwargs['num_retries'] = 0
        if kwargs.get('stream'):
            kwargs['stream_options'] = {'include_usage': True}
        try:
            stream = await original_completion(*args, **kwargs)
        except Exception as error:
            # Only retry explicit capacity rejections before a stream starts.
            # Never replay a partially consumed or ambiguously failed request.
            if speed != 'fast' or getattr(error, 'status_code', None) not in {429, 529}:
                raise
            speed = 'standard'
            kwargs.pop('speed')
            kwargs[key] = budget.output_limit(bound, requested)
            stream = await original_completion(*args, **kwargs)
        if not kwargs.get('stream'):
            account_usage(budget, getattr(stream, 'usage', None), speed)
            return stream

        call_id = str(uuid.uuid4())
        # LiteLLM hides Anthropic's message_start usage from public chunks.
        # Observe the pinned adapter on this request only, before it discards
        # those early counters. No process-global provider monkeypatch.
        iterator = getattr(stream, 'completion_stream', None)
        handle_usage = getattr(iterator, '_handle_usage', None) if budget.model.startswith('claude-') else None
        raw_usage = {}
        raw_recorded = False
        if callable(handle_usage):
            def capture_usage(anthropic_usage_chunk):
                nonlocal raw_recorded
                result = handle_usage(anthropic_usage_chunk)
                raw_usage.update(anthropic_usage_chunk)
                raw_usage.setdefault('speed', speed)
                if 'input_tokens' in raw_usage and 'output_tokens' in raw_usage:
                    budget.record_usage(raw_usage, 'anthropic', call_id=call_id)
                    raw_recorded = True
                return result
            iterator._handle_usage = capture_usage

        async def limited_stream():
            usage = None
            try:
                async for chunk in stream:
                    reported = getattr(chunk, 'usage', None)
                    if reported is not None:
                        usage = reported
                        # Persist before handing control back to the consumer.
                        # Cumulative updates replace this call rather than add it.
                        if not raw_recorded:
                            account_usage(budget, usage, speed, call_id=call_id)
                    yield chunk
                if usage is None and not raw_recorded:
                    account_usage(budget, usage, speed, call_id=call_id)
            finally:
                if callable(handle_usage):
                    iterator._handle_usage = handle_usage
                close = getattr(stream, 'aclose', None)
                if close:
                    await close()
        return limited_stream()

    def options(*args, **kwargs):
        if current_budget.get() is None:
            raise ValueError('Missing generation cost budget; Claude call stopped.')
        kwargs['max_budget_usd'] = float(MAX_GENERATION_COST_USD)
        return original_options(*args, **kwargs)

    async def receive(client):
        reported = False
        async for event in original_receive(client):
            if isinstance(event, claude_agent.ResultMessage):
                reported = True
                budget = current_budget.get()
                usage = getattr(event, 'usage', None)
                if budget is not None and isinstance(usage, dict) and usage:
                    budget.record_usage(usage, 'anthropic')
                cost = getattr(event, 'total_cost_usd', None)
                if getattr(event, 'subtype', '') == 'error_max_budget_usd':
                    raise GenerationBudgetExceeded()
                if cost is None:
                    raise ValueError('Claude did not report AI cost usage; generation stopped.')
                amount = Decimal(str(cost))
                if not amount.is_finite() or amount < 0:
                    raise ValueError('Claude returned invalid AI cost usage; generation stopped.')
                if amount > MAX_GENERATION_COST_USD:
                    raise GenerationBudgetExceeded()
            yield event
        if not reported:
            raise ValueError('Claude did not report AI cost usage; generation stopped.')

    agent.start_turn = start_turn
    litellm.acompletion = completion
    claude_agent.ClaudeAgentOptions = options
    claude_agent.ClaudeSDKClient.receive_response = receive
