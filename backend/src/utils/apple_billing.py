"""Apple-signed subscriptions. No client price, owner or entitlement is trusted."""
import asyncio
import os
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from uuid import UUID

from appstoreserverlibrary.api_client import AppStoreServerAPIClient, APIException, GetTransactionHistoryVersion
from appstoreserverlibrary.models.TransactionHistoryRequest import TransactionHistoryRequest
from appstoreserverlibrary.models.Environment import Environment
from appstoreserverlibrary.signed_data_verifier import SignedDataVerifier, VerificationException
from fastapi import HTTPException

from . import billing

PRODUCTS = {
    'ai.brickbuilder.app.builder.monthly': ('builder', 500),
    'ai.brickbuilder.app.creator.monthly': ('creator', 750),
}
BUNDLE_ID = 'ai.brickbuilder.app'


def environment():
    # Production accepts sandbox only for explicitly designated review accounts.
    return Environment.PRODUCTION if billing.live_mode() else Environment.SANDBOX


@lru_cache(maxsize=2)
def apple_services(env):
    roots = [path.read_bytes() for path in Path(os.environ['APPLE_ROOT_CERTIFICATES_DIR']).glob('*.cer')]
    if not roots:
        raise RuntimeError('Apple root certificates are not configured')
    verifier = SignedDataVerifier(roots, True, env, BUNDLE_ID, int(os.environ['APPLE_APP_ID']))
    api = AppStoreServerAPIClient(os.environ['APPLE_IAP_PRIVATE_KEY'].encode(),
        os.environ['APPLE_IAP_KEY_ID'], os.environ['APPLE_IAP_ISSUER_ID'], BUNDLE_ID, env)
    return verifier, api


def ready():
    return os.getenv('APPLE_IAP_ENABLED') == 'true' and all(os.getenv(name) for name in (
        'APPLE_ROOT_CERTIFICATES_DIR', 'APPLE_APP_ID', 'APPLE_IAP_PRIVATE_KEY', 'APPLE_IAP_KEY_ID', 'APPLE_IAP_ISSUER_ID'))


def timestamp(value):
    return datetime.fromtimestamp(value / 1000, timezone.utc).isoformat()


def sandbox_reviewers():
    return {value.strip().lower() for value in os.getenv('APPLE_SANDBOX_REVIEW_USER_IDS', '').split(',') if value.strip()}


def validate_transaction(tx, user_id=None, expected_environment=None):
    if (tx.bundleId != BUNDLE_ID or tx.environment != (expected_environment or environment()) or tx.productId not in PRODUCTS
            or tx.type != 'Auto-Renewable Subscription' or tx.inAppOwnershipType != 'PURCHASED'
            or not tx.transactionId or not tx.originalTransactionId or not tx.purchaseDate
            or not tx.expiresDate or not tx.signedDate or tx.expiresDate <= tx.purchaseDate):
        raise HTTPException(400, 'Unsupported Apple subscription.')
    try:
        owner = str(UUID(tx.appAccountToken))
    except (ValueError, TypeError, AttributeError):
        raise HTTPException(400, 'This purchase is not linked to a BrickBuilder account.') from None
    if user_id is not None and owner != user_id:
        raise HTTPException(403, 'Sign in to the BrickBuilder account used for this purchase.')
    if billing.live_mode() and tx.environment == Environment.SANDBOX and owner not in sandbox_reviewers():
        raise HTTPException(403, 'Sandbox purchases are restricted to designated test accounts.')
    return owner


async def reconcile(transaction_id, user_id=None):
    if not ready():
        raise HTTPException(503, 'Apple subscriptions are not available yet.')
    env = environment()
    verifier, api = apple_services(env)
    # App Review/TestFlight may use sandbox against the production binary. Only
    # explicitly designated BrickBuilder review accounts may receive those credits.
    try:
        response = await asyncio.to_thread(api.get_transaction_info, transaction_id)
    except APIException as error:
        if not billing.live_mode() or error.raw_api_error != 4040010 or not sandbox_reviewers():
            raise
        env = Environment.SANDBOX
        verifier, api = apple_services(env)
        response = await asyncio.to_thread(api.get_transaction_info, transaction_id)
    tx = await decode(verifier, response.signedTransactionInfo)
    owner = validate_transaction(tx, user_id, env)
    if tx.transactionId != transaction_id:
        raise HTTPException(400, 'Apple transaction mismatch.')
    await apply_transaction(tx, owner)
    # Recover missed renewals/refunds after webhook outages. Apple credits persist,
    # so restoring only the current entitlement would lose earlier monthly grants.
    revision = None
    for _ in range(100):
        history = await asyncio.to_thread(api.get_transaction_history, transaction_id, revision,
            TransactionHistoryRequest(productIds=list(PRODUCTS)), GetTransactionHistoryVersion.V2)
        for signed in history.signedTransactions or []:
            item = await decode(verifier, signed)
            # The same Apple ID may have purchased for another BrickBuilder account.
            if item.appAccountToken and str(item.appAccountToken).lower() != owner:
                continue
            validate_transaction(item, owner, env)
            await apply_transaction(item, owner)
        if not history.hasMore:
            return
        if not history.revision or history.revision == revision:
            break
        revision = history.revision
    raise HTTPException(503, 'Apple purchase history is still syncing. Please restore again.')


async def decode(verifier, signed):
    try:
        return await asyncio.to_thread(verifier.verify_and_decode_signed_transaction, signed)
    except VerificationException:
        raise HTTPException(400, 'Apple could not verify this purchase.') from None


async def apply_transaction(tx, owner):
    plan, allowance = PRODUCTS[tx.productId]
    namespace = 'sandbox:' if tx.environment == Environment.SANDBOX else 'production:'
    await billing.rpc('billing_apply_apple_transaction', p_user_id=owner, p_live=billing.live_mode(),
        p_transaction=namespace + tx.transactionId, p_original=namespace + tx.originalTransactionId, p_plan=plan,
        p_start=timestamp(tx.purchaseDate), p_end=timestamp(tx.expiresDate), p_version=tx.signedDate,
        p_revoked=bool(tx.revocationDate), p_upgraded=bool(tx.isUpgraded), p_allowance=allowance)


async def prepare(identity):
    user_id = billing.account_id(identity)
    await billing.require_enabled()
    if not ready() or not (await billing.capacity())['checkout_available']:
        raise HTTPException(503, 'New Apple subscriptions are temporarily unavailable. Restore and management remain available.')
    row = await billing.wallet(user_id)
    if row.get('stripe_subscription_id') and row['subscription_status'] not in ('none', 'canceled', 'incomplete_expired'):
        raise HTTPException(409, 'You already have a web subscription. Manage or cancel it before starting an Apple subscription.')
    return {'app_account_token': user_id}


async def sync(identity, transaction_id):
    await reconcile(transaction_id, billing.account_id(identity))
    return await billing.account(identity)


async def notification(payload):
    if not ready():
        raise HTTPException(503, 'Apple billing is unavailable.')
    env = environment()
    verifier, _ = apple_services(env)
    try:
        try:
            event = await asyncio.to_thread(verifier.verify_and_decode_notification, payload)
        except VerificationException:
            if not billing.live_mode() or not sandbox_reviewers():
                raise
            env = Environment.SANDBOX
            verifier, _ = apple_services(env)
            event = await asyncio.to_thread(verifier.verify_and_decode_notification, payload)
        if event.notificationType == 'TEST':
            return {'received': True}
        if not event.data or not event.data.signedTransactionInfo:
            return {'received': True}
        tx = await decode(verifier, event.data.signedTransactionInfo)
    except VerificationException:
        raise HTTPException(400, 'Invalid Apple notification.') from None
    owner = validate_transaction(tx, expected_environment=env)
    await reconcile(tx.transactionId, owner)
    return {'received': True}
