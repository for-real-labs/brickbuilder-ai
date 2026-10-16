const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync, existsSync } = require('node:fs');
const path = require('node:path');

const directory = path.resolve(__dirname, '../plugins/brickbuilder');
const manifest = JSON.parse(readFileSync(path.join(directory, 'plugin.json'), 'utf8'));
const config = JSON.parse(readFileSync(path.join(directory, 'mcp.json'), 'utf8'));

test('public plugin connects with the registered production OAuth client and email scope', () => {
  const server = config.mcpServers.brickbuilder;
  const auth = server.extensions['com.openai'].auth;
  assert.equal(server.url, 'https://brickai-backend-production.up.railway.app/mcp');
  assert.equal(auth.type, 'oauth');
  assert.equal(auth.resource, server.url);
  assert.equal(auth.client.mode, 'provided');
  assert.match(auth.client.clientId, /^[\da-f-]{36}$/);
  // Public PKCE clients cannot use a fabricated client secret, and this
  // deployment must not implicitly request Supabase's optional OpenID scope.
  assert.equal(auth.client.tokenEndpointAuthMethod, 'none');
  assert.deepEqual(auth.baseScopes, ['email']);
  assert.deepEqual(auth.defaultScopes, ['email']);
  assert.equal(auth.oidcEnabled, false);
});

test('submission includes required listing links and square PNG artwork', () => {
  const listing = manifest.extensions['com.openai'].interface;
  assert.ok(listing.shortDescription.length <= 30);
  for (const field of ['websiteURL', 'supportURL', 'privacyPolicyURL', 'termsOfServiceURL']) {
    assert.equal(new URL(listing[field]).protocol, 'https:');
  }
  for (const field of ['logo', 'composerIcon']) {
    const file = path.resolve(directory, listing[field]);
    assert.ok(file.startsWith(directory + path.sep));
    assert.ok(existsSync(file));
    const bytes = readFileSync(file);
    assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
    assert.equal(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
    assert.ok(bytes.readUInt32BE(16) >= 48);
  }
});

test('public package contains no secret headers, account credentials or unsupported app mappings', () => {
  const forbidden = new Set(['headers', 'clientSecret', 'password', 'test_credentials', 'reviewer_instructions', 'apps', 'hooks']);
  function inspect(value) {
    if (!value || typeof value !== 'object') return;
    for (const [key, entry] of Object.entries(value)) {
      assert.ok(!forbidden.has(key), `Do not package ${key}`);
      inspect(entry);
    }
  }
  inspect(manifest);
  inspect(config);
});
