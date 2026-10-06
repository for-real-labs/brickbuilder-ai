"""Durable opt-in completion emails; no campaign enrollment or client secrets."""
import asyncio
import html
import logging
import os
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode, urlsplit

import httpx

logger = logging.getLogger(__name__)


def notification_origin():
    configured = os.getenv('GENERATION_NOTIFICATION_ORIGIN')
    if configured:
        return configured.rstrip('/')
    if os.getenv('RAILWAY_ENVIRONMENT_NAME') == 'staging':
        return 'https://brickbuilderai-git-staging-jjohnson3700team.vercel.app'
    return 'https://brickbuilder.ai'


def sender():
    # Dedicated authenticated notification sender; never silently fall back to marketing.
    return os.getenv('GENERATION_NOTIFICATION_FROM')


def email_payload(row):
    title = ' '.join(row['title'].split())[:120] or 'Your brick model'
    url = row['origin'] + '/generated-model?' + urlencode({'id': row['generation_id'], 'exact': '1'})
    escaped_url = html.escape(url, quote=True)
    escaped_title = html.escape(title)
    preview = row.get('preview_image_url')
    # Only embed a public web image; older jobs and unavailable previews still send.
    image = ''
    try:
        preview_url = urlsplit(preview or '')
    except ValueError:
        preview_url = urlsplit('')
    if preview_url.scheme == 'https' and preview_url.netloc:
        image = (f'<a href="{escaped_url}">'
                 f'<img src="{html.escape(preview, quote=True)}" '
                 f'alt="Preview of {html.escape(title, quote=True)}" width="560" '
                 'style="display:block;width:100%;max-width:560px;height:auto;border-radius:12px;border:0;">'
                 '</a>')
    email_html = f'''<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>{escaped_title} is ready!</title></head>
<body style="margin:0;padding:0;background-color:#f8fafc;font-family:Arial,sans-serif;color:#1e293b;">
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">Your model is ready. Open it and bring your build to life.</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:#f8fafc;">
    <tr><td align="center" style="padding:32px 12px;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;">
        <tr><td align="center" style="padding:0 0 28px;font-size:32px;font-weight:800;letter-spacing:-0.5px;">
          <span style="color:#ef4444;">BRICK</span><span style="color:#1e293b;">BUILDER</span>
        </td></tr>
        <tr><td style="background-color:#ffffff;border:1px solid #e2e8f0;border-radius:12px;padding:28px 20px;">
          <h1 style="font-size:24px;line-height:1.3;margin:0 0 12px;overflow-wrap:anywhere;">{escaped_title} is ready!</h1>
          <p style="color:#475569;font-size:16px;line-height:1.6;margin:0 0 24px;">Your idea has turned into a brick model. Take a look and make it your own.</p>
          {image}
          <table role="presentation" cellspacing="0" cellpadding="0" style="margin:24px 0;">
            <tr><td bgcolor="#ef4444" style="border-radius:6px;text-align:center;">
              <a href="{escaped_url}" style="display:inline-block;background-color:#ef4444;color:#ffffff;padding:14px 24px;text-decoration:none;border-radius:6px;font-size:16px;line-height:1.4;font-weight:600;">See your model</a>
            </td></tr>
          </table>
          <p style="color:#475569;font-size:16px;line-height:1.6;margin:0;">Happy building!<br>The BrickBuilder Team</p>
        </td></tr>
        <tr><td align="center" style="padding:24px 12px 0;color:#64748b;font-size:14px;line-height:1.6;">
          <p style="margin:0 0 12px;">Have any questions? Email us at<br><a href="mailto:support@brickbuilder.ai" style="color:#ef4444;text-decoration:none;">support@brickbuilder.ai</a></p>
          <p style="margin:0;font-size:12px;">You asked us to let you know when this model was ready.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>'''
    return {'from': sender(), 'to': [row['email']], 'reply_to': 'support@brickbuilder.ai',
            'subject': f'{title} is ready!',
            'text': f'{title} is ready!\n\nYour idea has turned into a brick model. Take a look and make it your own.\n\nSee your model: {url}\n\nHappy building!\nThe BrickBuilder Team\n\nHave any questions? Email support@brickbuilder.ai\n\nYou asked us to let you know when this model was ready.',
            'html': email_html}


async def deliver_one(client, transport=None):
    row = await asyncio.to_thread(lambda: client.rpc('claim_generation_email', {'p_origin': notification_origin()}).execute())
    if not row.data:
        return False
    row = row.data[0]
    try:
        async with httpx.AsyncClient(transport=transport, timeout=20) as http:
            response = await http.post('https://api.resend.com/emails', json=email_payload(row),
                headers={'Authorization': 'Bearer ' + os.environ['RESEND_API_KEY'],
                         'Idempotency-Key': 'generation-ready/' + row['generation_id']})
        if response.is_success and response.json().get('id'):
            update = {'state': 'sent', 'sent_at': datetime.now(timezone.utc).isoformat(), 'provider_id': response.json()['id']}
        elif response.status_code in (408,429) or response.status_code >= 500:
            update = {'state': 'pending', 'available_at': (datetime.now(timezone.utc) + timedelta(seconds=min(3600, 60 * 2 ** row['attempts']))).isoformat()}
        else:
            # Suppressions, invalid recipients and permanent provider errors are never retried.
            update = {'state': 'failed'}
    except (httpx.HTTPError, ValueError):
        update = {'state': 'pending', 'available_at': (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat()}
    if update['state'] == 'pending' and row['attempts'] >= 6:
        update = {'state': 'failed'}
    await asyncio.to_thread(lambda: client.table('generation_email_outbox').update(update)
                            .eq('generation_id', row['generation_id']).eq('lease_id', row['lease_id']).execute())
    return True


async def email_worker(client):
    while True:
        try:
            if not await deliver_one(client):
                await asyncio.sleep(15)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.warning('Completion email delivery unavailable; retrying without affecting generations')
            await asyncio.sleep(30)


def start_email_worker(client):
    enabled = os.getenv('GENERATION_NOTIFICATION_WORKER', 'true' if os.getenv('RAILWAY_ENVIRONMENT_NAME') else 'false') == 'true'
    if client and enabled and sender() and os.getenv('RESEND_API_KEY'):
        return asyncio.create_task(email_worker(client))
    return None
