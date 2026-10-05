"""
Authentication and authorization middleware for the Mesh2Brick API
"""
import os
import asyncio
import jwt
from typing import Optional, Dict, Any
from fastapi import HTTPException, Header, Depends, Request
from supabase import create_client, Client
import logging
from datetime import datetime
import hashlib
import time
import re

logger = logging.getLogger(__name__)

def _get_int_env(name: str, default: int) -> int:
    value = os.getenv(name)
    if value is None:
        return default

    try:
        parsed_value = int(value)
    except ValueError:
        logger.warning(f"Invalid {name} value '{value}'. Using default of {default}.")
        return default

    if parsed_value < 0:
        logger.warning(f"Invalid {name} value '{value}'. Using default of {default}.")
        return default

    return parsed_value

# Initialize Supabase client
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
SUPABASE_JWT_SECRET = os.getenv("SUPABASE_JWT_SECRET")
DEVELOPER_API_KEY = os.getenv("DEVELOPER_API_KEY")

# Asymmetric Supabase signing keys are verified through the project's JWKS;
# the legacy JWT secret is only needed for HS256 tokens.
SUPABASE_ENABLED = bool(SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY)
SUPABASE_ISSUER = SUPABASE_URL.rstrip('/') + '/auth/v1' if SUPABASE_URL else None
supabase_jwks_client = jwt.PyJWKClient(
    SUPABASE_ISSUER + '/.well-known/jwks.json', timeout=5
) if SUPABASE_ISSUER else None
supabase_client: Optional[Client] = None
# When True, storage is backed by a local embedded Postgres instead of Supabase.
LOCAL_DB_ENABLED = False

if SUPABASE_ENABLED:
    try:
        supabase_client = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
        # Supabase client initialized
    except Exception as e:
        logger.error(f"CRITICAL: Failed to initialize Supabase client: {e}")
        supabase_client = None
        SUPABASE_ENABLED = False
else:
    # No Supabase configured: fall back to a local embedded Postgres + file
    # store so the app is fully functional without any external services.
    try:
        from .local_db import init_local_supabase

        supabase_client = init_local_supabase()
        LOCAL_DB_ENABLED = True
        logger.info(
            "Supabase is not configured. Using a local embedded Postgres + file "
            "store for storage (anonymous mode, no authentication)."
        )
    except Exception as e:
        logger.warning(
            "Supabase is not configured and the local storage fallback failed to "
            "start (%s). Running without persistent storage.",
            e,
        )
        supabase_client = None

class AuthError(Exception):
    """Custom exception for authentication errors"""
    def __init__(self, message: str, status_code: int = 401):
        self.message = message
        self.status_code = status_code
        super().__init__(self.message)

def extract_user_from_token(token: str) -> Dict[str, Any]:
    """
    Extract user information from Supabase JWT token
    """
    try:
        algorithm = jwt.get_unverified_header(token).get('alg')
        if algorithm == 'HS256' and SUPABASE_JWT_SECRET:
            key = SUPABASE_JWT_SECRET
        elif algorithm in {'ES256', 'RS256'} and supabase_jwks_client:
            # The key endpoint comes only from configured SUPABASE_URL, never
            # an untrusted token's jku/issuer header.
            key = supabase_jwks_client.get_signing_key_from_jwt(token).key
        else:
            raise AuthError('Unsupported authentication token', 401)
        if not SUPABASE_ISSUER:
            raise AuthError('Authentication is not configured', 401)
        decoded_token = jwt.decode(
            token, key, algorithms=[algorithm], audience="authenticated",
            issuer=SUPABASE_ISSUER,
            options={"require": ["exp", "iss", "aud", "sub"]},
        )
        if (not isinstance(decoded_token['sub'], str) or not decoded_token['sub'].strip()
                or decoded_token.get('role') != 'authenticated'):
            raise AuthError('Invalid account identity', 401)
        
        return {
            "user_id": decoded_token.get("sub"),
            "email": decoded_token.get("email"),
            "role": decoded_token.get("role", "authenticated"),
            "exp": decoded_token.get("exp")
        }
    except jwt.ExpiredSignatureError:
        raise AuthError("Token has expired", 401)
    except (jwt.PyJWTError, ValueError, TypeError) as e:
        raise AuthError("Invalid authentication token", 401) from e

async def verify_authentication(
    authorization: Optional[str] = Header(None),
    x_api_key: Optional[str] = Header(None)
) -> Dict[str, Any]:
    """
    Verify user authentication via Supabase JWT token or developer API key
    """
    # Check for developer API key first (works regardless of Supabase)
    if x_api_key and DEVELOPER_API_KEY and x_api_key == DEVELOPER_API_KEY:
        logger.info("Request authenticated with developer API key")
        return {
            "authenticated": True, 
            "user_email": "developer@brickai.com",
            "auth_method": "api_key",
            "is_developer": True
        }

    # If Supabase is not configured, run in anonymous mode and allow the request
    if not SUPABASE_ENABLED or not supabase_client:
        return {
            "authenticated": True,
            "user_email": None,
            "user_id": None,
            "auth_method": "anonymous",
            "is_anonymous": True,
            "is_developer": False,
        }

    # Check for Supabase JWT token
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=401,
            detail="Missing or invalid authorization header. Expected 'Bearer <token>'"
        )
    
    token = authorization.replace("Bearer ", "")
    
    try:
        user_info = await asyncio.to_thread(extract_user_from_token, token)
        logger.info(f"Request authenticated for user: {user_info['email']}")
        
        return {
            "authenticated": True,
            "user_email": user_info["email"],
            "user_id": user_info["user_id"],
            "auth_method": "jwt",
            "is_developer": False
        }
    except AuthError as e:
        raise HTTPException(status_code=e.status_code, detail=e.message)

async def verify_and_deduct_credits(user_email: str, credits_needed: int = 1) -> Dict[str, Any]:
    """
    Verify user has enough credits and deduct them
    """
    if not supabase_client:
        logger.warning("No Supabase configuration. Skipping credit check.")
        return {"success": True, "remaining_credits": 999}
    
    try:
        # First, get the current user profile
        result = supabase_client.table("user_profiles").select("*").eq("email", user_email).execute()
        
        if not result.data:
            raise HTTPException(
                status_code=404,
                detail="User profile not found"
            )
        
        user_profile = result.data[0]
        current_credits = user_profile.get("credits", 0)
        
        if current_credits < credits_needed:
            raise HTTPException(
                status_code=402,  # Payment Required
                detail=f"Insufficient credits. Required: {credits_needed}, Available: {current_credits}"
            )
        
        # Deduct the credits and increment total_credits_used
        new_credits = current_credits - credits_needed
        current_total_used = user_profile.get("total_credits_used", 0)
        new_total_used = current_total_used + credits_needed
        
        update_result = supabase_client.table("user_profiles").update({
            "credits": new_credits,
            "total_credits_used": new_total_used,
            "updated_at": "now()"
        }).eq("email", user_email).execute()
        
        if update_result.data:
            logger.info(f"Deducted {credits_needed} credits from {user_email}. Remaining: {new_credits}, Total used: {new_total_used}")
            return {"success": True, "remaining_credits": new_credits, "total_credits_used": new_total_used}
        else:
            raise HTTPException(
                status_code=500,
                detail="Failed to update credits"
            )
            
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error checking/deducting credits for {user_email}: {str(e)}")
        raise HTTPException(
            status_code=500,
            detail=f"Credit system error: {str(e)}"
        )

async def get_authenticated_user(
    auth_info: Dict[str, Any] = Depends(verify_authentication)
) -> Dict[str, Any]:
    """
    Dependency to get authenticated user information
    """
    return auth_info


async def require_paid_auth(
    auth_info: Dict[str, Any] = Depends(get_authenticated_user)
) -> Dict[str, Any]:
    """
    Dependency for cost-bearing endpoints. Anonymous users are not allowed.
    """
    return {**auth_info, "is_anonymous": False}

# Anonymous user tracking system
ANONYMOUS_CALL_LIMIT = _get_int_env("ANONYMOUS_CALL_LIMIT", 1000)  # Lifetime limit for anonymous users
ANONYMOUS_WINDOW_CALL_LIMIT = _get_int_env("ANONYMOUS_WINDOW_CALL_LIMIT", 20)
ANONYMOUS_WINDOW_SECONDS = _get_int_env("ANONYMOUS_WINDOW_SECONDS", 60)
anonymous_window_calls: Dict[str, list[float]] = {}

def check_anonymous_short_window_limit(anonymous_id: str) -> Dict[str, Any]:
    now = time.monotonic()
    window_start = now - ANONYMOUS_WINDOW_SECONDS
    recent_calls = [call_time for call_time in anonymous_window_calls.get(anonymous_id, []) if call_time > window_start]

    if len(recent_calls) >= ANONYMOUS_WINDOW_CALL_LIMIT:
        anonymous_window_calls[anonymous_id] = recent_calls
        raise HTTPException(
            status_code=429,
            detail="Too many anonymous requests. Please wait before trying again."
        )

    recent_calls.append(now)
    anonymous_window_calls[anonymous_id] = recent_calls

    return {
        "limit": ANONYMOUS_WINDOW_CALL_LIMIT,
        "remaining": max(0, ANONYMOUS_WINDOW_CALL_LIMIT - len(recent_calls)),
        "window_seconds": ANONYMOUS_WINDOW_SECONDS
    }

def get_anonymous_user_id(request: Request) -> str:
    """
    Generate a unique identifier for anonymous users based on IP address and User-Agent
    This provides more stable identification when ISPs use dynamic IPs
    Privacy-compliant: IP addresses are immediately hashed and never logged or stored in plain text
    """
    # Use the ASGI client host only. Do not trust spoofable forwarding headers here.
    client_ip = request.client.host if request.client else "unknown"
    user_agent = request.headers.get("user-agent", "Unknown")
    
    # Normalize localhost variants for consistent local development testing
    if client_ip in ["::1", "::ffff:127.0.0.1", "localhost"]:
        client_ip = "127.0.0.1"
    
    # For more stable anonymous user identification, combine IP with User-Agent
    # This helps when ISPs rotate IP addresses frequently
    # Extract key browser info (browser name + version, OS) but ignore minor version changes
    ua_simplified = user_agent.split()[0] if user_agent != "Unknown" else "Unknown"
    fingerprint = f"{client_ip}:{ua_simplified}"
    
    # Generate hash - IP addresses are never logged or stored in plain text
    ip_hash = hashlib.md5(fingerprint.encode()).hexdigest()
    
    # Only log that anonymous user tracking occurred (no personal data)
    logger.info(f"Anonymous user request processed - hash generated")
    
    return ip_hash

async def check_anonymous_rate_limit(anonymous_id: str) -> Dict[str, Any]:
    """
    Check if anonymous user has exceeded lifetime rate limit using Supabase
    """
    if not supabase_client:
        logger.error("No Supabase configuration. Rejecting anonymous request without tracking.")
        raise HTTPException(
            status_code=503,
            detail="Anonymous access is temporarily unavailable. Please sign in and try again."
        )
    
    try:
        # Check if anonymous user exists in database
        result = supabase_client.table("anonymous_users").select("*").eq("ip_hash", anonymous_id).execute()
        
        if not result.data:
            # New anonymous user - create record
            now = datetime.now().isoformat()
            insert_result = supabase_client.table("anonymous_users").insert({
                "ip_hash": anonymous_id,
                "call_count": 0,
                "first_call": now,
                "created_at": now,
                "updated_at": now
            }).execute()
            
            if insert_result.data:
                user_data = insert_result.data[0]
            else:
                logger.error("Failed to create anonymous user record")
                raise HTTPException(
                    status_code=503,
                    detail="Anonymous access is temporarily unavailable. Please sign in and try again."
                )
        else:
            user_data = result.data[0]
        
        calls_made = user_data.get("call_count", 0)
        first_call = user_data.get("first_call", "unknown")
        
        return {
            "calls_made": calls_made,
            "limit": ANONYMOUS_CALL_LIMIT,
            "remaining": max(0, ANONYMOUS_CALL_LIMIT - calls_made),
            "limit_exceeded": calls_made >= ANONYMOUS_CALL_LIMIT,
            "first_call": first_call
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error checking anonymous rate limit: {e}")
        raise HTTPException(
            status_code=503,
            detail="Anonymous access is temporarily unavailable. Please sign in and try again."
        )

async def increment_anonymous_calls(anonymous_id: str):
    """
    Increment the call count for an anonymous user in Supabase using Python SDK
    """
    if not supabase_client:
        logger.warning("No Supabase configuration. Cannot increment anonymous call count.")
        return
    
    try:
        # Simple approach: Get current count and increment
        current_result = supabase_client.table("anonymous_users").select("call_count").eq("ip_hash", anonymous_id).execute()
        
        if current_result.data:
            current_count = current_result.data[0]["call_count"]
            new_count = current_count + 1
            
            # Update with incremented count
            update_result = supabase_client.table("anonymous_users").update({
                "call_count": new_count,
                "updated_at": datetime.now().isoformat()
            }).eq("ip_hash", anonymous_id).execute()
            
            if update_result.data:
                logger.info(f"Incremented anonymous user call count to {new_count} for {anonymous_id[:8]}...")
            else:
                logger.error(f"Failed to update call count for {anonymous_id[:8]}...")
        else:
            logger.error(f"Anonymous user {anonymous_id[:8]}... not found for increment")
            
    except Exception as e:
        logger.error(f"Error incrementing anonymous call count: {e}")

def get_guest_user_id(request: Request) -> Optional[str]:
    """A browser-generated 256-bit bearer secret proves guest ownership.

    Store only its hash. Never fall back to IP, User-Agent, or a generation ID.
    """
    secret = request.headers.get("x-guest-session")
    if secret is None:
        return None
    if not re.fullmatch(r"[0-9a-f]{64}", secret):
        raise HTTPException(status_code=401, detail="Invalid guest session")
    return "guest_" + hashlib.sha256(secret.encode()).hexdigest()


async def get_optional_identity(
    request: Request,
    authorization: Optional[str] = Header(None),
    x_api_key: Optional[str] = Header(None)
) -> Dict[str, Any]:
    """
    Resolve account or guest ownership without charging read/poll requests.
    """
    guest_user_id = get_guest_user_id(request)
    # Check for developer API key first
    if x_api_key and x_api_key == DEVELOPER_API_KEY:
        logger.info("Request authenticated with developer API key")
        return {
            "authenticated": True, 
            "user_email": "developer@brickai.com",
            "user_id": "developer",
            "guest_user_id": guest_user_id,
            "auth_method": "api_key",
            "is_developer": True,
            "is_anonymous": False
        }
    
    # Invalid credentials must not silently turn an account request into a guest.
    if authorization and (not authorization.startswith("Bearer ") or not supabase_client):
        raise HTTPException(status_code=401, detail="Invalid authentication token")
    # Check for Supabase JWT token
    if authorization and authorization.startswith("Bearer "):
        token = authorization.replace("Bearer ", "")
        
        try:
            if supabase_client:
                user_info = await asyncio.to_thread(extract_user_from_token, token)
                logger.info(f"Request authenticated for user: {user_info['email']}")
                
                return {
                    "authenticated": True,
                    "user_email": user_info["email"],
                    "user_id": user_info["user_id"],
                    "guest_user_id": guest_user_id,
                    "auth_method": "jwt",
                    "is_developer": False,
                    "is_anonymous": False
                }
        except AuthError as e:
            raise HTTPException(status_code=401, detail="Invalid authentication token") from e
    
    return {
        "authenticated": False,
        "user_email": "anonymous",
        "user_id": guest_user_id,
        "guest_user_id": guest_user_id,
        "auth_method": "anonymous",
        "is_developer": False,
        "is_anonymous": True,
    }


async def verify_authentication_optional(
    request: Request,
    auth_info: Dict[str, Any] = Depends(get_optional_identity),
) -> Dict[str, Any]:
    if not auth_info.get("is_anonymous"):
        return auth_info
    if not auth_info.get("user_id"):
        raise HTTPException(status_code=401, detail="Guest session required")
    # IP fingerprints are abuse controls only, never proof of ownership.
    rate_limit_id = get_anonymous_user_id(request)
    short_window_status = check_anonymous_short_window_limit(rate_limit_id)
    rate_limit_status = await check_anonymous_rate_limit(rate_limit_id)
    rate_limit_status["short_window"] = short_window_status
    if rate_limit_status["limit_exceeded"]:
        raise HTTPException(status_code=429, detail="Anonymous user limit exceeded. Please sign in.")
    return {**auth_info, "rate_limit_id": rate_limit_id, "rate_limit": rate_limit_status}


async def get_user_with_optional_auth(
    auth_info: Dict[str, Any] = Depends(verify_authentication_optional)
) -> Dict[str, Any]:
    """
    Dependency to get user information (authenticated or anonymous)
    Note: Anonymous call count is NOT incremented here - it's incremented after successful fal.ai API call
    """
    return auth_info

async def increment_anonymous_usage_after_fal_success(auth_info: Dict[str, Any]) -> Dict[str, Any]:
    """
    Increment anonymous user call count after successful fal.ai API call
    This mirrors the credit deduction timing for authenticated users
    """
    if auth_info.get("is_anonymous", False):
        anonymous_id = auth_info["rate_limit_id"]
        logger.info(f"Incrementing anonymous call count after successful fal.ai API call")
        await increment_anonymous_calls(anonymous_id)
        
        # Update rate limit info after incrementing
        rate_limit_status = await check_anonymous_rate_limit(anonymous_id)
        auth_info["rate_limit"] = rate_limit_status
        
    return auth_info


def handle_auth_and_tracking(
    auth_info: dict,
    endpoint: str,
    track_properties: dict,
    required_credits: int = 1
) -> dict:
    """
    Handle authentication, tracking, and credit verification for API endpoints.
    
    Args:
        auth_info: Authentication information from the auth dependency
        endpoint: The endpoint name for tracking (e.g., "/imageToBricks")
        track_properties: Endpoint-specific properties to track
        required_credits: Number of credits required for this endpoint
    
    Returns:
        Dict containing extracted user information
        
    Raises:
        HTTPException: If user has insufficient credits
    """
    from .posthog_client import track_api_call
    
    # Extract user info for tracking
    user_email = auth_info.get('user_email', 'anonymous')
    is_developer = auth_info.get('is_developer', False)
    auth_method = auth_info.get('auth_method', 'unknown')
    is_anonymous = auth_info.get('is_anonymous', False)
    
    # Add common tracking properties
    common_track_properties = {
        "is_developer": is_developer,
        "auth_method": auth_method,
        "is_anonymous": is_anonymous,
    }
    
    # Merge endpoint-specific properties with common properties
    full_track_properties = {**common_track_properties, **track_properties}
    
    # Add rate limit info for anonymous users
    if is_anonymous and "rate_limit" in auth_info:
        rate_limit = auth_info["rate_limit"]
        full_track_properties.update({
            "anonymous_calls_made": rate_limit["calls_made"],
            "anonymous_calls_remaining": rate_limit["remaining"],
            "anonymous_lifetime_limit": rate_limit["limit"],
            "anonymous_first_call": rate_limit.get("first_call", "unknown")
        })
    
    # Track API call
    track_api_call(
        endpoint=endpoint,
        user_id=user_email,
        **full_track_properties
    )
    
    # Check authentication and credits
    if is_anonymous:
        logger.info(f"Anonymous user request - lifetime limit of {auth_info['rate_limit']['limit']} calls")
        logger.info(f"Anonymous user lifetime calls: {auth_info['rate_limit']['calls_made']}/{auth_info['rate_limit']['limit']}")
    elif not auth_info.get("is_developer", False):
        # Check if user has credits before processing (but don't deduct yet)
        user_email_for_credits = auth_info.get("user_email")
        if user_email_for_credits and user_email_for_credits != "developer@brickai.com":
            # Just verify they have credits, don't deduct yet
            if supabase_client:
                result = supabase_client.table("user_profiles").select("credits").eq("email", user_email_for_credits).execute()
                if not result.data or result.data[0].get("credits", 0) < required_credits:
                    credit_message = f"Insufficient credits. At least {required_credits} credit"
                    if required_credits > 1:
                        credit_message += "s"
                    if required_credits == 2:
                        credit_message += " required for text-to-bricks conversion."
                    else:
                        credit_message += " required."
                        
                    raise HTTPException(
                        status_code=402,  # Payment Required
                        detail=credit_message
                    )
                logger.info(f"User has sufficient credits: {result.data[0].get('credits', 0)}")
        else:
            logger.info(f"Skipping credit check: user_email={user_email_for_credits}")
    else:
        logger.info("Skipping credit check for developer API key")
    
    # Return user information for use in the endpoint
    return {
        "user_email": user_email,
        "is_developer": is_developer,
        "auth_method": auth_method,
        "is_anonymous": is_anonymous
    }


async def deduct_credits(
    user_info: dict,
    auth_info: dict,
    credits_to_deduct: int = 1,
    operation_description: str = "operation"
) -> dict:
    """
    Deduct credits or increment anonymous usage after successful fal.ai API calls.
    
    This ensures users are charged when fal.ai charges us, regardless of subsequent processing.
    
    Args:
        user_info: User information returned from handle_auth_and_tracking
        auth_info: Original authentication information (may be modified for anonymous users)
        credits_to_deduct: Number of credits to deduct for authenticated users
        operation_description: Description of the operation for logging
        
    Returns:
        Updated auth_info (important for anonymous users as it contains updated rate limits)
    """
    is_anonymous = user_info["is_anonymous"]
    is_developer = user_info["is_developer"]
    
    if not is_anonymous and not is_developer:
        user_email_for_credits = user_info["user_email"]
        if user_email_for_credits and user_email_for_credits != "developer@brickai.com":
            logger.info(f"Deducting {credits_to_deduct} credit{'s' if credits_to_deduct != 1 else ''} from {user_email_for_credits} after successful {operation_description}")
            credit_result = await verify_and_deduct_credits(user_email_for_credits, credits_to_deduct)
            logger.info(f"Credits deducted. Remaining: {credit_result.get('remaining_credits', 'unknown')}")
    elif is_anonymous:
        # Increment anonymous user call count after successful fal.ai API calls
        auth_info = await increment_anonymous_usage_after_fal_success(auth_info)
        logger.info(f"Anonymous call count incremented. Lifetime calls: {auth_info['rate_limit']['calls_made']}/{auth_info['rate_limit']['limit']}")
    
    return auth_info
