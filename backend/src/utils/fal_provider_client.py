"""Create fal clients bound to this project's current key for each operation."""
import os

import fal_client


def get_fal_client() -> fal_client.SyncClient:
    # fal_client's module-level helpers retain cached Authorization headers.
    # A new bound client lets local key changes take effect without restarting
    # or interrupting clients already serving an in-flight generation.
    key = os.getenv("FAL_KEY")
    if not key:
        raise ValueError("FAL_KEY is not configured")
    return fal_client.SyncClient(key=key)
