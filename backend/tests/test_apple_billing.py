import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock
from uuid import uuid4
import pytest
from fastapi import HTTPException
from src.utils import apple_billing as apple, billing


def transaction(**overrides):
    return SimpleNamespace(**dict(dict(bundleId=apple.BUNDLE_ID, environment=apple.environment(),
        productId=next(iter(apple.PRODUCTS)), type='Auto-Renewable Subscription', inAppOwnershipType='PURCHASED',
        transactionId='123', originalTransactionId='100', purchaseDate=1000, expiresDate=2000,
        signedDate=3000, appAccountToken=str(uuid4()), revocationDate=None, isUpgraded=False), **overrides))


@pytest.mark.parametrize('changes', [dict(bundleId='other'), dict(productId='other'), dict(appAccountToken=None),
    dict(inAppOwnershipType='FAMILY_SHARED'), dict(environment='Xcode'), dict(expiresDate=1), dict(type='Consumable')])
def test_rejects_unsupported_or_unbound_transactions(changes):
    with pytest.raises(HTTPException): apple.validate_transaction(transaction(**changes))


def test_restored_purchase_cannot_be_claimed_by_another_account():
    with pytest.raises(HTTPException) as e: apple.validate_transaction(transaction(), str(uuid4()))
    assert e.value.status_code == 403


def test_current_server_state_is_used_for_refunded_device_transaction(monkeypatch):
    tx = transaction(revocationDate=2500)
    api = Mock(); api.get_transaction_info.return_value.signedTransactionInfo = 'current-signed-state'
    api.get_transaction_history.return_value = SimpleNamespace(signedTransactions=[], hasMore=False)
    verifier = Mock(); verifier.verify_and_decode_signed_transaction.return_value = tx
    monkeypatch.setattr(apple, 'ready', lambda: True)
    monkeypatch.setattr(apple, 'apple_services', lambda env: (verifier, api))
    rpc = AsyncMock(); monkeypatch.setattr(billing, 'rpc', rpc)
    asyncio.run(apple.reconcile('123', tx.appAccountToken))
    api.get_transaction_info.assert_called_once_with('123')
    verifier.verify_and_decode_signed_transaction.assert_called_once_with('current-signed-state')
    assert rpc.call_args.kwargs['p_revoked'] is True
    assert rpc.call_args.kwargs['p_allowance'] == 800


def test_prepare_blocks_duplicate_web_subscription(monkeypatch):
    monkeypatch.setattr(apple, 'ready', lambda: True)
    monkeypatch.setattr(billing, 'require_enabled', AsyncMock())
    monkeypatch.setattr(billing, 'capacity', AsyncMock(return_value={'checkout_available': True}))
    monkeypatch.setattr(billing, 'wallet', AsyncMock(return_value={'stripe_subscription_id': 'sub_1', 'subscription_status': 'active'}))
    with pytest.raises(HTTPException) as e:
        asyncio.run(apple.prepare({'authenticated': True, 'user_id': str(uuid4())}))
    assert e.value.status_code == 409
