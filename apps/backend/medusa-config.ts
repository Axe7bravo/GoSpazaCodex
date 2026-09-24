import { defineConfig, loadEnv } from "@medusajs/framework/utils";
import { backendEnv } from "@gospaza/config/env";

loadEnv(process.env.NODE_ENV || "development", process.cwd());
const env = backendEnv(process.env);

module.exports = defineConfig({
  admin: { disable: env.disableMedusaAdmin },
  projectConfig: {
    workerMode: env.workerMode,
    databaseUrl: env.databaseUrl,
    redisUrl: env.redisUrl,
    http: {
      storeCors: env.storeCors,
      adminCors: env.adminCors,
      authCors: env.authCors,
      jwtSecret: env.jwtSecret,
      cookieSecret: env.cookieSecret,
    },
  },
  modules: [
    { resolve: "@medusajs/medusa/event-bus-redis", options: { redisUrl: env.redisUrl } },
    { resolve: "@medusajs/medusa/workflow-engine-redis", options: { redis: { redisUrl: env.redisUrl } } },
    {
      resolve: "@medusajs/medusa/locking",
      options: {
        providers: [{
          resolve: "@medusajs/medusa/locking-redis",
          id: "locking-redis",
          is_default: true,
          options: { redisUrl: env.redisUrl },
        }],
      },
    },
  ],
});
