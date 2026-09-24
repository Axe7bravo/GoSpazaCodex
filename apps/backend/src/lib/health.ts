export type Probe = () => Promise<unknown>;

export async function readiness(postgres: Probe, redis: Probe) {
  const results = await Promise.allSettled([Promise.resolve().then(postgres), Promise.resolve().then(redis)]);
  const dependencies = {
    postgres: results[0].status === "fulfilled" ? "up" : "down",
    redis: results[1].status === "fulfilled" ? "up" : "down",
  };
  const ready = Object.values(dependencies).every((status) => status === "up");
  return { statusCode: ready ? 200 : 503, body: { status: ready ? "ready" : "unavailable", dependencies } };
}

