import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";

function endpoint(value:string|undefined, protocols:string[], label:string) {
  let url:URL;
  try { url=new URL(value ?? ""); } catch { throw new Error("Invalid "+label+" URL."); }
  if(!protocols.includes(url.protocol) || !url.hostname || url.hash)
    throw new Error("Invalid "+label+" URL.");
  return url;
}

export function isolatedEnvironment(file:NodeJS.ProcessEnv, inherited:NodeJS.ProcessEnv) {
  // Windows environment names are case-insensitive. Pass the child exactly one
  // spelling of each variable so a differently cased key cannot bypass a guard.
  const normalize=(source:NodeJS.ProcessEnv)=>Object.fromEntries(Object.entries(source)
    .filter(([,value])=>value!==undefined).map(([key,value])=>[process.platform==="win32"?key.toUpperCase():key,value]));
  const overrides=normalize(inherited);
  const env:NodeJS.ProcessEnv={...normalize(file),...overrides};
  const pg=endpoint(env.DATABASE_URL,["postgres:","postgresql:"],"PostgreSQL");
  const base=pg.pathname.slice(1);
  if(!/^[A-Za-z0-9_-]+$/.test(base) || [...pg.searchParams.keys()].some(k=>k!=="sslmode"))
    throw new Error("Expected a plain PostgreSQL database name and no connection overrides.");
  // Only derive a sibling from the .env default. An explicit shell target must
  // already be an isolated database; never silently reinterpret operator intent.
  const database=overrides.DATABASE_URL===undefined && !base.endsWith("_test") ? base+"_test":base;
  if(!database.endsWith("_test") || Buffer.byteLength(database)>63)
    throw new Error("The resolved PostgreSQL database must end in _test and fit a PostgreSQL identifier.");
  pg.pathname="/"+database;
  const redis=endpoint(env.REDIS_URL,["redis:","rediss:"],"Redis");
  if(!/^(?:\/\d*)?$/.test(redis.pathname) || redis.search)
    throw new Error("Expected a Redis endpoint without database query overrides.");
  redis.pathname="/1";
  const backend=endpoint(env.BACKEND_URL,["http:","https:"],"backend");
  if(!["localhost","127.0.0.1","[::1]"].includes(backend.hostname))
    throw new Error("Isolated HTTP verifiers require a loopback backend.");
  Object.assign(env,{NODE_ENV:"test",APP_ENV:"test",DATABASE_URL:pg.href,REDIS_URL:redis.href,
    REFUND_RECOVERY_WORKER_ENABLED:"false",PAYMENT_RECONCILIATION_WORKER_ENABLED:"false"});
  const secrets=Object.fromEntries(["JWT_SECRET","COOKIE_SECRET","HANDOFF_OTP_SECRET","YOCO_SECRET_KEY","YOCO_WEBHOOK_SECRET"]
    .map(key=>[key,env[key]?.trim()?"present":"missing"]));
  const summary={database,redis_database:1,NODE_ENV:env.NODE_ENV,APP_ENV:env.APP_ENV,
    REFUND_RECOVERY_WORKER_ENABLED:env.REFUND_RECOVERY_WORKER_ENABLED,
    PAYMENT_RECONCILIATION_WORKER_ENABLED:env.PAYMENT_RECONCILIATION_WORKER_ENABLED,secrets};
  return {env,summary};
}

export function verifierPath(args:string[],scripts:Record<string,string>) {
  const names=args[0]==="--"?args.slice(1):args;
  const name=names[0] ?? "";
  const match=names.length===1 && /^test:[a-z0-9-]+$/.test(name)
    && /^medusa exec (\.\/src\/scripts\/verify-[a-z0-9-]+\.ts)$/.exec(scripts[name] ?? "");
  if(!match || !match[1]) throw new Error("Specify one existing backend test:<name> Medusa verifier.");
  return match[1];
}

if(require.main===module) {
  try {
    const backend=resolve(__dirname,"..");
    const scripts=JSON.parse(readFileSync(resolve(backend,"package.json"),"utf8")).scripts;
    const script=verifierPath(process.argv.slice(2),scripts);
    const {env,summary}=isolatedEnvironment(parseEnv(readFileSync(resolve(backend,".env"),"utf8")),process.env);
    console.log("Isolated verifier:",JSON.stringify(summary));
    if(summary.secrets.JWT_SECRET==="missing" || summary.secrets.COOKIE_SECRET==="missing")
      throw new Error("Required backend session secrets are missing.");
    // Invoke the same pinned CLI as the package script, with no shell or command interpolation.
    const child=spawnSync(process.execPath,[require.resolve("@medusajs/cli/cli.js"),"exec",script],
      {cwd:backend,env,stdio:"inherit"});
    if(child.error) throw new Error("Could not start the Medusa verifier.");
    process.exitCode=child.status ?? 1;
  } catch(error) {
    console.error(error instanceof Error ? error.message:"Isolated verifier failed.");
    process.exitCode=1;
  }
}
