import path from "node:path";
export function privateFileConfig(env: NodeJS.ProcessEnv) {
  const production = ["staging", "production"].includes(env.APP_ENV ?? "");
  const provider = env.APPLICATION_FILES_PROVIDER ?? "local";
  const required = (key: string) => { const value = env[key]?.trim(); if (!value) throw new Error("Missing " + key); return value; };
  if (provider === "local") {
    if (production) throw new Error("Application documents require private S3 storage in staging/production.");
    const directory = path.resolve(env.APPLICATION_FILES_LOCAL_DIR ?? path.join(process.cwd(), "../../.private/merchant-documents"));
    if (directory.split(/[\\/]/).some((part) => ["static", "public", ".next", ".medusa"].includes(part.toLowerCase()))) {
      throw new Error("APPLICATION_FILES_LOCAL_DIR must be outside public/static/build directories.");
    }
    return { resolve: "@medusajs/medusa/file", options: { providers: [{ resolve: "@medusajs/medusa/file-local", id: "local",
      options: { private_upload_dir: directory, backend_url: env.BACKEND_URL + "/static" },
    }] } };
  }
  if (provider !== "s3") throw new Error("APPLICATION_FILES_PROVIDER must be local or s3.");
  const endpoint = required("APPLICATION_FILES_S3_ENDPOINT");
  if (new URL(endpoint).protocol !== "https:") throw new Error("Private S3 endpoint must use HTTPS.");
  return { resolve: "@medusajs/medusa/file", options: { providers: [{ resolve: "@medusajs/medusa/file-s3", id: "s3",
    options: { file_url: endpoint, endpoint, bucket: required("APPLICATION_FILES_S3_BUCKET"), region: required("APPLICATION_FILES_S3_REGION"),
      access_key_id: required("APPLICATION_FILES_S3_ACCESS_KEY_ID"), secret_access_key: required("APPLICATION_FILES_S3_SECRET_ACCESS_KEY"),
      prefix: "merchant-applications/", cache_control: "private, no-store", acl: "private", download_file_duration: 60,
      additional_client_config: { forcePathStyle: true },
    },
  }] } };
}
