export function frontendEnv(env: NodeJS.ProcessEnv, customer?: boolean): { appEnv: string; apiUrl: string };
export function backendEnv(env: NodeJS.ProcessEnv): {
  workerMode: "shared" | "server" | "worker"; disableMedusaAdmin: boolean;
  appEnv: string; databaseUrl: string; redisUrl: string; backendUrl: string;
  jwtSecret: string; cookieSecret: string; storeCors: string; adminCors: string; authCors: string;
};
