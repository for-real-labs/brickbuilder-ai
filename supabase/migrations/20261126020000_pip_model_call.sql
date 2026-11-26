-- Give Pip the existing All parts mode, credit reservation, spend settlement and ready emails.
CREATE OR REPLACE FUNCTION public.assign_generation_mode() returns trigger
language plpgsql set search_path = public as $$
declare source_mode text;
begin
  if new.endpoint in ('novaToBricks', 'pipModelCall') then
    new.mode := 'all_parts';
  elsif new.endpoint in ('updateModel', 'resizeModel', 'promptEditModel') then
    select g.mode into source_mode from public.generations g
      where g.id = new.generation_id;
    new.mode := coalesce(source_mode, new.mode, 'basic_bricks');
  else
    new.mode := 'basic_bricks';
  end if;
  return new;
end;
$$;

CREATE OR REPLACE FUNCTION public.billing_reserve_generation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE a public.billing_accounts; chosen_bucket text; cost integer; apple_cost integer:=0; monthly_cost integer;
BEGIN
 IF NEW.personal_billing THEN RETURN NEW; END IF;
 IF NOT (SELECT enabled FROM public.billing_settings WHERE id) THEN RETURN NEW; END IF;
 IF NEW.billing_policy_version<>2 THEN RAISE EXCEPTION 'BB_BILLING_VERSION'; END IF;
 IF NEW.endpoint IN ('updateModel','resizeModel','uploadLdraw','glbToBricks','objToBricks') THEN RETURN NEW; END IF;
 IF NEW.endpoint NOT IN ('llmToBricks','novaToBricks','pipModelCall','textToBricks','imageToBricks','promptEditModel') THEN
   RAISE EXCEPTION 'BB_BILLING_VERSION';
 END IF;
 cost:=CASE WHEN NEW.endpoint='llmToBricks' THEN 2 ELSE 20 END;
 IF NEW.user_type<>'anonymous' AND NEW.user_id<>'developer' THEN
   a:=public.billing_account(NEW.user_id::uuid,NEW.billing_livemode);
   monthly_cost:=least(cost,CASE WHEN a.period_end>now() THEN a.monthly_remaining ELSE 0 END);
   apple_cost:=cost-monthly_cost;
   IF greatest(0,a.apple_remaining)>=apple_cost THEN
     chosen_bucket:=CASE WHEN monthly_cost=0 THEN 'apple' ELSE 'monthly' END;
     UPDATE public.billing_accounts SET monthly_remaining=monthly_remaining-monthly_cost,
       apple_remaining=apple_remaining-apple_cost WHERE user_id=a.user_id AND livemode=a.livemode;
   ELSIF cost=2 AND a.bonus_remaining>=cost AND a.bonus_used+cost<=5 THEN
     chosen_bucket:='bonus'; apple_cost:=0;
     UPDATE public.billing_accounts SET bonus_remaining=bonus_remaining-cost,bonus_used=bonus_used+cost WHERE user_id=a.user_id AND livemode=a.livemode;
   ELSE RAISE EXCEPTION 'BB_CREDITS_EXHAUSTED';
   END IF;
   INSERT INTO public.billing_credit_history(user_id,livemode,reference,kind,amount,bucket,period_start,apple_amount)
   VALUES(a.user_id,a.livemode,NEW.id::text,'generation',-cost,chosen_bucket,
     CASE chosen_bucket WHEN 'bonus' THEN a.bonus_period_start ELSE a.period_start END,apple_cost);
 END IF;
 -- $20 per-job provider limit plus $1 for title/auxiliary work. No refund erases spend.
 PERFORM public.billing_reserve_ai(NEW.id::text,NEW.billing_livemode,'generation',21);
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.billing_generation_spend() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 -- Only successfully finished, fully tracked Basic/All parts jobs release the hold.
 -- Legacy mesh pipelines have unreported provider spend, so retain $21 conservatively.
 IF NEW.status='completed' AND NEW.endpoint IN ('llmToBricks','novaToBricks','pipModelCall')
    AND NEW.ai_usage->>'finalized'='true'
    AND jsonb_array_length(coalesce(NEW.ai_usage->'calls','[]'::jsonb))>0 AND NEW.estimated_cost_usd IS NOT NULL THEN
   PERFORM public.billing_settle_ai(NEW.id::text,NEW.billing_livemode,NEW.estimated_cost_usd);
 END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.generation_can_send_ready_email(endpoint text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT coalesce(endpoint IN ('llmToBricks','novaToBricks','pipModelCall','textToBricks','imageToBricks','promptEditModel'), false);
$$;
