import asyncio
import json
import os
from pathlib import Path
import pwd
import subprocess
from fastapi.testclient import TestClient
from brickbuilder_integration import gateway

def tool(tenant, script):
    account, data, config, toolkit = gateway.prepare_tenant(tenant)
    user = pwd.getpwnam(account)
    env = {'PATH': os.environ['PATH'], 'PYTHONPATH': str(toolkit), 'HOME': str(data), 'LDRAW_DIR': '/opt/ldraw/ldraw'}
    result = subprocess.run([str(toolkit / '.venv/bin/python'), '-c', script],
        cwd=toolkit, env=env, user=user.pw_uid, group=user.pw_gid, extra_groups=[],
        capture_output=True, text=True, timeout=300)
    assert result.returncode == 0, result.stderr + result.stdout
    return json.loads(result.stdout)

with TestClient(gateway.app):
    a, b = 'a'*64, 'b'*64
    code = "import json; from ldraw_tools.common import get_parts; from ldraw_tools.discovery import DiscoveryIndex; i=DiscoveryIndex(get_parts()); print(json.dumps({'cache':str(i.cache),'index':i.ensure()['index']}))"
    first, second = tool(a, code), tool(b, code)
    assert first == second, (first, second)
    assert len(list(Path('/data/reference-cache').rglob('catalog.sqlite'))) == 1
    assert not list(Path('/data/tenants').glob('*/toolkit-*/.cache/discovery'))
    search = "import json; from ldraw_tools.common import get_parts; from ldraw_tools.discovery import DiscoveryIndex,search; i=DiscoveryIndex(get_parts()); print(json.dumps(search(i,'parts','brick',engine='fts',limit=2,pool=2)))"
    result = tool(a, search)
    assert result['results']
    indexes = list(Path('/data/reference-cache').rglob('catalog.sqlite'))
    for p in indexes:
        assert p.stat().st_mode & 0o022 == 0
    # Cold return after complete shared cache eviction: same public index,
    # existing owner can rebuild and find references without session deletion.
    import shutil
    shutil.rmtree('/data/reference-cache')
    returned = tool(b, search)
    assert returned['results']
    print(json.dumps({'owners_share_index':first == second,'reference_results':len(returned['results']), 'regenerated_after_eviction':True}))
