"""Provision the versioned credit catalog and cancellation portal. No charges.

Run with --env-file pointing to existing configuration; --live is explicit.
Prints resource IDs only. Does not enable billing or change webhook delivery.
"""
import argparse
import os
import sys
from pathlib import Path

from dotenv import load_dotenv
import stripe

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def provision(key, live, plans, tag):
    catalog = []
    for plan in plans:
        lookup = f"brickbuilder_{plan['key']}_monthly_v3"
        found = stripe.Price.list(lookup_keys=[lookup], limit=2, api_key=key).data
        if found:
            price = found[0]
            if (len(found) != 1 or price.unit_amount != plan['monthly_cents'] or price.currency != 'usd'
                    or price.recurring.interval != 'month' or price.recurring.interval_count != 1
                    or not price.active or price.livemode is not live):
                raise ValueError('Existing catalog does not match the approved monthly plans')
        else:
            product = stripe.Product.create(name=f"BrickBuilder {plan['name']}",
                description=f"{plan['credits']} credits each month. Basic builds: 1 credit. All parts and AI mesh conversions: 15 credits. Cancel anytime.",
                metadata={'integration': tag, 'plan_key': plan['key']},
                idempotency_key=f"bb-product-v3:{plan['key']}", api_key=key)
            price = stripe.Price.create(product=product.id, unit_amount=plan['monthly_cents'], currency='usd',
                recurring={'interval':'month'}, lookup_key=lookup, metadata={'integration':tag},
                idempotency_key=f"bb-price-v3:{plan['key']}", api_key=key)
        catalog.append({'product':price.product, 'prices':[price.id]})
        print(plan['key'], price.id, plan['monthly_cents'], 'cents/month', plan['credits'], 'credits')
    configs = stripe.billing_portal.Configuration.list(limit=100, api_key=key).data
    config = next((c for c in configs if c.get('metadata', {}).get('integration') == tag), None)
    args = dict(
        business_profile={'headline':'Build your next idea with BrickBuilder',
            'privacy_policy_url':'https://brickbuilder.ai/privacy', 'terms_of_service_url':'https://brickbuilder.ai/terms'},
        default_return_url='https://brickbuilder.ai/billing', metadata={'integration':tag},
        features={
            'invoice_history':{'enabled':True}, 'payment_method_update':{'enabled':True},
            'subscription_cancel':{'enabled':True,'mode':'at_period_end','proration_behavior':'none'},
            'subscription_update':{'enabled':True,'default_allowed_updates':['price'],'products':catalog,
                'proration_behavior':'always_invoice',
                'schedule_at_period_end':{'conditions':[{'type':'decreasing_item_amount'}]}},
        })
    if config:
        config = stripe.billing_portal.Configuration.modify(config.id, **args, api_key=key)
    else:
        config = stripe.billing_portal.Configuration.create(**args, idempotency_key='bb-portal-v3', api_key=key)
    print('portal',config.id,'cancellation',config.features.subscription_cancel.mode)
    return config.id


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--env-file',required=True)
    parser.add_argument('--live',action='store_true')
    args=parser.parse_args()
    load_dotenv(args.env_file,override=True)
    from src.utils.billing import PAID_PLANS, BILLING_TAG
    key=os.environ['STRIPE_SECRET_KEY_LIVE' if args.live else 'STRIPE_SECRET_KEY']
    provision(key,args.live,PAID_PLANS.values(),BILLING_TAG)
