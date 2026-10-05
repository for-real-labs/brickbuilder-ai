"""Translate Nova's own browser-login API into the existing local settings UI."""
import os

from .nova_service import NovaService, connection


class NovaProviderConnections:
    async def status(self, provider):
        key = 'OPENAI_API_KEY' if provider == 'openai' else 'ANTHROPIC_API_KEY'
        try:
            async with NovaService() as nova:
                login = await nova.request('GET', f'api/auth/{provider}')
            available = True
        except ValueError:
            login = {'status': 'error', 'message': 'Start the private Nova runtime with npm run setup:nova.'}
            available = False
        return {'id': provider, 'label': 'ChatGPT' if provider == 'openai' else 'Claude',
                'api_key_configured': bool(os.getenv(key)), 'cli_available': available,
                'cli_connected': login.get('status') == 'connected', 'login': login,
                'capabilities': ['api_key', 'browser_login'], 'install_hint': 'npm run setup:nova'}

    async def start(self, provider, *, restart=False, connection='google'):
        async with NovaService() as nova:
            await nova.request('POST', f'api/auth/{provider}/login',
                               json={'restart': restart, 'flow': 'device' if provider == 'openai' else 'browser'})
        return await self.status(provider)

    async def cancel(self, provider):
        async with NovaService() as nova:
            await nova.request('POST', f'integration/auth/{provider}/cancel')

    async def submit_code(self, provider, code):
        async with NovaService() as nova:
            await nova.request('POST', f'api/auth/{provider}/code', json={'code': code})


nova_provider_connections = NovaProviderConnections()


def use_nova_connection(provider):
    if provider not in {'openai', 'anthropic'}:
        return False
    try:
        connection()
        return True
    except ValueError:
        return False
