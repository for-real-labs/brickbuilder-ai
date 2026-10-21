from pathlib import Path

import pytest

from src.utils.order_email import order_email_content


@pytest.mark.parametrize('pet', ['pip', 'nib', 'clik'])
def test_confirmation_includes_model_preview_and_selected_pet(pet):
    content = order_email_content(12, 'model/123', {'name': 'Moon <Rocket>', 'preview_image_url': 'https://example.com/preview.png?a=1&b=2'}, pet)
    html = content['html']
    assert 'Moon &lt;Rocket&gt;' in html
    assert 'https://example.com/preview.png?a=1&amp;b=2' in html
    assert f'/pets/email/{pet}.png' in html
    assert Path(f'../frontend/public/pets/email/{pet}.png').read_bytes().startswith(b'\x89PNG')
    assert 'id=model%2F123&amp;exact=1&amp;instructions=1' in html
    assert 'View your model: https://brickbuilder.ai/?id=model%2F123&exact=1' in content['text']


@pytest.mark.parametrize('preview', [None, '', 'javascript:alert(1)', 'data:image/png;base64,abc', 'http://example.com/x', 'https://[broken'])
def test_missing_or_unsafe_preview_keeps_links_without_broken_image(preview):
    content = order_email_content('<unsafe>', 'g', {'preview_image_url': preview}, '../bad')
    assert '<img' not in content['html']
    assert '&lt;unsafe&gt;' in content['html']
    assert 'View building instructions' in content['html']
