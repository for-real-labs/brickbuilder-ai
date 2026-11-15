"""Recognize explicit total-piece budgets without a classifier/model call."""
import re

_WORDS = {
    'zero': 0, 'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5,
    'six': 6, 'seven': 7, 'eight': 8, 'nine': 9, 'ten': 10, 'eleven': 11,
    'twelve': 12, 'thirteen': 13, 'fourteen': 14, 'fifteen': 15, 'sixteen': 16,
    'seventeen': 17, 'eighteen': 18, 'nineteen': 19, 'twenty': 20, 'thirty': 30,
    'forty': 40, 'fifty': 50, 'sixty': 60, 'seventy': 70, 'eighty': 80, 'ninety': 90,
}
_NUMBER = r"(?:\d{1,3}(?:,\d{3})+|\d+|(?:(?:" + '|'.join(_WORDS) + r"|hundred|thousand)(?:[ -]+and)?[ -]*)+)"
_UNIT = r"(?:pieces?|bricks?|parts?)"
_PREFIX = r"(?:no\s+more\s+than|not\s+more\s+than|at\s+most|up\s+to|limit(?:ed)?(?:\s+(?:it|the model))?\s+(?:to|of)|maximum(?:\s+of)?|max(?:imum)?\s*[:=]?|under|below|less\s+than|fewer\s+than|(?:use|using|with|of|only|exactly)\s+(?:only\s+|exactly\s+)?)"
_BUDGET = re.compile(r"\b(?P<prefix>" + _PREFIX + r")\s*(?P<number>" + _NUMBER + r")\s*(?:LEGO\s+)?(?:physical\s+)?(?P<unit>" + _UNIT + r")\b", re.I)
_SUFFIX = re.compile(r"(?<![\w.,-])(?P<number>" + _NUMBER + r")\s*(?:LEGO\s+)?(?:physical\s+)?"+_UNIT+r"\s+(?:or\s+(?:fewer|less)|max(?:imum)?|at\s+most)\b", re.I)
_NEGATION = re.compile(r"(?:don't|do not|not|no|never|avoid|minimum|min|at least|more than|over)\s*$", re.I)

PARTS_BUDGET_GUIDANCE = (
    "TOTAL PIECE BUDGETS: Treat explicit requests to use N pieces/bricks/parts as a total physical-parts "
    "budget and design toward that count. Under/fewer than N means at most N-1. The configured maximum "
    "is mandatory and may be stricter than the prompt; never raise it. Count physical placements, not "
    "embedded geometry. Per-part inventory quantities are additional independent limits. Simplify and "
    "validate the complete model against both limits before finishing."
)


def tighter_parts_limit(*limits: int | None) -> int | None:
    present = [value for value in limits if value is not None]
    return min(present) if present else None


def _number(text: str) -> int:
    if text[0].isdigit():
        return int(text.replace(',', ''))
    total = group = 0
    for word in re.split(r'[ -]+', text.strip().lower()):
        if word == 'and':
            continue
        if word == 'hundred':
            group = (group or 1) * 100
        elif word == 'thousand':
            total += (group or 1) * 1000
            group = 0
        else:
            group += _WORDS[word]
    return total + group


def prompt_parts_limit(prompt: str | None) -> int | None:
    limits = []
    for pattern in (_BUDGET, _SUFFIX):
        for match in pattern.finditer(prompt or ''):
            before = (prompt or '')[:match.start()]
            after = (prompt or '')[match.end():]
            # Don't mistake a negation, minimum, per-component count, or an inventory
            # statement for a total-model budget.
            if _NEGATION.search(before) or re.match(r'\s+(?:per|each|for each|on each|in each|or more|or greater)\b', after, re.I):
                continue
            if ' '.join(match.groupdict().get('prefix', '').lower().split()) in {'with', 'of'} and re.search(r'\b(?:set|box|bag|inventory|collection)\s*$', before, re.I):
                continue
            count = _number(match['number'])
            prefix = ' '.join(match.groupdict().get('prefix', '').lower().split())
            if prefix in {'under', 'below', 'less than', 'fewer than'}:
                count -= 1
            if not 1 <= count <= 100_000:
                raise ValueError('The requested piece limit must allow between 1 and 100,000 pieces.')
            limits.append(count)
    return tighter_parts_limit(*limits)
