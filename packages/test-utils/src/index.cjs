/** Isolated infrastructure configuration for tests; never loads developer .env files. */
function backendTestEnv() {
  return {
    APP_ENV: "test", NODE_ENV: "test",
    DATABASE_URL: "postgres://gospaza:test-only@localhost:5432/gospaza_test",
    REDIS_URL: "redis://localhost:6379/1",
    BACKEND_URL: "http://localhost:9000",
    JWT_SECRET: "test-only-jwt-secret-000000000000000000",
    COOKIE_SECRET: "test-only-cookie-secret-000000000000000",
    STORE_CORS: "http://localhost:3000",
    ADMIN_CORS: "http://localhost:3003",
    AUTH_CORS: "http://localhost:3000,http://localhost:3001,http://localhost:3002,http://localhost:3003",
  };
}

module.exports = { backendTestEnv };

