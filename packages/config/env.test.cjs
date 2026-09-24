const assert = require('node:assert/strict');
const { test } = require('node:test');
const { frontendEnv } = require('./env.cjs');

test('frontend validates required settings', () => {
  assert.throws(() => frontendEnv({}), /APP_ENV/);
  assert.throws(() => frontendEnv({ APP_ENV: 'development' }), /NEXT_PUBLIC_API_URL/);
  assert.throws(() => frontendEnv({ APP_ENV: 'unknown' }), /APP_ENV/);
  assert.throws(() => frontendEnv({ APP_ENV: 'development', NEXT_PUBLIC_API_URL: 'not-a-url' }), /NEXT_PUBLIC_API_URL/);
  assert.equal(frontendEnv({ APP_ENV: 'development', NEXT_PUBLIC_API_URL: 'http://localhost:9000' }).apiUrl, 'http://localhost:9000');
  assert.throws(() => frontendEnv({ APP_ENV: 'staging', NODE_ENV: 'development', NEXT_PUBLIC_API_URL: 'https://api.example.com' }), /NODE_ENV/);
  assert.throws(() => frontendEnv({ APP_ENV: 'production', NODE_ENV: 'production', NEXT_PUBLIC_API_URL: 'http://api.example.com' }), /HTTPS/);
});

test('customer requires its native Store API publishable key', () => {
  const env = { APP_ENV: 'development', NEXT_PUBLIC_API_URL: 'http://localhost:9000' };
  assert.throws(() => frontendEnv(env, true), /NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY/);
  assert.doesNotThrow(() => frontendEnv({ ...env, NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY: 'pk_test_fixture' }, true));
});
