COMMUNITY_LIKES_MIGRATION_REQUIRED_MESSAGE = (
    "Community likes are temporarily unavailable until the latest database migration is applied."
)


def is_community_likes_schema_error(error: Exception) -> bool:
    message = str(error).lower()
    return "does not exist" in message and (
        "generation_likes" in message or "like_count" in message
    )
