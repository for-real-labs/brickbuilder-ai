import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock
from uuid import uuid4
import pytest
from fastapi import HTTPException
from appstoreserverlibrary.models.Environment import Environment
from appstoreserverlibrary.signed_data_verifier import VerificationException, VerificationStatus
from src.utils import apple_billing as apple
from test_apple_billing import transaction


def test_invalid_notification_never_writes_wallet(monkeypatch):
    monkeypatch.setattr(apple,'ready',lambda: True)
    verifier=Mock(); verifier.verify_and_decode_notification.side_effect=VerificationException(VerificationStatus.VERIFICATION_FAILURE)
    monkeypatch.setattr(apple,'apple_services',lambda env:(verifier,Mock()))
    monkeypatch.setenv('APPLE_SANDBOX_REVIEW_USER_IDS','')
    reconcile=AsyncMock(); monkeypatch.setattr(apple,'reconcile',reconcile)
    with pytest.raises(HTTPException): asyncio.run(apple.notification('forged'))
    reconcile.assert_not_called()


def test_production_sandbox_only_for_designated_review_account(monkeypatch):
    monkeypatch.setenv('API_MODE','production')
    owner=str(uuid4()); tx=transaction(appAccountToken=owner,environment=Environment.SANDBOX)
    monkeypatch.setenv('APPLE_SANDBOX_REVIEW_USER_IDS','')
    with pytest.raises(HTTPException): apple.validate_transaction(tx,owner,Environment.SANDBOX)
    monkeypatch.setenv('APPLE_SANDBOX_REVIEW_USER_IDS',owner)
    assert apple.validate_transaction(tx,owner,Environment.SANDBOX)==owner
    with pytest.raises(HTTPException): apple.validate_transaction(tx,str(uuid4()),Environment.SANDBOX)


def test_paginated_history_recovers_renewals_and_ignores_other_accounts(monkeypatch):
    tx=transaction(); older=transaction(appAccountToken=tx.appAccountToken,transactionId='122')
    foreign=transaction(transactionId='121')
    verifier=Mock(); verifier.verify_and_decode_signed_transaction.side_effect=[tx,older,foreign]
    api=Mock(); api.get_transaction_info.return_value.signedTransactionInfo='current'
    api.get_transaction_history.side_effect=[SimpleNamespace(signedTransactions=['old'],hasMore=True,revision='next'),
        SimpleNamespace(signedTransactions=['foreign'],hasMore=False)]
    monkeypatch.setattr(apple,'ready',lambda:True)
    monkeypatch.setattr(apple,'apple_services',lambda env:(verifier,api))
    apply=AsyncMock();monkeypatch.setattr(apple,'apply_transaction',apply)
    asyncio.run(apple.reconcile('123',tx.appAccountToken))
    assert apply.await_count==2
    assert api.get_transaction_history.call_args_list[1].args[1]=='next'
