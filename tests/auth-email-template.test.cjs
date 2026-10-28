const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const directory = path.join(__dirname, '../supabase/templates');
const config = JSON.parse(fs.readFileSync(path.join(directory, 'confirmation.json'), 'utf8'));
const template = fs.readFileSync(path.join(directory, config.content_path), 'utf8');

test('signup email has a Supabase verification link, not a plain app link', () => {
  assert.match(template, /<a\s+href="\{\{ \.ConfirmationURL \}\}"[^>]*>Verify email<\/a>/);
  assert.match(config.mailer_subjects_confirmation, /Verify your email/);
  assert.doesNotMatch(template, /<script|javascript:|access_token=/i);
});

test('first-time email-code signup can still use the same confirmation email', () => {
  assert.match(template, /\{\{ \.Token \}\}/);
  assert.match(template, /If the app is asking for a verification code/);
  assert.ok(template.indexOf('Verify email</a>') < template.indexOf('{{ .Token }}'));
  assert.match(template, /name="viewport"/);
  assert.match(template, /max-width: 600px/);
});


test('native iOS delivery has code instructions with no link, while web keeps its button', () => {
  const parts = template.split('{{ if eq .RedirectTo "https://brickbuilder.ai/login?verification=ios-code" }}');
  assert.equal(parts.length, 2);
  const [ios, rest] = parts[1].split('{{ else }}');
  const [web, shared] = rest.split('{{ end }}');
  assert.match(ios, /Enter the code below in the BrickBuilder app/);
  assert.doesNotMatch(ios, /href=|ConfirmationURL|Click the button/);
  assert.match(web, /href="\{\{ \.ConfirmationURL \}\}"/);
  assert.match(shared, /\{\{ \.Token \}\}/);
});
