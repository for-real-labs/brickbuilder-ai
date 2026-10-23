import asyncio
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock
from uuid import uuid4

import pytest
import stripe
from fastapi import HTTPException
from pydantic import ValidationError

from src.utils import billing
from src.utils.auth import deduct_credits
from src.utils.generation_storage import GenerationStorage
from src.requests.billing import CheckoutRequest, PortalRequest, SyncRequest


def obj(data):
    return stripe.StripeObject.construct_from(data, None)


@pytest.fixture
def identity():
    return {'authenticated':True,'user_id':str(uuid4()),'user_email':'builder@example.test'}


@pytest.fixture
def subscription(identity):
    now=int(datetime.now(timezone.utc).timestamp())
    return obj({'id':'sub_test','livemode':False,'customer':'cus_test','status':'active',
        'metadata':{'integration':billing.BILLING_TAG,'brickbuilder_user_id':identity['user_id']},
        'cancel_at_period_end':False,
        'items':{'data':[{'id':'si_test','quantity':1,'current_period_start':now-60,'current_period_end':now+3600,
            'price':{'id':'price_test','lookup_key':billing.lookup_key('builder'),'unit_amount':900,'currency':'usd','recurring':{'interval':'month','interval_count':1}}}]},
        'latest_invoice':{'id':'in_test','status':'paid','livemode':False,
            'parent':{'subscription_details':{'subscription':'sub_test'}},
            'lines':{'data':[{'pricing':{'price_details':{'price':'price_test'}}}]}}})


@pytest.fixture(autouse=True)
def test_mode(monkeypatch):
    monkeypatch.setenv('API_MODE','local')
    monkeypatch.setenv('STRIPE_SECRET_KEY','test-only')


@pytest.mark.parametrize('identity',[{}, {'authenticated':True,'is_anonymous':True}, {'authenticated':True,'is_developer':True}, {'authenticated':True,'user_id':'bad'}])
def test_account_requires_verified_identity(identity):
    with pytest.raises(HTTPException) as error:
        billing.account_id(identity)
    assert error.value.status_code==401


def test_client_cannot_override_price_owner_redirect_or_cancel_mode():
    for extras in ({'price':1},{'user_id':str(uuid4())},{'return_url':'https://evil.test'}):
        with pytest.raises(ValidationError): CheckoutRequest(plan_key='builder',**extras)
    with pytest.raises(ValidationError): CheckoutRequest(plan_key='unknown')
    with pytest.raises(ValidationError): PortalRequest(action='immediately')
    with pytest.raises(ValidationError): SyncRequest(session_id='https://evil.test')


@pytest.mark.parametrize('change', [None,'unpaid','different_price','wrong_mode','wrong_customer'])
def test_only_verified_paid_matching_invoices_grant_credits(monkeypatch,identity,subscription,change):
    if change=='unpaid': subscription.latest_invoice.status='open'
    if change=='different_price': subscription.latest_invoice.lines.data[0].pricing.price_details.price='other'
    if change=='wrong_mode': subscription.livemode=True
    if change=='wrong_customer': subscription.customer='cus_other'
    monkeypatch.setattr(billing.stripe.Subscription,'retrieve',Mock(return_value=subscription))
    monkeypatch.setattr(billing,'wallet',AsyncMock(return_value={'stripe_customer_id':'cus_test','stripe_subscription_id':'sub_test'}))
    grant=AsyncMock(); monkeypatch.setattr(billing,'rpc',grant)
    if change in ('wrong_mode','wrong_customer'):
        with pytest.raises(ValueError): asyncio.run(billing.sync_subscription('sub_test'))
        grant.assert_not_called()
    else:
        asyncio.run(billing.sync_subscription('sub_test'))
        assert grant.call_args.kwargs['p_invoice']==('in_test' if change is None else None)
        assert grant.call_args.kwargs['p_allowance']==(500 if change is None else None)


def test_subscription_checkout_never_reaches_physical_order_processing(monkeypatch):
    sync=AsyncMock();monkeypatch.setattr(billing,'sync_subscription',sync)
    event=obj({'type':'checkout.session.completed','livemode':False,'data':{'object':{'id':'cs_1','mode':'subscription','subscription':'sub_1'}}})
    assert asyncio.run(billing.handle_billing_event(event))
    sync.assert_awaited_once_with('sub_1')
    event.data.object.mode='payment'
    assert not asyncio.run(billing.handle_billing_event(event))


def test_foreign_checkout_cannot_be_synced(monkeypatch,identity):
    monkeypatch.setattr(billing.stripe.checkout.Session,'retrieve',Mock(return_value=obj({'client_reference_id':str(uuid4()),'metadata':{'integration':billing.BILLING_TAG},'livemode':False})))
    sync=AsyncMock();monkeypatch.setattr(billing,'sync_subscription',sync)
    with pytest.raises(HTTPException) as error: asyncio.run(billing.sync_checkout(identity,'cs_foreign'))
    assert error.value.status_code==403
    sync.assert_not_called()


def test_duplicate_checkout_requests_are_rejected_before_stripe(monkeypatch,identity):
    monkeypatch.setattr(billing,'require_enabled',AsyncMock())
    monkeypatch.setattr(billing,'capacity',AsyncMock(return_value={'checkout_available':True}))
    monkeypatch.setattr(billing,'rpc',AsyncMock(return_value=False))
    create=Mock();monkeypatch.setattr(billing.stripe.checkout.Session,'create',create)
    with pytest.raises(HTTPException) as error: asyncio.run(billing.checkout(identity,'builder'))
    assert error.value.status_code==409
    create.assert_not_called()


def test_cancellation_uses_customer_bound_stripe_confirmation(monkeypatch,identity):
    monkeypatch.setattr(billing,'wallet',AsyncMock(return_value={'stripe_customer_id':'cus_owner','stripe_subscription_id':'sub_owner'}))
    monkeypatch.setattr(billing,'settings',AsyncMock(return_value={'test_portal_id':'bpc_test'}))
    create=Mock(return_value=SimpleNamespace(url='https://billing.stripe.com/p/session/test'))
    monkeypatch.setattr(billing.stripe.billing_portal.Session,'create',create)
    asyncio.run(billing.portal(identity,cancel=True))
    assert create.call_args.kwargs['customer']=='cus_owner'
    assert create.call_args.kwargs['flow_data']=={'type':'subscription_cancel','subscription_cancel':{'subscription':'sub_owner'}}


def test_expired_monthly_credits_do_not_appear_spendable():
    row={'period_start':'2026-01-01T00:00:00Z','period_end':(datetime.now(timezone.utc)-timedelta(seconds=1)).isoformat(),
        'plan_key':'creator','monthly_credits':100,'monthly_remaining':20,'bonus_remaining':3,
        'subscription_status':'past_due','cancel_at_period_end':False}
    result=billing.public_wallet(row)
    assert result['credits_remaining']==3 and result['monthly_remaining']==0


def test_exhausted_wallet_returns_actionable_payment_required():
    class Table:
        def insert(self,data):return self
        def execute(self):raise ValueError('BB_CREDITS_EXHAUSTED')
    storage=GenerationStorage.__new__(GenerationStorage)
    storage.client=SimpleNamespace(table=lambda _:Table())
    with pytest.raises(HTTPException) as error:
        asyncio.run(storage.create_generation(str(uuid4()),'authenticated','cube',40))
    assert error.value.status_code==402 and 'monthly plan' in error.value.detail


def test_provider_success_does_not_charge_a_second_time():
    identity={'is_anonymous':False,'is_developer':False,'user_email':'builder@example.test'}
    assert asyncio.run(deduct_credits(identity,identity)) is identity


def test_capacity_blocks_new_checkout_before_any_stripe_mutation(monkeypatch,identity):
    monkeypatch.setattr(billing,'require_enabled',AsyncMock())
    monkeypatch.setattr(billing,'capacity',AsyncMock(return_value={'checkout_available':False}))
    create=Mock();monkeypatch.setattr(billing.stripe.checkout.Session,'create',create)
    with pytest.raises(HTTPException) as error: asyncio.run(billing.checkout(identity,'builder'))
    assert error.value.status_code==503
    create.assert_not_called()


def test_preserved_bonus_total_is_not_the_spendable_balance():
    row={'period_start':'2026-01-01T00:00:00Z','period_end':'2099-01-01T00:00:00Z',
         'plan_key':'free','monthly_credits':300,'monthly_remaining':2,'bonus_remaining':100,
         'bonus_used':4,'subscription_status':'none','cancel_at_period_end':False}
    result=billing.public_wallet(row)
    assert result['bonus_remaining']==100 and result['bonus_available']==1
    assert result['credits_remaining']==3


@pytest.mark.parametrize('code,status', [('BB_SIGN_IN_REQUIRED',403),('BB_AI_CAPACITY',503),('BB_BILLING_VERSION',503)])
def test_admission_errors_are_safe_and_actionable(code,status):
    class Table:
        def insert(self,data):return self
        def execute(self):raise ValueError(code)
    storage=GenerationStorage.__new__(GenerationStorage)
    storage.client=SimpleNamespace(table=lambda _:Table())
    with pytest.raises(HTTPException) as error: asyncio.run(storage.create_generation(str(uuid4()),'authenticated','cube',40))
    assert error.value.status_code==status


@pytest.mark.parametrize('plan,status,remaining_days,allowed', [
    ('free','none',30,False), ('builder','active',30,True), ('creator','active',30,True),
    ('master','active',30,True), ('builder','active',-1,False),
    ('creator','canceled',30,False), ('builder','past_due',1,True), ('builder','unpaid',1,False),
])
def test_paid_features_follow_paid_period_not_credit_balance(plan,status,remaining_days,allowed):
    row={'plan_key':plan,'subscription_status':status,'monthly_remaining':0,
         'cancel_at_period_end':True,
         'period_end':(datetime.now(timezone.utc)+timedelta(days=remaining_days)).isoformat()}
    assert billing.has_paid_features(row) is allowed


def test_retired_master_cannot_be_selected_but_existing_invoices_still_reconcile(monkeypatch,identity,subscription):
    assert [p['key'] for p in billing.PLANS]==['free','builder','creator']
    with pytest.raises(ValidationError): CheckoutRequest(plan_key='master')
    with pytest.raises(HTTPException) as error: asyncio.run(billing.price_for('master'))
    assert error.value.status_code==400
    subscription['items'].data[0].price.lookup_key=billing.lookup_key('master')
    subscription['items'].data[0].price.unit_amount=3900
    monkeypatch.setattr(billing.stripe.Subscription,'retrieve',Mock(return_value=subscription))
    monkeypatch.setattr(billing,'wallet',AsyncMock(return_value={'stripe_customer_id':'cus_test','stripe_subscription_id':'sub_test'}))
    grant=AsyncMock();monkeypatch.setattr(billing,'rpc',grant)
    asyncio.run(billing.sync_subscription('sub_test'))
    assert grant.call_args.kwargs['p_plan']=='master'
    assert grant.call_args.kwargs['p_allowance']==1000


@pytest.mark.parametrize('caller,plan,allowed', [('guest','free',False),('member','free',False),('member','builder',True),('member','creator',True)])
def test_instruction_endpoint_checks_plan_before_reading_any_steps(monkeypatch,identity,caller,plan,allowed):
    from fastapi.testclient import TestClient
    from fastapi.responses import Response
    from src import api
    from src.utils import auth
    monkeypatch.setattr(billing,'local_unmetered',lambda:False)
    monkeypatch.setattr(billing,'ordered_instruction_models',AsyncMock(return_value=[]))
    monkeypatch.setattr(billing,'settings',AsyncMock(return_value={'enabled':True}))
    wallet=AsyncMock(return_value={'plan_key':plan,'subscription_status':'active' if plan!='free' else 'none',
        'period_end':(datetime.now(timezone.utc)+timedelta(days=1)).isoformat()})
    monkeypatch.setattr(billing,'wallet',wallet)
    steps=AsyncMock(return_value=Response('steps',headers={'Cache-Control':'private, no-store'}))
    monkeypatch.setattr(api,'get_nova_instructions',steps)
    who=identity if caller=='member' else {'authenticated':False,'is_anonymous':True}
    api.app.dependency_overrides[auth.get_optional_identity]=lambda:who
    try:
        response=TestClient(api.app).get(f'/generation/{uuid4()}/nova-instructions.ldr')
        assert response.status_code==(200 if allowed else 403)
        if allowed: steps.assert_awaited_once()
        else:
            steps.assert_not_called()
            assert response.json()['detail']['code']=='BB_PAID_FEATURE_REQUIRED'
        if caller=='guest': wallet.assert_not_called()
        else: wallet.assert_awaited_once_with(identity['user_id'])
    finally: api.app.dependency_overrides.clear()


def test_plan_configuration_errors_do_not_grant_unmetered_features(monkeypatch):
    from src.requests.billing import plans
    monkeypatch.setattr(billing,'local_unmetered',lambda:False)
    monkeypatch.setattr(billing,'settings',AsyncMock(side_effect=RuntimeError('offline')))
    result=asyncio.run(plans())
    assert result['ready'] is False and result['enabled'] is False
    with pytest.raises(RuntimeError): asyncio.run(billing.require_paid_features({'authenticated':False}))


def test_local_and_deliberately_disabled_billing_preserve_unmetered_features(monkeypatch):
    monkeypatch.setattr(billing,'local_unmetered',lambda:True)
    config=AsyncMock(side_effect=AssertionError('local development has no database'))
    monkeypatch.setattr(billing,'settings',config)
    asyncio.run(billing.require_paid_features({}))
    asyncio.run(billing.require_instruction_access({}, str(uuid4())))
    config.assert_not_called()
    monkeypatch.setattr(billing,'local_unmetered',lambda:False)
    monkeypatch.setattr(billing,'settings',AsyncMock(return_value={'enabled':False}))
    asyncio.run(billing.require_paid_features({}))


@pytest.fixture
def order_database(monkeypatch):
    """Filter order fixtures using the same ownership fields as PostgREST."""
    rows = []

    class Query:
        def __init__(self):
            self.filters = {}
            self.max_rows = None

        def select(self, columns):
            assert 'generations!inner(user_id,user_type)' in columns
            return self

        def eq(self, field, value):
            self.filters[field] = value
            return self

        def limit(self, count):
            self.max_rows = count
            return self

        def execute(self):
            matching = [row for row in rows if all(row.get(key) == value for key, value in self.filters.items())]
            return SimpleNamespace(data=matching[:self.max_rows])

    monkeypatch.setattr(billing, 'client', lambda: SimpleNamespace(table=lambda name: Query()))
    return rows


@pytest.mark.parametrize('case,allowed', [
    ('ordered', True), ('fulfilled', True), ('cancelled', False),
    ('other_owner', False), ('other_version', False), ('anonymous_owner', False),
    ('guest', False), ('developer', False), ('no_order', False),
])
def test_free_instruction_access_requires_own_order_for_exact_model(monkeypatch, identity, order_database, case, allowed):
    from fastapi.testclient import TestClient
    from fastapi.responses import Response
    from src import api
    from src.utils import auth

    model_id = str(uuid4())
    row = {'generation_id': model_id, 'generations.user_id': identity['user_id'],
           'generations.user_type': 'authenticated', 'cancelled': False, 'fulfilled': case == 'fulfilled'}
    if case == 'cancelled': row['cancelled'] = True
    if case == 'other_owner': row['generations.user_id'] = str(uuid4())
    if case == 'other_version': row['generation_id'] = str(uuid4())
    if case == 'anonymous_owner': row['generations.user_type'] = 'anonymous'
    if case != 'no_order': order_database.append(row)
    who = identity
    if case == 'guest': who = {**identity, 'authenticated': False, 'is_anonymous': True}
    if case == 'developer': who = {**identity, 'is_developer': True}
    monkeypatch.setattr(billing, 'local_unmetered', lambda: False)
    monkeypatch.setattr(billing, 'settings', AsyncMock(return_value={'enabled': True}))
    wallet = AsyncMock(return_value={'plan_key': 'free', 'subscription_status': 'none'})
    monkeypatch.setattr(billing, 'wallet', wallet)
    steps = AsyncMock(return_value=Response('steps', headers={'Cache-Control': 'private, no-store'}))
    monkeypatch.setattr(api, 'get_nova_instructions', steps)
    api.app.dependency_overrides[auth.get_optional_identity] = lambda: who
    try:
        response = TestClient(api.app).get(f'/generation/{model_id}/nova-instructions.ldr')
        assert response.status_code == (200 if allowed else 403)
        if allowed:
            steps.assert_awaited_once_with(model_id)
            assert response.headers['cache-control'] == 'private, no-store'
            wallet.assert_not_called()
            # A kit unlocks instructions only, never general paid features.
            with pytest.raises(HTTPException) as error:
                asyncio.run(billing.require_paid_features(identity))
            assert error.value.status_code == 403
        else:
            steps.assert_not_called()
    finally:
        api.app.dependency_overrides.clear()


def test_ordered_model_list_deduplicates_active_orders_and_ignores_other_accounts(identity, order_database):
    model_id = str(uuid4())
    order = {'generation_id': model_id, 'generations.user_id': identity['user_id'],
             'generations.user_type': 'authenticated', 'cancelled': False}
    order_database.extend([order, order.copy(), {**order, 'generation_id': str(uuid4()), 'cancelled': True},
                          {**order, 'generation_id': str(uuid4()), 'generations.user_id': str(uuid4())}])
    assert asyncio.run(billing.ordered_instruction_models(identity['user_id'])) == [model_id]


def test_account_exposes_order_access_independently_of_subscription(monkeypatch, identity):
    row = {'period_start': '2026-01-01T00:00:00Z', 'period_end': '2026-02-01T00:00:00Z',
           'plan_key': 'free', 'monthly_credits': 300, 'monthly_remaining': 0, 'bonus_remaining': 0,
           'subscription_status': 'none', 'cancel_at_period_end': False}
    monkeypatch.setattr(billing, 'wallet', AsyncMock(return_value=row))
    monkeypatch.setattr(billing, 'client', Mock())
    monkeypatch.setattr(billing, 'execute_query', AsyncMock(return_value=SimpleNamespace(data=[])))
    monkeypatch.setattr(billing, 'settings', AsyncMock(return_value={'enabled': True, 'policy_version': 2}))
    monkeypatch.setattr(billing, 'capacity', AsyncMock(return_value={}))
    orders = AsyncMock(return_value=[str(uuid4())])
    monkeypatch.setattr(billing, 'ordered_instruction_models', orders)
    result = asyncio.run(billing.account(identity))
    assert result['ordered_instruction_models'] == orders.return_value
    assert result['paid_features'] is False
    orders.assert_awaited_once_with(identity['user_id'])
