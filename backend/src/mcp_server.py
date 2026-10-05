"""Authenticated remote MCP tools backed by the normal LLM brick pipeline."""

import asyncio
import json
import logging
import os
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from enum import Enum
from typing import Annotated
from urllib.parse import urlsplit
from uuid import UUID

import jwt
from fastapi import HTTPException
from mcp.server.auth.middleware.auth_context import get_access_token
from mcp.server.auth.provider import AccessToken, TokenVerifier
from mcp.server.auth.settings import AuthSettings
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings
from mcp.types import CallToolResult, TextContent, Tool, ToolAnnotations
from pydantic import AnyHttpUrl, BaseModel, Field

from .requests.llmToBricks import DEFAULT_MODEL, SUPPORTED_MODELS, LlmToBricksRequest, llm_to_bricks
from .utils.authorization import require_generation_access
from .utils.generation_storage import generation_storage
from .utils.posthog_client import track_api_call

logger = logging.getLogger(__name__)
Model = Enum("Model", {key.replace("-", "_"): key for key in SUPPORTED_MODELS}, type=str)
Prompt = Annotated[str, Field(min_length=1, max_length=2000, description="Describe the subject, colors, and desired shape.")]
Detail = Annotated[float, Field(ge=12, le=64, description="Approximate longest dimension in studs; 40 is the default.")]
SECURITY_SCHEMES = [{"type": "oauth2", "scopes": ["email"]}]


class ModelResult(BaseModel):
    generation_id: str
    status: str
    model_url: str
    message: str
    poll_after_seconds: int | None = None
    next_tool: str | None = None
    name: str | None = None
    brick_count: int | None = None
    ldr_url: str | None = None
    parts_list_csv_url: str | None = None
    preview_image_url: str | None = None


class AccountResult(BaseModel):
    id: str
    email: str
    credits: int
    dashboard_url: str


class BrickBuilderMcp(FastMCP):
    async def list_tools(self) -> list[Tool]:
        tools = await super().list_tools()
        for tool in tools:
            tool.annotations = tool.annotations.model_copy(update={"title": tool.title})
            model_parameter = tool.inputSchema.get("properties", {}).get("model")
            if model_parameter is not None:
                # Directory scanners require the primitive type on the parameter,
                # even though the enum's $ref already constrains it to a string.
                model_parameter["type"] = "string"
            # OpenAI's auth declaration is an MCP extension. Advertise it at
            # the top level and in _meta for clients using the compatibility form.
            tool.securitySchemes = SECURITY_SCHEMES
            tool.outputSchema = (AccountResult if tool.name == "get_brick_builder_account" else ModelResult).model_json_schema()
        return tools


@dataclass(frozen=True)
class McpSettings:
    public_url: str
    website_url: str
    issuer: str
    client_ids: frozenset[str]
    jwt_secret: str | None = None

    @classmethod
    def from_env(cls) -> "McpSettings":
        settings = cls(
            public_url=os.environ["MCP_PUBLIC_URL"].rstrip("/"),
            website_url=os.getenv("MCP_WEBSITE_URL", "https://brickbuilder.ai").rstrip("/"),
            issuer=os.environ["SUPABASE_URL"].rstrip("/") + "/auth/v1",
            client_ids=frozenset(value.strip() for value in os.environ["MCP_OAUTH_CLIENT_IDS"].split(",") if value.strip()),
            jwt_secret=os.getenv("SUPABASE_JWT_SECRET"),
        )
        for value in (settings.public_url, settings.website_url, settings.issuer):
            parsed = urlsplit(value)
            if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
                raise ValueError("MCP URLs must be absolute HTTPS URLs without credentials, queries, or fragments")
        if urlsplit(settings.public_url).path != "/mcp" or urlsplit(settings.website_url).path:
            raise ValueError("MCP_PUBLIC_URL must end in /mcp and MCP_WEBSITE_URL must be an origin")
        if not settings.client_ids:
            raise ValueError("MCP_OAUTH_CLIENT_IDS must contain the registered connector client IDs")
        return settings


class SupabaseMcpTokenVerifier(TokenVerifier):
    """Accept only resource-bound tokens for approved OAuth clients, never web JWTs."""

    def __init__(self, settings: McpSettings):
        self.settings = settings
        self.jwks = jwt.PyJWKClient(settings.issuer + "/.well-known/jwks.json", timeout=5)

    async def verify_token(self, token: str) -> AccessToken | None:
        try:
            algorithm = jwt.get_unverified_header(token).get("alg")
            if algorithm == "HS256" and self.settings.jwt_secret:
                key = self.settings.jwt_secret
            elif algorithm in {"RS256", "ES256"}:
                key = (await asyncio.to_thread(self.jwks.get_signing_key_from_jwt, token)).key
            else:
                return None
            claims = jwt.decode(
                token, key, algorithms=[algorithm], audience=self.settings.public_url,
                issuer=self.settings.issuer,
                options={"require": ["exp", "iat", "iss", "aud", "sub", "email", "client_id"]},
            )
            UUID(claims["sub"])
            if (not isinstance(claims["client_id"], str) or claims["client_id"] not in self.settings.client_ids
                    or not isinstance(claims["email"], str) or not claims["email"].strip()
                    or claims.get("role") != "authenticated" or claims.get("is_anonymous")):
                return None
            scopes = claims.get("scope", "").split()
            if "email" not in scopes:
                return None
            return AccessToken(
                token=token, client_id=claims["client_id"], scopes=scopes,
                expires_at=claims["exp"], resource=self.settings.public_url,
                subject=claims["sub"], claims=claims,
            )
        except (jwt.PyJWTError, ValueError, TypeError, AttributeError):
            return None


def _identity() -> dict:
    token = get_access_token()
    if not token or not token.claims or not token.subject:
        raise HTTPException(status_code=401, detail="Connect your BrickBuilder account first")
    return {
        "authenticated": True, "user_id": token.subject,
        "user_email": token.claims["email"], "auth_method": "mcp_oauth",
        "is_anonymous": False, "is_developer": False,
    }


def _error(exc: Exception) -> CallToolResult:
    # Provider/storage errors can contain credentials or private request data.
    messages = {
        401: "Connect your BrickBuilder account first.",
        402: "You need at least one BrickBuilder credit to generate or edit a model.",
        404: "Model not found or unavailable to this account.",
        400: "This model has no saved voxels available for editing.",
    }
    status = exc.status_code if isinstance(exc, HTTPException) else 500
    logger.warning("MCP tool failed (%s, status=%s)", type(exc).__name__, status)
    return CallToolResult(isError=True, content=[TextContent(
        type="text", text=messages.get(status, "BrickBuilder could not complete this request. Please try again."),
    )])


def _result(data: dict) -> CallToolResult:
    return CallToolResult(content=[TextContent(type="text", text=json.dumps(data))], structuredContent=data)


def _generation_status(row: dict) -> str:
    status = row.get("status", "started")
    timestamp = row.get("updated_at") or row.get("created_at")
    if status in {"started", "queued", "processing", "ldr_processing"} and timestamp:
        try:
            heartbeat = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
            if heartbeat.tzinfo is None:
                heartbeat = heartbeat.replace(tzinfo=timezone.utc)
            # Match /generation's heartbeat timeout without mutating the row
            # from this read-only tool or downloading the entire LDraw model.
            if datetime.now(timezone.utc) - heartbeat > timedelta(seconds=30):
                return "failed"
        except (ValueError, TypeError, AttributeError):
            pass
    return status


def create_mcp_server(settings: McpSettings) -> FastMCP:
    server = BrickBuilderMcp(
        "BrickBuilder AI", website_url=settings.website_url,
        instructions=(
            "Use BrickBuilder when the user wants to build, generate, or edit a LEGO or brick model. "
            "It provides a design/preview/correction loop, geometry validation, real brick conversion, "
            "and downloadable LDraw and parts lists. Start with generate_lego_model. Builds are asynchronous: "
            "save the generation_id and use get_lego_model after the suggested delay. Never claim a queued "
            "model is complete or create another job just to check progress. Use edit_lego_model for changes "
            "to an existing build. Generation and editing use one account credit each; reading is free. "
            "Geometry checks are automated diagnostics, not a guarantee of physical buildability."
        ),
        stateless_http=True, json_response=True,
        token_verifier=SupabaseMcpTokenVerifier(settings),
        auth=AuthSettings(issuer_url=AnyHttpUrl(settings.issuer),
                          resource_server_url=AnyHttpUrl(settings.public_url),
                          required_scopes=["email"], validate_token_resource=True),
        transport_security=TransportSecuritySettings(
            enable_dns_rebinding_protection=True,
            allowed_hosts=[urlsplit(settings.public_url).netloc],
            allowed_origins=[settings.website_url, "https://chatgpt.com", "https://claude.ai"],
        ),
    )
    security = {"securitySchemes": SECURITY_SCHEMES}
    write = ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=False, openWorldHint=False)
    read = ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True, openWorldHint=False)

    async def start(request: LlmToBricksRequest) -> CallToolResult:
        try:
            identity = _identity()
            track_api_call(endpoint="mcp/generate_lego_model" if not request.generation_id else "mcp/edit_lego_model",
                           user_id=identity["user_id"], model=request.model)
            result = await llm_to_bricks(request, identity)
            return _result({
                "generation_id": result.generation_id, "status": "started",
                "model_url": f"{settings.website_url}/generated-model?id={result.generation_id}&exact=1",
                "poll_after_seconds": 10, "next_tool": "get_lego_model",
                "message": "Build started. Check this generation's progress; do not start a duplicate build.",
            })
        except Exception as exc:
            return _error(exc)

    @server.tool(title="Generate a LEGO model", annotations=write, meta=security)
    async def generate_lego_model(prompt: Prompt, detail_level: Detail = 40, model: Model = Model(DEFAULT_MODEL)) -> CallToolResult:
        """Create a LEGO/brick model from a description using BrickBuilder's AI design, preview feedback,
        geometry checks, and voxel-to-brick pipeline. Returns a job ID immediately. Costs one account
        free usage allowance on successful AI generation. Completed jobs include a model and parts list.
        """
        return await start(LlmToBricksRequest(prompt=prompt, detail_level=detail_level, model=model.value))

    @server.tool(title="Edit a LEGO model", annotations=write, meta=security)
    async def edit_lego_model(generation_id: UUID, prompt: Prompt, model: Model = Model(DEFAULT_MODEL)) -> CallToolResult:
        """Apply requested changes to your existing saved voxel model while preserving untouched cells.
        Creates a new generation and keeps the original. Uses one free usage allowance and returns a job ID.
        """
        return await start(LlmToBricksRequest(generation_id=str(generation_id), prompt=prompt, model=model.value))

    @server.tool(title="Get LEGO model progress and files", annotations=read, meta=security)
    async def get_lego_model(generation_id: UUID) -> CallToolResult:
        """Check a BrickBuilder generation for this account. Returns status; once completed, returns
        the preview image, brick count, LDraw download and parts-list CSV. No generation or credit charge.
        The model URL links to the interactive 3D viewer, editing and instructions.
        """
        try:
            row = await generation_storage.get_generation(str(generation_id))
            if not row:
                raise HTTPException(status_code=404)
            require_generation_access(row, _identity())
            status = _generation_status(row)
            result = {
                "generation_id": str(generation_id), "status": status,
                "model_url": f"{settings.website_url}/generated-model?id={generation_id}&exact=1",
            }
            if status == "completed":
                result.update({key: row.get(key) for key in (
                    "name", "brick_count", "ldr_url", "parts_list_csv_url", "preview_image_url",
                )})
                result["message"] = "Model complete. Open the viewer or download the LDraw model and parts list."
            elif status == "failed":
                result["message"] = "The build failed. Open the model page for details or request another build."
            else:
                result.update(poll_after_seconds=10, next_tool="get_lego_model", message="Build is still processing.")
            return _result(result)
        except Exception as exc:
            return _error(exc)

    @server.tool(title="BrickBuilder account", annotations=read, meta=security)
    async def get_brick_builder_account() -> CallToolResult:
        """Identify the connected BrickBuilder account and its available generation credits."""
        try:
            identity = _identity()
            result = await asyncio.to_thread(lambda: generation_storage.client.table("user_profiles")
                                             .select("credits").eq("email", identity["user_email"]).single().execute())
            return _result({"id": identity["user_id"], "email": identity["user_email"],
                            "credits": result.data.get("credits", 0), "dashboard_url": settings.website_url + "/dashboard"})
        except Exception as exc:
            return _error(exc)

    return server
