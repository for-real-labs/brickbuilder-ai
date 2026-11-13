"""Limits count physical placements, never embedded part geometry."""
from .parts_catalog import flat_model_inventory


def enforce_parts_limit(ldr: str, maximum: int | None) -> None:
    if maximum is None:
        return
    count = sum(flat_model_inventory(ldr).values())
    if count > maximum:
        raise ValueError(f"Model has {count} physical parts; maximum is {maximum}. Simplify the model.")
