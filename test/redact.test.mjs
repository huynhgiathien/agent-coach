// S2: secrets never survive redact().
import test from 'node:test';
import assert from 'node:assert/strict';
import { redact } from '../lib/redact.mjs';

const SECRETS = {
  'OpenAI-style key': 'sk-abcdefghijklmnopqrstuv12',
  'GitHub token': `ghp_${'A1b2'.repeat(6)}`,
  'GitHub fine-grained PAT': `github_pat_${'A1_b'.repeat(6)}`,
  'Slack token': 'xoxb-1234567890-abcdefghij',
  'AWS access key': 'AKIAABCDEFGHIJKLMNOP',
  JWT: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop',
  'Bearer token': 'Bearer abcdefghijklmnop1234',
  'hex secret': '0123456789abcdef0123456789abcdef',
  'base64 blob': 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo0MTIzNDU2Nzg5',
};

for (const [label, secret] of Object.entries(SECRETS)) {
  test(`redacts ${label}`, () => {
    assert.equal(redact(`before ${secret} after`), 'before [REDACTED] after');
  });
}

test('keeps the key and separator of key=value secrets', () => {
  assert.equal(redact('password: hunter2xyz'), 'password: [REDACTED]');
  assert.equal(redact('use token=abc123def now'), 'use token=[REDACTED] now');
  assert.equal(redact('API_KEY = s3cr3tvalue'), 'API_KEY = [REDACTED]');
});

test('leaves ordinary prompt text untouched', () => {
  const text = 'draft a comment for FRO-1, shorter version please';
  assert.equal(redact(text), text);
});

test('redacts plain-language passwords that contain a digit', () => {
  assert.equal(redact('login with user bob and pass 123qweasD'), 'login with user bob and pass [REDACTED]');
  assert.equal(redact('password is hunter2x'), 'password is [REDACTED]');
  assert.equal(redact('make the build pass the tests'), 'make the build pass the tests');
});

test('redacts a bare password token mixing lowercase, uppercase and digits', () => {
  assert.equal(redact('ThienHuynh 123qweasD'), 'ThienHuynh [REDACTED]');
});

test('leaves identifiers, ticket keys and path segments that look password-like', () => {
  for (const text of ['use ImagePlacementProcessor for it', 'see FRO-12580 and SWA-7494', 'path /a/B2cdefgh/x']) {
    assert.equal(redact(text), text);
  }
});
