import path from "node:path";
import type { RoutedFileOptions, StorageOptions } from "../modules/routed-file/storage";

// s3 and _S3_ identify the wire protocol. Production hosting is Cloudflare R2.
export function privateFileConfig(env: NodeJS.ProcessEnv) {
  const production = ["staging", "production"].includes(env.APP_ENV ?? "");
  const required = (key: string) => {
    const value = env[key]?.trim();
    if (!value) throw new Error("Missing " + key);
    return value;
  };
  const httpsUrl = (key: string) => {
    const value = required(key);
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error(key + " must be an HTTPS URL without credentials/query/fragment.");
    return value.replace(/\/$/, "");
  };
  function storage(prefix: "APPLICATION_FILES" | "CATALOGUE_FILES"): StorageOptions {
    const provider = env[prefix + "_PROVIDER"] ?? "local";
    if (provider === "local") {
      if (production) throw new Error(prefix + " requires S3 storage in staging/production.");
      if (prefix === "APPLICATION_FILES") {
        const directory = path.resolve(env.APPLICATION_FILES_LOCAL_DIR ?? path.join(process.cwd(), "../../.private/merchant-documents"));
        if (directory.split(/[\\/]/).some((part) => ["static", "public", ".next", ".medusa"].includes(part.toLowerCase()))) {
          throw new Error("APPLICATION_FILES_LOCAL_DIR must be outside public/static/build directories.");
        }
        return { kind: "local", directory };
      }
      return { kind: "local", directory: path.resolve(process.cwd(), "static/catalogue"), publicUrl: new URL("/static/catalogue", env.BACKEND_URL ?? "http://localhost:9000").toString() };
    }
    if (provider !== "s3") throw new Error(prefix + "_PROVIDER must be local or s3.");
    return { kind: "s3", endpoint: httpsUrl(prefix + "_S3_ENDPOINT"), bucket: required(prefix + "_S3_BUCKET"),
      region: required(prefix + "_S3_REGION"), accessKeyId: required(prefix + "_S3_ACCESS_KEY_ID"), secretAccessKey: required(prefix + "_S3_SECRET_ACCESS_KEY"),
      ...(prefix === "CATALOGUE_FILES" ? { publicUrl: httpsUrl("CATALOGUE_FILES_PUBLIC_URL") } : {}),
    };
  }
  const options: RoutedFileOptions = { private: storage("APPLICATION_FILES"), public: storage("CATALOGUE_FILES") };
  if (options.private.kind === "s3" && options.public.kind === "s3" && options.private.bucket === options.public.bucket) {
    throw new Error("Catalogue and application files require distinct S3 buckets.");
  }
  return { resolve: "@medusajs/medusa/file", options: { providers: [{ resolve: "./src/modules/routed-file", id: "gospaza", options }] } };
}
