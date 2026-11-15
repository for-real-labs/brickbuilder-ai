import pytest
from pydantic import ValidationError
from src.utils.prompt_parts_limit import prompt_parts_limit, tighter_parts_limit
from src.requests.llmToBricks import LlmToBricksRequest, _design_system_prompt, _direct_system_prompt
from src.requests.novaToBricks import NovaToBricksRequest


@pytest.mark.parametrize('prompt,maximum', [
    ('Build a castle using 100 pieces', 100),
    ('Build a piano using 100 pieces', 100),
    ('Make a rover with 100 parts', 100),
    ('Use 1,000 LEGO bricks for a castle', 1000),
    ('Make a car under 100 pieces', 99),
    ('Use fewer than 50 parts', 49),
    ('Use less   than 50 physical parts', 49),
    ('No more than 200 pieces', 200),
    ('At most 80 bricks', 80),
    ('Limit it to 80 bricks', 80),
    ('Limited to 80 bricks', 80),
    ('Use exactly 75 pieces', 75),
    ('A castle with only 120 pieces', 120),
    ('A model of 20 bricks', 20),
    ('A car, 100 pieces or fewer', 100),
    ('Build it using one hundred and fifty pieces', 150),
    ('Keep it below twenty-five pieces', 24),
    ('Maximum: 250 bricks', 250),
    ('Use 200 pieces, but keep it under 100 bricks', 99),
])
def test_explicit_piece_budgets(prompt, maximum):
    assert prompt_parts_limit(prompt) == maximum


@pytest.mark.parametrize('prompt', [
    'Build set 100 with 4 wheels',
    'Under 100 dollars, with 20 windows',
    'Use at least 100 pieces',
    'Use 100 pieces or more',
    'No fewer than 100 pieces',
    'A minimum of 100 pieces',
    'Do not use 100 pieces',
    "Don't use 100 bricks",
    'Not under 100 pieces',
    'A box with 100 pieces and a red car',
    'A set of 100 pieces',
    'Use 10 pieces per wheel',
    'Use 10 pieces for each leg',
    'Use 2.5 pieces',
    'A model weighing 100 grams',
    'More than 100 pieces max',
])
def test_unrelated_minimum_negated_and_component_counts_are_not_total_caps(prompt):
    assert prompt_parts_limit(prompt) is None


@pytest.mark.parametrize('request_type', [LlmToBricksRequest, NovaToBricksRequest])
def test_both_modes_apply_prompt_budget_without_extra_model_call(request_type):
    assert request_type(prompt='Use 100 pieces').max_parts == 100
    assert request_type(prompt='Under 100 pieces', max_parts=200).max_parts == 99
    assert request_type(prompt='Use 100 pieces', max_parts=20).max_parts == 20
    assert request_type(prompt='Build a red castle').max_parts is None
    for prompt in ('Use 0 pieces', 'Under 1 piece', 'Use 100001 pieces'):
        with pytest.raises(ValidationError):
            request_type(prompt=prompt)


def test_prompt_guidance_is_shared_by_basic_generation_paths():
    request = LlmToBricksRequest(prompt='Use 50 pieces')
    for build_prompt in (_design_system_prompt, _direct_system_prompt):
        text = build_prompt(request)
        assert 'TOTAL PIECE BUDGETS' in text
        assert 'at most 50' in text


def test_tighter_limit_never_relaxes_existing_cap():
    assert tighter_parts_limit(100, 30) == 30
    assert tighter_parts_limit(None, 30) == 30
    assert tighter_parts_limit(None, None) is None
