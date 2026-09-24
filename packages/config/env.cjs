const environments = ['development', 'test', 'staging', 'production'];

function required(env, key) {
  const value = env[key]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}

function url(env, key, protocols) {
  const value = required(env, key);
  try {
    const parsed = new URL(value);
    if (!protocols.includes(parsed.protocol) || !parsed.hostname) throw new Error();
    if (['http:', 'https:'].includes(parsed.protocol) &&
        (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/')) {
      throw new Error();
    }
  } catch {
    throw new Error(`Invalid environment variable: ${key}`);
  }
  return value;
}

function appEnvironment(env) {
  const value = required(env, 'APP_ENV');
  if (!environments.includes(value)) throw new Error('Invalid environment variable: APP_ENV');
  if (['staging', 'production'].includes(value) && env.NODE_ENV !== 'production') {
    throw new Error('Staging and production require NODE_ENV=production');
  }
  if (value === 'test' && env.NODE_ENV !== 'test') throw new Error('APP_ENV=test requires NODE_ENV=test');
  return value;
}

function frontendEnv(env, customer = false) {
  const appEnv = appEnvironment(env);
  const apiUrl = url(env, 'NEXT_PUBLIC_API_URL', ['http:', 'https:']);
  if (['staging', 'production'].includes(appEnv) && !apiUrl.startsWith('https:')) {
    throw new Error('NEXT_PUBLIC_API_URL must use HTTPS outside local environments');
  }
  if (customer) required(env, "NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY");
  return { appEnv, apiUrl };
}

function backendEnv(env) {
  const appEnv = appEnvironment(env);
  const workerMode = env.MEDUSA_WORKER_MODE ?? 'shared';
  if (!['shared', 'server', 'worker'].includes(workerMode)) {
    throw new Error('Invalid MEDUSA_WORKER_MODE: expected shared, server, or worker');
  }
  const disableAdmin = env.DISABLE_MEDUSA_ADMIN ?? 'false';
  if (!['true', 'false'].includes(disableAdmin)) {
    throw new Error('Invalid DISABLE_MEDUSA_ADMIN: expected true or false');
  }
  const disableMedusaAdmin = disableAdmin === 'true';
  const databaseUrl = url(env, 'DATABASE_URL', ['postgres:', 'postgresql:']);
  const redisUrl = url(env, 'REDIS_URL', ['redis:', 'rediss:']);
  const backendUrl = url(env, 'BACKEND_URL', ['http:', 'https:']);
  const secret = (key) => {
    const value = required(env, key);
    if (value.length < 32 || /change.?me|replace.?me/i.test(value)) {
      throw new Error(`${key} must be a generated secret of at least 32 characters`);
    }
    return value;
  };
  const cors = (key) => {
    const value = required(env, key);
    for (const origin of value.split(',')) {
      const clean = origin.trim();
      url({ origin: clean }, 'origin', ['http:', 'https:']);
      if (new URL(clean).origin !== clean) throw new Error(`${key} must contain exact origins`);
      if (['staging', 'production'].includes(appEnv) && !clean.startsWith('https:')) {
        throw new Error(`${key} must use HTTPS outside local environments`);
      }
    }
    return value.split(',').map((origin) => origin.trim()).join(',');
  };
  if (appEnv === 'test') {
    if (!new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Test database name must end with _test');
    if (new URL(redisUrl).pathname !== '/1') throw new Error('Test Redis must use database /1');
  }
  if (['staging', 'production'].includes(appEnv) && !backendUrl.startsWith('https:')) {
    throw new Error('BACKEND_URL must use HTTPS outside local environments');
  }
  return { appEnv, workerMode, disableMedusaAdmin, databaseUrl, redisUrl, backendUrl, jwtSecret: secret('JWT_SECRET'),
    cookieSecret: secret('COOKIE_SECRET'), storeCors: cors('STORE_CORS'),
    adminCors: cors('ADMIN_CORS'), authCors: cors('AUTH_CORS') };
}

module.exports = { frontendEnv, backendEnv };

