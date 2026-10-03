import path from "node:path";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { Readable } from "node:stream";
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export type StorageOptions = { kind: "local"; directory: string; publicUrl?: string } | {
  kind: "s3"; endpoint: string; bucket: string; region: string;
  accessKeyId: string; secretAccessKey: string; publicUrl?: string;
};
export interface RoutedFileOptions { private: StorageOptions; public: StorageOptions }
export const PUBLIC_PREFIX = "gospaza-public-v1/";
// Preserve the M2 S3 prefix so existing prefix-scoped policies need no change.
const PRIVATE_PREFIX = "merchant-applications/gospaza-private-v1/";
export function classifyKey(key: string): "public" | "private" {
  if (!key || key.includes("\\") || key.includes("%") || key.startsWith("/") || key.split("/").some((part) => !part || part.endsWith(".") || part.endsWith(" ") || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part)) || Array.from(key).some((character) => character.charCodeAt(0) < 32 || character === ":")) {
    throw new Error("Invalid storage reference.");
  }
  return key.startsWith(PUBLIC_PREFIX) ? "public" : "private";
}
export class StorageRouter {
  private clients: Partial<Record<"private" | "public", S3Client>> = {};
  constructor(private options: RoutedFileOptions) {}
  private client(access: "private" | "public", options: Extract<StorageOptions, { kind: "s3" }>) {
    return this.clients[access] ??= new S3Client({ endpoint: options.endpoint, region: options.region, forcePathStyle: true,
      credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey } });
  }
  private location(key: string) {
    const access = classifyKey(key);
    const options = this.options[access];
    return { access, options };
  }
  private filePath(directory: string, key: string) {
    const base = path.resolve(directory);
    const target = path.resolve(base, key);
    if (!target.startsWith(base + path.sep)) throw new Error("Invalid storage reference.");
    return target;
  }
  private publicUrl(key: string) {
    if (classifyKey(key) !== "public") throw new Error("Private files have no public URL.");
    const base = this.options.public.publicUrl;
    if (!base) throw new Error("Public file URL is not configured.");
    return base.replace(/\/$/, "") + "/" + key.split("/").map(encodeURIComponent).join("/");
  }
  async upload(bytes: Buffer, mimeType: string, access: "private" | "public", extension: string) {
    const options = this.options[access];
    const key = (access === "public" ? PUBLIC_PREFIX : PRIVATE_PREFIX) + randomUUID() + extension;
    const url = access === "public" ? this.publicUrl(key) : "";
    if (options.kind === "local") {
      const target = this.filePath(options.directory, key);
      await fs.mkdir(path.dirname(target), { recursive: true });
      try { await fs.writeFile(target, bytes, { flag: "wx" }); }
      catch (error) {
        try { await fs.rm(target, { force: true }); }
        catch (cleanup) { throw new AggregateError([error, cleanup], "Upload and cleanup failed."); }
        throw error;
      }
    } else {
      // R2 has bucket-level public access controls, not S3 object ACLs.
      const isR2 = new URL(options.endpoint).hostname.endsWith(".r2.cloudflarestorage.com");
      try { await this.client(access, options).send(new PutObjectCommand({ Bucket: options.bucket, Key: key, Body: bytes,
        ContentType: mimeType, CacheControl: access === "private" ? "private, no-store" : "public, max-age=31536000, immutable",
        ...(access === "private" && !isR2 ? { ACL: "private" as const } : {}),
      })); } catch (error) {
        try { await this.remove(key); }
        catch (cleanup) { throw new AggregateError([error, cleanup], "Upload and cleanup failed."); }
        throw error;
      }
    }
    // Application routes stream private bytes after authorization; never advertise a static URL.
    return { key, url };
  }
  async read(key: string): Promise<Buffer> {
    const { access, options } = this.location(key);
    if (options.kind === "local") return fs.readFile(this.filePath(options.directory, key));
    const response = await this.client(access, options).send(new GetObjectCommand({ Bucket: options.bucket, Key: key }));
    if (!response.Body) throw new Error("Stored file body is missing.");
    return Buffer.from(await response.Body.transformToByteArray());
  }
  async stream(key: string) { return Readable.from(await this.read(key)); }
  async remove(key: string) {
    const { access, options } = this.location(key);
    if (options.kind === "local") await fs.rm(this.filePath(options.directory, key), { force: true });
    else await this.client(access, options).send(new DeleteObjectCommand({ Bucket: options.bucket, Key: key }));
  }
  async downloadUrl(key: string) {
    const { access, options } = this.location(key);
    if (access === "public") return this.publicUrl(key);
    if (options.kind === "local") throw new Error("Private local files require authenticated streaming.");
    return getSignedUrl(this.client(access, options), new GetObjectCommand({ Bucket: options.bucket, Key: key }), { expiresIn: 60 });
  }
}
