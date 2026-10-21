import pytest
from fastapi import HTTPException
from starlette.requests import Request

from src.utils.guest_ip import guest_ip_hash


def request(peer='192.0.2.1', headers=()):
    return Request({'type': 'http', 'headers': headers, 'client': (peer, 1234) if peer else None})


@pytest.fixture(autouse=True)
def config(monkeypatch):
    monkeypatch.setenv('GUEST_IP_HASH_SECRET', 'test-stable-secret')
    monkeypatch.setenv('GUEST_IP_SOURCE', 'peer')


def test_peer_ignores_user_agent_browser_secret_and_spoofed_headers():
    expected = guest_ip_hash(request())
    for name in ['x-real-ip', 'x-forwarded-for', 'cf-connecting-ip', 'user-agent', 'x-guest-session']:
        assert guest_ip_hash(request(headers=[(name.encode(), b'198.51.100.9')])) == expected
    assert guest_ip_hash(request('198.51.100.9')) != expected
    assert expected.startswith('ip_v1_') and len(expected) == 70
    assert '192.0.2.1' not in expected


def test_railway_uses_single_edge_ip_not_shared_proxy_or_xff(monkeypatch):
    first = guest_ip_hash(request('198.51.100.9'))
    monkeypatch.setenv('GUEST_IP_SOURCE', 'railway')
    assert guest_ip_hash(request('10.0.0.1', [(b'x-real-ip', b'198.51.100.9'), (b'x-forwarded-for', b'fake')])) == first
    assert guest_ip_hash(request('10.0.0.2', [(b'x-real-ip', b'198.51.100.9')])) == first
    assert guest_ip_hash(request('10.0.0.1', [(b'x-real-ip', b'192.0.2.1')])) != first


@pytest.mark.parametrize('headers', [[], [(b'x-real-ip', b'invalid')], [(b'x-real-ip', b'192.0.2.1, 192.0.2.2')],
    [(b'x-real-ip', b'192.0.2.1'), (b'x-real-ip', b'192.0.2.2')], [(b'x-real-ip', b'fe80::1%eth0')]])
def test_invalid_railway_headers_fail_closed(monkeypatch, headers):
    monkeypatch.setenv('GUEST_IP_SOURCE', 'railway')
    with pytest.raises(HTTPException) as exc:
        guest_ip_hash(request(headers=headers))
    assert exc.value.status_code == 503


def test_ip_normalization_prevents_mapped_ipv4_and_ipv6_privacy_rotation():
    assert guest_ip_hash(request('::ffff:192.0.2.1')) == guest_ip_hash(request())
    assert guest_ip_hash(request('2001:db8:abcd:1::1')) == guest_ip_hash(request('2001:0db8:abcd:0001::abcd'))
    assert guest_ip_hash(request('2001:db8:abcd:1::1')) != guest_ip_hash(request('2001:db8:abcd:2::1'))


def test_missing_secret_or_address_does_not_group_everyone_into_unknown(monkeypatch):
    monkeypatch.delenv('GUEST_IP_HASH_SECRET')
    monkeypatch.delenv('SUPABASE_SERVICE_ROLE_KEY', raising=False)
    with pytest.raises(HTTPException): guest_ip_hash(request())
    assert guest_ip_hash(request(), local=True).startswith('ip_v1_')
    with pytest.raises(HTTPException): guest_ip_hash(request(None), local=True)


@pytest.mark.parametrize('railway,override,expected', [(False, None, ''), (True, None, 'railway'), (True, 'peer', 'peer')])
def test_hosted_launcher_enables_railway_mode_only_in_railway(tmp_path, railway, override, expected):
    import os
    import subprocess
    from pathlib import Path
    for name in ('Xvfb', 'sleep'):
        executable = tmp_path / name
        executable.write_text('#!/bin/sh\nexit 0\n')
        executable.chmod(0o755)
    executable = tmp_path / 'uv'
    executable.write_text('#!/bin/sh\nprintf "%s\\n" "${GUEST_IP_SOURCE:-}" "$@"\n')
    executable.chmod(0o755)
    environment = {**os.environ, 'PATH': str(tmp_path) + os.pathsep + os.environ['PATH']}
    environment.pop('GUEST_IP_SOURCE', None)
    environment.pop('RAILWAY_ENVIRONMENT_ID', None)
    if railway: environment['RAILWAY_ENVIRONMENT_ID'] = 'test-environment'
    if override: environment['GUEST_IP_SOURCE'] = override
    result = subprocess.run(['bash', str(Path(__file__).parents[1] / 'start.sh')],
                            env=environment, capture_output=True, text=True, check=True)
    assert result.stdout.splitlines()[0] == expected
    assert '--no-proxy-headers' in result.stdout.splitlines()
