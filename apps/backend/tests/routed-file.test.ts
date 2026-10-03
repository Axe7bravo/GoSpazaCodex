import RoutedFileProvider from "../src/modules/routed-file/service";
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import assert from "node:assert/strict";
import { test } from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { StorageRouter, classifyKey, PUBLIC_PREFIX } from "../src/modules/routed-file/storage";
import { privateFileConfig } from "../src/lib/private-file-config";

test("public/private storage, legacy private keys, retrieval and deletion are isolated", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gospaza-files-"));
  const privateDir = path.join(directory, "private");
  const publicDir = path.join(directory, "public");
  const router = new StorageRouter({ private: { kind: "local", directory: privateDir }, public: { kind: "local", directory: publicDir, publicUrl: "https://media.example.test" } });
  try {
    await fs.mkdir(privateDir);
    await fs.writeFile(path.join(privateDir, "private-legacy.jpg"), "legacy");
    assert.equal((await router.read("private-legacy.jpg")).toString(), "legacy");
    assert.equal(classifyKey("merchant-applications/legacy.jpg"), "private");
    const secret = await router.upload(Buffer.from("private bytes"), "image/jpeg", "private", ".jpg");
    const image = await router.upload(Buffer.from("public bytes"), "image/jpeg", "public", ".jpg");
    assert.equal(secret.url, "");
    assert.ok(secret.key.startsWith("merchant-applications/gospaza-private-v1/"));
    assert.ok(image.key.startsWith(PUBLIC_PREFIX));
    assert.equal(image.url, "https://media.example.test/" + image.key);
    assert.equal(await router.downloadUrl(image.key), image.url);
    await assert.rejects(router.downloadUrl(secret.key), /authenticated streaming/);
    await assert.rejects(router.downloadUrl("private-legacy.jpg"), /authenticated streaming/);
    assert.equal((await router.read(secret.key)).toString(), "private bytes");
    assert.equal((await router.read(image.key)).toString(), "public bytes");
    await assert.rejects(fs.readFile(path.join(publicDir, secret.key)));
    await router.remove(image.key);
    await router.remove(image.key); // Idempotent deletion.
    await assert.rejects(router.read(image.key));
    assert.equal((await router.read(secret.key)).toString(), "private bytes");
    await router.remove(secret.key);
    await router.remove("private-legacy.jpg");
    await assert.rejects(router.read(secret.key));
    await assert.rejects(router.read("private-legacy.jpg"));
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("unknown keys default private and malformed references cannot escape storage", () => {
  assert.equal(classifyKey("unknown.jpg"), "private");
  for (const key of ["../escape", ".. /escape", "CON", "nul.jpg", "gospaza-public-v1/../secret", "/secret", "a%2fb", "C:secret", "a\\b", "a//b"]) assert.throws(() => classifyKey(key));
  assert.throws(() => privateFileConfig({ APP_ENV: "production" }));
});

test("documented provider contract defaults private and never publishes legacy keys", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gospaza-provider-"));
  const provider = new RoutedFileProvider({}, {
    private: { kind: "local", directory: path.join(directory, "private") },
    public: { kind: "local", directory: path.join(directory, "public"), publicUrl: "https://media.example.test" },
  });
  try {
    const privateFile = await provider.upload({ filename: "../../document.pdf", mimeType: "application/pdf", content: Buffer.from("%PDF private").toString("base64") });
    assert.equal(privateFile.url, "");
    assert.equal(classifyKey(privateFile.key), "private");
    assert.equal((await provider.getAsBuffer({ fileKey: privateFile.key, access: "public" })).toString(), "%PDF private");
    const chunks: Buffer[] = [];
    for await (const chunk of await provider.getDownloadStream({ fileKey: privateFile.key })) chunks.push(Buffer.from(chunk));
    assert.equal(Buffer.concat(chunks).toString(), "%PDF private");
    await assert.rejects(provider.upload({ filename: "doc.pdf", mimeType: "application/pdf", content: "JVBERg==", access: "public" }));
    await provider.delete({ fileKey: privateFile.key, access: "public" });
    await assert.rejects(provider.getAsBuffer({ fileKey: privateFile.key }));
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("S3 uses distinct buckets and derives reads/deletes from keys, not caller flags", async (context) => {
  const commands: { kind: string; bucket?: string; key?: string; acl?: string }[] = [];
  let failUpload = false;
  const send = (async (command: unknown) => {
    if (command instanceof PutObjectCommand) {
      commands.push({ kind: "put", bucket: command.input.Bucket, key: command.input.Key, acl: command.input.ACL });
      if (failUpload) throw new Error("Synthetic interrupted upload");
      return {};
    }
    if (command instanceof GetObjectCommand) {
      commands.push({ kind: "get", bucket: command.input.Bucket, key: command.input.Key });
      return { Body: { transformToByteArray: async () => Buffer.from("stored bytes") } };
    }
    if (command instanceof DeleteObjectCommand) {
      commands.push({ kind: "delete", bucket: command.input.Bucket, key: command.input.Key });
      return {};
    }
    throw new Error("Unexpected S3 command");
  }) as unknown as S3Client["send"];
  context.mock.method(S3Client.prototype, "send", send);
  const shared = { kind: "s3" as const, endpoint: "https://storage.example.test", region: "test", accessKeyId: "synthetic", secretAccessKey: "synthetic" };
  const router = new StorageRouter({
    private: { ...shared, bucket: "private-documents" },
    public: { ...shared, bucket: "public-catalogue", publicUrl: "https://media.example.test" },
  });
  const secret = await router.upload(Buffer.from("secret"), "image/png", "private", ".png");
  const publicImage = await router.upload(Buffer.from("public"), "image/png", "public", ".png");
  assert.equal(secret.url, "");
  assert.deepEqual(commands.slice(0, 2).map((c) => [c.bucket, c.acl]), [["private-documents", "private"], ["public-catalogue", undefined]]);
  for (const key of ["merchant-applications/legacy.png", "unclassified.png", secret.key, publicImage.key]) {
    await router.read(key);
    await router.remove(key);
    assert.equal(commands.at(-1)?.bucket, key === publicImage.key ? "public-catalogue" : "private-documents");
  }
  failUpload = true;
  await assert.rejects(router.upload(Buffer.from("failed"), "image/png", "public", ".png"), /interrupted/);
  assert.equal(commands.at(-1)?.kind, "delete");
  assert.equal(commands.at(-1)?.key, commands.at(-2)?.key);
  assert.equal(commands.at(-1)?.bucket, "public-catalogue");
});

test("production requires separate private and public storage configuration", () => {
  const env = {
    APP_ENV: "production", APPLICATION_FILES_PROVIDER: "s3", CATALOGUE_FILES_PROVIDER: "s3",
    APPLICATION_FILES_S3_ENDPOINT: "https://storage.example.test", APPLICATION_FILES_S3_BUCKET: "private",
    APPLICATION_FILES_S3_REGION: "region", APPLICATION_FILES_S3_ACCESS_KEY_ID: "private-test", APPLICATION_FILES_S3_SECRET_ACCESS_KEY: "private-test",
    CATALOGUE_FILES_S3_ENDPOINT: "https://storage.example.test", CATALOGUE_FILES_S3_BUCKET: "public",
    CATALOGUE_FILES_S3_REGION: "region", CATALOGUE_FILES_S3_ACCESS_KEY_ID: "public-test", CATALOGUE_FILES_S3_SECRET_ACCESS_KEY: "public-test",
    CATALOGUE_FILES_PUBLIC_URL: "https://media.example.test",
  };
  const config = privateFileConfig(env);
  assert.equal(config.options.providers.length, 1);
  assert.equal(config.options.providers[0]!.options.private.publicUrl, undefined);
  assert.throws(() => privateFileConfig({ ...env, CATALOGUE_FILES_S3_BUCKET: "private" }), /distinct/);
  assert.throws(() => privateFileConfig({ ...env, CATALOGUE_FILES_PUBLIC_URL: "http://media.example.test" }), /HTTPS/);
  assert.throws(() => privateFileConfig({ ...env, CATALOGUE_FILES_PROVIDER: "local" }), /requires S3/);
});

test("R2 omits unsupported ACLs and separates private presigning from public custom-domain URLs", async (context) => {
  const uploads: PutObjectCommand["input"][] = [];
  context.mock.method(S3Client.prototype, "send", (async (command: unknown) => {
    assert.ok(command instanceof PutObjectCommand);
    uploads.push(command.input);
    return {};
  }) as unknown as S3Client["send"]);
  for (const endpoint of ["https://fixture.r2.cloudflarestorage.com", "https://fixture.eu.r2.cloudflarestorage.com"]) {
    const connection = { kind: "s3" as const, endpoint, region: "auto", accessKeyId: "synthetic", secretAccessKey: "synthetic" };
    const router = new StorageRouter({
      private: { ...connection, bucket: "private-documents" },
      public: { ...connection, bucket: "public-catalogue", publicUrl: "https://media.example.test" },
    });
    const secret = await router.upload(Buffer.from("secret"), "image/png", "private", ".png");
    const image = await router.upload(Buffer.from("public"), "image/png", "public", ".png");
    assert.equal(secret.url, "");
    assert.equal(image.url, "https://media.example.test/" + image.key);
    assert.equal(await router.downloadUrl(image.key), image.url);
    assert.equal(uploads.at(-2)?.Bucket, "private-documents");
    assert.equal(uploads.at(-1)?.Bucket, "public-catalogue");
    for (const upload of uploads.slice(-2)) assert.equal("ACL" in upload, false);
    assert.equal(uploads.at(-2)?.CacheControl, "private, no-store");
    const signed = new URL(await router.downloadUrl("merchant-applications/legacy.png"));
    assert.equal(signed.origin, endpoint);
    assert.equal(signed.pathname, "/private-documents/merchant-applications/legacy.png");
    assert.equal(signed.searchParams.get("X-Amz-Expires"), "60");
    assert.ok(signed.searchParams.has("X-Amz-Signature"));
  }
});
