"""Email-safe, responsive order confirmation rendering."""
from html import escape
from urllib.parse import urlencode, urlsplit
from .instruction_links import instruction_link

PET_NAMES = {'pip': 'Pip', 'nib': 'Nib', 'clik': 'Clik'}


def order_email_content(order_id, generation_id, generation, pet_id=None, *, instruction_key=None):
    model_url = 'https://brickbuilder.ai/?' + urlencode({'id': generation_id, 'exact': '1'})
    instructions_url = instruction_link(generation_id, instruction_key) if instruction_key else model_url + '&instructions=1'
    title = ' '.join(str(generation.get('name') or 'Your custom brick model').split())[:120]
    preview = generation.get('preview_image_url') or ''
    try:
        parsed = urlsplit(preview)
        safe_preview = parsed.scheme == 'https' and bool(parsed.hostname) and not parsed.username
    except (ValueError, TypeError):
        safe_preview = False
    image = ''
    if safe_preview:
        image = f'<img src="{escape(preview, quote=True)}" alt="{escape(title, quote=True)} model preview" width="536" style="display:block;width:100%;max-width:536px;height:auto;border:0;border-radius:12px;">'
    pet = ''
    if pet_id in PET_NAMES:
        name = PET_NAMES[pet_id]
        pet = f'''<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:24px;background:#fff7ed;border-radius:12px;">
<tr><td width="96" style="padding:16px 0 16px 12px;"><img src="https://brickbuilder.ai/pets/email/{pet_id}.png" alt="{name}, your building buddy" width="84" style="display:block;width:84px;height:auto;border:0;"></td>
<td style="padding:16px 16px 16px 8px;color:#475569;font-size:14px;line-height:1.6;"><strong style="color:#1e293b;">{name} is ready to build with you.</strong><br>A little imagination. A lot of possibilities.</td></tr></table>'''
    buttons = ''
    for label, url, color in [('View your model', model_url, '#1e293b'), ('View building instructions', instructions_url, '#ef4444')]:
        buttons += f'<tr><td align="center" bgcolor="{color}" style="border-radius:8px;"><a href="{escape(url, quote=True)}" style="display:block;padding:16px 12px;background:{color};color:#ffffff;text-decoration:none;border-radius:8px;font-size:16px;line-height:1.4;font-weight:bold;">{label}</a></td></tr><tr><td height="12"></td></tr>'
    html = f'''<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Your BrickBuilder order is confirmed</title></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:Arial,Helvetica,sans-serif;color:#1e293b;">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">Your bricks are one step closer. Explore your model and building instructions.</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f8fafc;"><tr><td align="center" style="padding:32px 12px;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;">
<tr><td align="center" style="padding:0 0 24px;font-size:30px;letter-spacing:-1px;font-weight:800;"><span style="color:#ef4444;">BRICK</span>BUILDER</td></tr>
<tr><td style="background:#ffffff;border:1px solid #e2e8f0;border-top:6px solid #ef4444;border-radius:16px;padding:28px 20px;">
<p style="margin:0 0 12px;color:#ef4444;font-size:12px;font-weight:bold;letter-spacing:2px;">LET’S BUILD SOMETHING GREAT</p>
<h1 style="margin:0 0 12px;font-size:28px;line-height:1.2;">Order confirmed!</h1>
<p style="margin:0 0 24px;color:#475569;font-size:16px;line-height:1.7;">We've received your order. Please allow <strong>8–12 business days</strong> for your bricks to arrive.</p>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f8fafc;border-radius:12px;"><tr><td style="padding:12px;">{image}
<h2 style="margin:16px 4px 8px;font-size:20px;line-height:1.4;overflow-wrap:anywhere;">{escape(title)}</h2>
<p style="margin:0 4px 12px;color:#64748b;font-size:13px;overflow-wrap:anywhere;">Order #{escape(str(order_id))}</p></td></tr></table>
<p style="margin:24px 0 16px;color:#475569;font-size:15px;line-height:1.6;">Take another look at your model or open your step-by-step building instructions.</p>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0">{buttons}</table>
{pet}
<p style="margin:24px 0 0;color:#475569;font-size:15px;line-height:1.6;">Happy building!<br>The BrickBuilder Team</p>
</td></tr><tr><td align="center" style="padding:24px 12px;color:#64748b;font-size:13px;line-height:1.7;">Need a hand with your order?<br><a href="mailto:support@brickbuilder.ai" style="color:#ef4444;text-decoration:none;">support@brickbuilder.ai</a></td></tr>
</table></td></tr></table></body></html>'''
    return {'html': html, 'text': f"Order confirmed!\n\n{title}\nOrder #{order_id}\n\nPlease allow 8–12 business days for your bricks to arrive.\n\nView your model: {model_url}\nView building instructions: {instructions_url}\n\nHappy building!\nThe BrickBuilder Team\nSupport: support@brickbuilder.ai",
            'reply_to': 'support@brickbuilder.ai'}
