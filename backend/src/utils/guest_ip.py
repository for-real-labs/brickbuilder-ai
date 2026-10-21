"""Network abuse identity only; never use this as proof of model ownership."""
import hashlib
import hmac
import ipaddress
import os

from fastapi import HTTPException, Request


def guest_ip_hash(request: Request, *, local: bool = False) -> str:
    # Railway's public HTTP edge overwrites X-Real-IP. This mode is explicitly
    # enabled by the hosted launcher; direct/local servers ignore all headers.
    source = os.getenv('GUEST_IP_SOURCE', 'peer')
    if source == 'railway':
        values = request.headers.getlist('x-real-ip')
        raw_ip = values[0] if len(values) == 1 else None
    elif source == 'peer':
        raw_ip = request.client.host if request.client else None
    else:
        raw_ip = None
    try:
        if not raw_ip or '%' in raw_ip:
            raise ValueError('Missing or scoped address')
        address = ipaddress.ip_address(raw_ip)
    except ValueError:
        raise HTTPException(503, 'Guest access is temporarily unavailable. Please sign in to keep building.') from None
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
        address = address.ipv4_mapped
    # IPv6 privacy addresses rotate inside the same subscriber /64.
    network = str(ipaddress.ip_network(f'{address}/64', strict=False)) if address.version == 6 else str(address)
    key = os.getenv('GUEST_IP_HASH_SECRET') or os.getenv('SUPABASE_SERVICE_ROLE_KEY')
    if not key and local:
        key = 'brickbuilder-local-development-only'
    if not key:
        raise HTTPException(503, 'Guest access is temporarily unavailable. Please sign in to keep building.')
    return 'ip_v1_' + hmac.new(key.encode(), ('guest-trial:' + network).encode(), hashlib.sha256).hexdigest()
