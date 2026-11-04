# Website maintenance

Production serves a temporary maintenance page on `brickbuilder.ai` and `www.brickbuilder.ai`. Login, the dashboard (including its profile menu), and billing remain available.
To reopen the website, set `BRICKBUILDER_MAINTENANCE=off` in the production Vercel environment and redeploy, or revert the maintenance gate.

Signups are stored in Supabase's `public.waitlist_emails` with `maintenance_alert = true`.
Build completion emails are separate. Reopening the website does not automatically send a message.

If redeploying the signup function, apply the maintenance email migration first, then deploy the `maintenance-alert` Edge Function with `--no-verify-jwt` so visitors can sign up without an account.
