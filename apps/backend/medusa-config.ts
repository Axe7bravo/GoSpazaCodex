import { defineConfig, loadEnv } from "@medusajs/framework/utils";
import { AUTH_METHODS } from "./src/lib/auth-config";
import { privateFileConfig } from "./src/lib/private-file-config";
import { backendEnv } from "@gospaza/config/env";

loadEnv(process.env.NODE_ENV || "development", process.cwd());
const env = backendEnv(process.env);

module.exports = defineConfig({
  admin: { disable: env.disableMedusaAdmin },
  projectConfig: {
    workerMode: env.workerMode,
    databaseUrl: env.databaseUrl,
    redisUrl: env.redisUrl,
    cookieOptions: { httpOnly: true, sameSite: "lax", secure: ["staging", "production"].includes(env.appEnv) },
    http: {
      authMethodsPerActor: AUTH_METHODS,
      storeCors: env.storeCors,
      adminCors: env.adminCors,
      authCors: env.authCors,
      jwtSecret: env.jwtSecret,
      cookieSecret: env.cookieSecret,
    },
  },
  modules: [
    { resolve: "./src/modules/marketplace" },
    privateFileConfig(process.env),
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
