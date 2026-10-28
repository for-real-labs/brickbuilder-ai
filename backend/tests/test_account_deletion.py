import asyncio
from types import SimpleNamespace as NS
from unittest.mock import AsyncMock, MagicMock
from uuid import uuid4

import pytest
from fastapi import HTTPException
from src.requests import accountDeletion as deletion


@pytest.fixture
def setup(monkeypatch):
    uid = str(uuid4())
    db = MagicMock()
    db.auth.get_user.return_value = NS(user=NS(id=uid))
    monkeypatch.setattr(deletion.billing, 'client', lambda: db)
    query = AsyncMock(return_value=NS(data=[]))
    monkeypatch.setattr(deletion, 'execute_query', query)
    rpc = AsyncMock(side_effect=[None, [{'bucket_id':'generations','name':'owned/file'}], [], None])
    monkeypatch.setattr(deletion.billing, 'rpc', rpc)
    return uid, db, rpc, query


def test_deletes_storage_before_data_and_auth(setup):
    uid, db, rpc, query = setup
    assert asyncio.run(deletion.delete_account({'user_id':uid,'authenticated':True},'token')) == {'deleted':True}
    db.storage.from_.assert_called_with('generations')
    db.storage.from_.return_value.remove.assert_called_once_with(['owned/file'])
    assert rpc.call_args_list[-1].args[0] == 'account_deletion_data'
    db.auth.admin.delete_user.assert_called_once_with(uid)


def test_storage_failure_keeps_auth_and_account_data_for_retry(setup):
    uid, db, rpc, query = setup
    db.storage.from_.return_value.remove.side_effect = RuntimeError('storage offline')
    with pytest.raises(RuntimeError): asyncio.run(deletion.delete_account({'user_id':uid,'authenticated':True},'token'))
    db.auth.admin.delete_user.assert_not_called()
    assert not any(c.args[0] == 'account_deletion_data' for c in rpc.call_args_list)


@pytest.mark.parametrize('identity', [{}, {'authenticated':True,'is_developer':True}, {'authenticated':True,'user_id':'bad'}])
def test_rejects_non_account_identity(setup, identity):
    with pytest.raises(HTTPException): asyncio.run(deletion.delete_account(identity,'token'))
    setup[1].auth.admin.delete_user.assert_not_called()


def test_rejects_stale_or_different_live_session(setup):
    uid, db, rpc, query = setup
    db.auth.get_user.return_value = NS(user=NS(id=str(uuid4())))
    with pytest.raises(HTTPException) as error:
        asyncio.run(deletion.delete_account({'user_id':uid,'authenticated':True},'token'))
    assert error.value.status_code == 401
    rpc.assert_not_called()


def test_active_builds_do_not_start_deletion(setup):
    uid, db, rpc, query = setup
    rpc.side_effect = RuntimeError('ACCOUNT_HAS_ACTIVE_BUILDS')
    with pytest.raises(HTTPException) as error:
        asyncio.run(deletion.delete_account({'user_id':uid,'authenticated':True},'token'))
    assert error.value.status_code == 409
    db.auth.admin.delete_user.assert_not_called()


def test_cancels_stripe_before_erasure(setup, monkeypatch):
    uid, db, rpc, query = setup
    query.return_value = NS(data=[{'stripe_customer_id':'cus_owner','livemode':True}])
    monkeypatch.setenv('STRIPE_SECRET_KEY_LIVE','test-key')
    listing = MagicMock()
    listing.auto_paging_iter.return_value = [NS(id='sub_active',status='active'),NS(id='sub_old',status='canceled')]
    monkeypatch.setattr(deletion.stripe.Subscription,'list',MagicMock(return_value=listing))
    cancel = MagicMock()
    monkeypatch.setattr(deletion.stripe.Subscription,'cancel',cancel)
    asyncio.run(deletion.delete_account({'user_id':uid,'authenticated':True},'token'))
    cancel.assert_called_once_with('sub_active',api_key='test-key')


def test_confirmation_does_not_accept_target_user():
    from pydantic import ValidationError
    with pytest.raises(ValidationError): deletion.DeletionRequest(confirmation='DELETE',user_id=str(uuid4()))
    with pytest.raises(ValidationError): deletion.DeletionRequest(confirmation='yes')
