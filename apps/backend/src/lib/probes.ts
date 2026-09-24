import { Client } from "pg";
import Redis from "ioredis";

export async function postgresProbe() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 2000,
    query_timeout: 2000,
    statement_timeout: 2000,
  });
  client.on("error", () => { /* Readiness returns only sanitized status. */ });
  try {
    await client.connect();
    await client.query("SELECT 1");
  } finally {
    await client.end();
  }
}

export async function redisProbe() {
  const client = new Redis(process.env.REDIS_URL!, {
    lazyConnect: true,
    connectTimeout: 2000,
    commandTimeout: 2000,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
    enableOfflineQueue: false,
  });
  client.on("error", () => { /* Do not emit connection strings. */ });
  try {
    await client.connect();
    if (await client.ping() !== "PONG") throw new Error("Redis probe failed");
  } finally {
    client.disconnect();
  }
}
