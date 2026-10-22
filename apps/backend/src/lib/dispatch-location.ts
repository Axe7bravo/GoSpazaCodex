import Redis from "ioredis";
import { z } from "@medusajs/framework/zod";
import { MedusaError } from "@medusajs/framework/utils";
import { dispatchConflict, dispatchLocationInput } from "../modules/marketplace/dispatch-policy";
import type { DispatchPolicy } from "../modules/marketplace/dispatch-policy";

export const dispatchSample = dispatchLocationInput.extend({ received_at: z.number().finite() });
export type DispatchSample = z.infer<typeof dispatchSample>;
export interface DispatchLocations {
  begin(profile: string, generation: string): Promise<void>;
  put(profile: string, input: z.infer<typeof dispatchLocationInput>, now: Date): Promise<void>;
  get(profile: string): Promise<DispatchSample | null>;
  sequence?(profile: string, generation: string): Promise<number | null>;
}
const unavailable = () => new MedusaError(MedusaError.Types.UNEXPECTED_STATE, "Driver location is temporarily unavailable.", "DISPATCH_LOCATION_UNAVAILABLE");
// Persistent generation/sequence fence contains no coordinates. The separate sample
// expires. Redis restart requires explicit ONLINE to establish a fresh fence;
// replaying an old sample after loss cannot repopulate it.
export class RedisDispatchLocations implements DispatchLocations {
  constructor(private readonly policy: DispatchPolicy) {}
  private key(profile: string) { return "gospaza:dispatch:{" + profile + "}"; }
  private async use<T>(work: (redis: Redis) => Promise<T>): Promise<T> {
    if (!process.env.REDIS_URL) throw unavailable();
    const redis = new Redis(process.env.REDIS_URL, { lazyConnect: true, connectTimeout: 2000, commandTimeout: 2000,
      maxRetriesPerRequest: 0, retryStrategy: () => null, enableOfflineQueue: false });
    redis.on("error", () => {});
    try { await redis.connect(); return await work(redis); }
    finally { redis.disconnect(); }
  }
  async begin(profile: string, generation: string) {
    try {
      await this.use(r => r.eval("redis.call('HSET', KEYS[1], 'generation', ARGV[1], 'sequence', 0); redis.call('DEL', KEYS[2]); return 1",
        2, this.key(profile) + ":fence", this.key(profile) + ":sample", generation));
    } catch { throw unavailable(); }
  }
  async put(profile: string, input: z.infer<typeof dispatchLocationInput>, now: Date) {
    let result: unknown;
    try {
      result = await this.use(r => r.eval(`
        if redis.call('HGET', KEYS[1], 'generation') ~= ARGV[1] then return 0 end
        if tonumber(redis.call('HGET', KEYS[1], 'sequence') or '-1') >= tonumber(ARGV[2]) then return 0 end
        local n = redis.call('INCR', KEYS[3]); if n == 1 then redis.call('EXPIRE', KEYS[3], 60) end
        if n > 60 then return -1 end
        redis.call('HSET', KEYS[1], 'sequence', ARGV[2])
        redis.call('SET', KEYS[2], ARGV[3], 'PX', ARGV[4]); return 1
      `, 3, this.key(profile) + ":fence", this.key(profile) + ":sample", this.key(profile) + ":rate",
      input.generation, input.sequence, JSON.stringify({ ...input, received_at: now.getTime() }), this.policy.freshnessMs));
    } catch { throw unavailable(); }
    if (Number(result) !== 1) return dispatchConflict("DISPATCH_LOCATION_STALE");
  }
  async get(profile: string) {
    try {
      const raw = await this.use(r => r.get(this.key(profile) + ":sample"));
      if (!raw) return null;
      const sample = dispatchSample.safeParse(JSON.parse(raw));
      return sample.success ? sample.data : null;
    } catch { return null; } // Absence is never permission; PostgreSQL commitment remains occupied.
  }
  async sequence(profile: string, generation: string) {
    try {
      const fence = await this.use(r => r.hgetall(this.key(profile) + ":fence"));
      const sequence = Number(fence.sequence);
      return fence.generation === generation && Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : null;
    } catch { return null; }
  }
}
