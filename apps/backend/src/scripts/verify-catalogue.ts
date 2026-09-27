import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import type { ExecArgs, IAuthModuleService, IUserModuleService, IInventoryService, IProductModuleService, IFileModuleService } from "@medusajs/framework/types";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { deleteProductsWorkflow } from "@medusajs/medusa/core-flows";
import type MarketplaceService from "../modules/marketplace/service";
import type { CatalogueService } from "../lib/catalogue-service";
import { ensureCommerce, commerceContext } from "../lib/commerce";
import { cleanupFixtureCommerce } from "./fixture-commerce-cleanup";
import { PUBLIC_PREFIX } from "../modules/routed-file/storage";

type Product = Awaited<ReturnType<CatalogueService["detail"]>>;
type Session = { identity: string; email: string; cookie: string };
type Invitation = Awaited<ReturnType<MarketplaceService["teamService"]["invite"]>>;

// Real native sessions, HTTP middleware, core workflows and PostgreSQL constraints.
// Deliberate failure constraints affect only this invocation's synthetic merchant/profile.
export default async function verifyCatalogue({ container }: ExecArgs) {
  if (!["development", "test"].includes(process.env.APP_ENV ?? "")) throw new Error("M5 verification is local-only.");
  const base = new URL(process.env.BACKEND_URL!);
  if (!["localhost", "127.0.0.1"].includes(base.hostname)) throw new Error("Loopback backend required.");
  if ((process.env.CATALOGUE_FILES_PROVIDER ?? "local") !== "local") throw new Error("M5 fault/cleanup verification requires local catalogue storage.");
  const db = container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
  const market = container.resolve<MarketplaceService>("marketplace");
  const auth = container.resolve<IAuthModuleService>(Modules.AUTH);
  const users = container.resolve<IUserModuleService>(Modules.USER);
  const inventory = container.resolve<IInventoryService>(Modules.INVENTORY);
  const products = container.resolve<IProductModuleService>(Modules.PRODUCT);
  const files = container.resolve<IFileModuleService>(Modules.FILE);
  const prefix = "m5-" + randomUUID();
  const constraint = "m5_fault_" + randomBytes(8).toString("hex");
  const password = randomBytes(24).toString("hex");
  const identities: string[] = [], userIds: string[] = [], appIds: string[] = [], cookies: string[] = [], reservations: string[] = [], privateKeys: string[] = [];
  const failures: unknown[] = [];
  async function request(url: string, who?: Session, method = "GET", body?: unknown) {
    return fetch(new URL(url, base), {
      method, signal: AbortSignal.timeout(60000),
      headers: { ...(who ? { Cookie: who.cookie } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  async function expectStatus(response: Promise<Response> | Response, status: number) {
    const result = await response;
    assert.equal(result.status, status, "Unexpected HTTP status; response deliberately omitted");
    return result;
  }
  async function session(suffix: string, actor = "merchant"): Promise<Session> {
    const email = prefix + "-" + suffix + "@example.test";
    const registered = await auth.register("emailpass", { body: { email, password } });
    assert.ok(registered.success && registered.authIdentity);
    const identity = registered.authIdentity.id;
    identities.push(identity);
    if (actor === "user") {
      const user = await users.createUsers({ email });
      userIds.push(user.id);
      await auth.updateAuthIdentities({ id: identity, app_metadata: { user_id: user.id } });
    }
    const login = await expectStatus(request("/auth/" + actor + "/emailpass", undefined, "POST", { email, password }), 200);
    const { token } = await login.json() as { token: string };
    const exchanged = await fetch(new URL("/auth/session", base), { method: "POST", headers: { Authorization: "Bearer " + token }, signal: AbortSignal.timeout(60000) });
    assert.equal(exchanged.status, 200);
    const cookie = exchanged.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
    assert.ok(cookie);
    cookies.push(cookie);
    return { identity, email, cookie };
  }
  async function application(owner: Session) {
    const app = await market.createDraft(owner.identity);
    assert.ok(app);
    appIds.push(app.id);
    await market.edit(app.id, owner.identity, {
      legal_name: prefix, trading_name: prefix, contact_name: "Fixture", contact_email: owner.email,
      contact_phone: "0123456789", address_line_1: "1 Fixture Street", address_line_2: "", city: "Fixture city",
      province: "Fixture province", postal_code: "1234", country_code: "ZA", intends_to_sell_alcohol: false, notes: "M5 synthetic",
    });
    await market.submit(app.id, owner.identity);
    await market.review(app.id, userIds[0]!, "start-review");
    return app.id;
  }
  const input = (suffix: string, weights = false) => ({
    title: prefix + "-" + suffix, description: "Synthetic catalogue", status: "draft" as const, requires_age_verification: false,
    variants: (weights ? ["500g", "1kg", "2kg"] : ["Default"]).map((title, index) => ({
      title, sku: prefix + "-" + suffix + "-" + index, price_minor: 1099 + index * 100, stocked_quantity: 12,
    })),
  });
  const payload = (product: Product) => ({
    title: product.title, description: product.description, status: product.status,
    requires_age_verification: product.requires_age_verification,
    variants: product.variants.map((v) => ({ id: v.id, title: v.title, sku: v.sku, price_minor: v.price_minor, stocked_quantity: v.stocked_quantity })),
  });
  const productPath = (id: string) => "/merchant/products/" + id;
  async function read(who: Session, id: string) {
    return (await (await expectStatus(request(productPath(id), who), 200)).json() as { product: Product }).product;
  }
  async function create(who: Session, data: ReturnType<typeof input>) {
    return (await (await expectStatus(request("/merchant/products", who, "POST", data), 201)).json() as { product: Product }).product;
  }
  async function stock(who: Session, id: string, quantity: number) {
    return expectStatus(request("/merchant/inventory/" + id, who, "PATCH", { stocked_quantity: quantity }), 200);
  }
  async function join(owner: Session, who: Session, role: "MANAGER" | "PICKER") {
    const created = await (await expectStatus(request("/merchant/team/invitations", owner, "POST", { email: who.email, role }), 201)).json() as Invitation;
    await expectStatus(request("/merchant/team/invitations/accept", who, "POST", { token: created.token }), 200);
  }
  const png = { mime_type: "image/png", content: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=" };
  const directory = path.resolve("static/catalogue", PUBLIC_PREFIX);
  async function publicFiles() {
    try { return (await readdir(directory)).sort(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }
  try {
    const admin = await session("admin", "user");
    const ownerA = await session("a"), ownerB = await session("b"), manager = await session("manager"), picker = await session("picker"), outsider = await session("outsider");
    // Existing M3 merchant with no infrastructure: GET must not provision anything.
    const appA = await application(ownerA);
    const tenantA = await market.provision(appA, userIds[0]!, "Synthetic existing merchant");
    await expectStatus(request("/merchant/products", ownerA), 409);
    assert.equal((await db("merchant").where({ id: tenantA.merchant.id }).first()).medusa_sales_channel_id, null);
    const topologies = await Promise.all([ensureCommerce(container, tenantA.merchant.id), ensureCommerce(container, tenantA.merchant.id)]);
    assert.equal(topologies[0]!.channelId, topologies[1]!.channelId);
    assert.equal(topologies[0]!.locationId, topologies[1]!.locationId);
    const repeated = await ensureCommerce(container, tenantA.merchant.id);
    assert.equal(repeated.channelId, topologies[0]!.channelId);
    assert.equal(repeated.locationId, topologies[0]!.locationId);
    const query = container.resolve<{ graph(input: { entity: string; fields: string[]; filters: Record<string, unknown> }): Promise<{ data: Record<string, unknown>[] }> }>(ContainerRegistrationKeys.QUERY);
    const locations = await query.graph({ entity: "sales_channel_location", fields: ["stock_location_id"], filters: { sales_channel_id: repeated.channelId } });
    assert.deepEqual(locations.data.map((row) => row.stock_location_id), [repeated.locationId]);
    // Future approval goes through the actual M3 HTTP workflow, then retry it.
    const appB = await application(ownerB);
    const approval = { confirmed: true, reason: "Synthetic future merchant" };
    const approve = () => request("/admin/gospaza/merchant-applications/" + appB + "/approve", admin, "POST", approval);
    await expectStatus(approve(), 200);
    const tenantB = await market.resolveTenant(ownerB.identity);
    const topologyB = await commerceContext(container, tenantB.merchant.id);
    await expectStatus(approve(), 200);
    assert.equal((await commerceContext(container, tenantB.merchant.id)).channelId, topologyB.channelId);
    assert.notEqual(repeated.channelId, topologyB.channelId);
    assert.notEqual(repeated.locationId, topologyB.locationId);
    await assert.rejects(async () => { await db("merchant").where({ id: tenantB.merchant.id }).update({ medusa_sales_channel_id: repeated.channelId }); });
    await assert.rejects(async () => { await db("merchant_store").where({ id: tenantB.store.id }).update({ medusa_stock_location_id: repeated.locationId }); });
    await join(ownerA, manager, "MANAGER");
    await join(ownerA, picker, "PICKER");
    const a = await create(ownerA, input("weights", true));
    const b = await create(ownerB, input("foreign"));
    const managed = await create(manager, input("manager"));
    assert.equal(a.status, "draft");
    assert.deepEqual(a.variants.map((v) => v.title).sort(), ["1kg", "2kg", "500g"]);
    for (const v of a.variants) {
      assert.equal(v.currency_code, "zar");
      assert.equal(v.price_minor, input("weights", true).variants.find((row) => row.title === v.title)!.price_minor);
      const levels = await inventory.listInventoryLevels({ inventory_item_id: v.inventory_item_id });
      assert.equal(levels.length, 1);
      assert.equal(levels[0]!.location_id, repeated.locationId);
      assert.equal(Number(levels[0]!.stocked_quantity), 12);
    }
    const profile = await db("product_marketplace_profile").where({ medusa_product_id: a.id }).first();
    assert.equal(profile.merchant_id, tenantA.merchant.id);
    const ownershipLink = await query.graph({ entity: "product_marketplace_profile", fields: ["merchant_id", "product.id"], filters: { id: profile.id } });
    assert.equal(ownershipLink.data[0]?.merchant_id, tenantA.merchant.id);
    assert.deepEqual(ownershipLink.data[0]?.product, { id: a.id });
    await assert.rejects(async () => { await db("product_marketplace_profile").insert({ id: "pmprof_" + randomUUID(), merchant_id: tenantB.merchant.id, medusa_product_id: a.id }); });
    const linkedProducts = await query.graph({ entity: "product_sales_channel", fields: ["sales_channel_id"], filters: { product_id: a.id } });
    assert.deepEqual(linkedProducts.data.map((row) => row.sales_channel_id), [repeated.channelId]);
    const edited = { ...payload(a), status: "published", requires_age_verification: true,
      variants: payload(a).variants.reverse().map((v, index) => ({ ...v, price_minor: 5000 + index })) };
    await expectStatus(request(productPath(a.id), ownerA, "PATCH", edited), 200);
    const published = await read(ownerA, a.id);
    assert.equal(published.status, "published");
    assert.equal(published.requires_age_verification, true);
    for (const v of published.variants) assert.equal(v.price_minor, edited.variants.find((row) => row.id === v.id)!.price_minor);
    await expectStatus(request(productPath(managed.id), manager, "PATCH", { ...payload(managed), title: prefix + "-manager-edited" }), 200);
    await expectStatus(request("/merchant/products?q=" + prefix + "&status=published&limit=1&offset=0", ownerA), 200);
    for (const who of [undefined, outsider, await session("customer", "customer"), await session("driver", "driver"), admin]) {
      await expectStatus(request("/merchant/products", who), 401);
      await expectStatus(request("/merchant/inventory", who), 401);
      await expectStatus(request("/merchant/products", who, "POST", input("denied")), 401);
    }
    await expectStatus(request("/merchant/products", picker), 200);
    await expectStatus(request("/merchant/inventory", picker), 200);
    await expectStatus(request("/merchant/products", picker, "POST", input("picker")), 403);
    await expectStatus(request(productPath(a.id), picker, "PATCH", payload(a)), 403);
    await expectStatus(request(productPath(a.id) + "/images", picker, "POST", png), 403);
    await expectStatus(request("/merchant/inventory/" + a.variants[0]!.inventory_item_id, picker, "PATCH", { stocked_quantity: 1 }), 403);
    await expectStatus(request(productPath(b.id), ownerA), 404);
    await expectStatus(request(productPath(b.id), ownerA, "PATCH", payload(b)), 404);
    await expectStatus(request(productPath(a.id), ownerA, "PATCH", { ...payload(a), variants: payload(a).variants.map((v, index) => index === 0 ? { ...v, id: b.variants[0]!.id } : v) }), 404);
    await expectStatus(request("/merchant/inventory/" + b.variants[0]!.inventory_item_id, ownerA, "PATCH", { stocked_quantity: 1 }), 404);
    for (const injected of [{ merchant_id: tenantB.merchant.id }, { sales_channel_id: topologyB.channelId }, { stock_location_id: topologyB.locationId }, { images: [{ url: "/private/secret" }] }]) {
      await expectStatus(request("/merchant/products", ownerA, "POST", { ...input("injected"), ...injected }), 400);
    }
    const item = a.variants[0]!.inventory_item_id;
    for (const stocked_quantity of [-1, 1.5, "2"]) await expectStatus(request("/merchant/inventory/" + item, ownerA, "PATCH", { stocked_quantity }), 400);
    await expectStatus(request("/merchant/inventory/" + item, ownerA, "PATCH", { stocked_quantity: 20, reserved_quantity: 0 }), 400);
    const reservation = await inventory.createReservationItems({ inventory_item_id: item, location_id: repeated.locationId, quantity: 2 });
    reservations.push(reservation.id);
    await stock(manager, item, 25);
    let variant = (await read(ownerA, a.id)).variants.find((v) => v.inventory_item_id === item)!;
    assert.equal(variant.stocked_quantity, 25);
    assert.equal(variant.reserved_quantity, 2);
    assert.equal(variant.available_quantity, 23);
    await Promise.all([stock(ownerA, item, 31), stock(manager, item, 47)]);
    variant = (await read(ownerA, a.id)).variants.find((v) => v.inventory_item_id === item)!;
    assert.ok([31, 47].includes(variant.stocked_quantity), "Serialized absolute writes: last completed writer wins.");
    assert.equal(variant.reserved_quantity, 2);
    assert.equal(variant.available_quantity, variant.stocked_quantity - 2);
    await db("merchant_member").where({ auth_identity_id: picker.identity }).update({ status: "INACTIVE" });
    await expectStatus(request("/merchant/products", picker), 401);
    await expectStatus(request("/merchant/inventory", picker), 401);
    // A real ownership-insert failure must compensate native product creation.
    await db.raw("alter table product_marketplace_profile add constraint ?? check (merchant_id <> " + db.raw("?", [tenantA.merchant.id]).toQuery() + ") not valid", [constraint]);
    try {
      const response = await request("/merchant/products", ownerA, "POST", input("rollback"));
      assert.ok(response.status >= 400);
      assert.equal((await products.listProducts({ title: prefix + "-rollback" })).length, 0);
    } finally { await db.raw("alter table product_marketplace_profile drop constraint ??", [constraint]); }
    // Real upload, public URL, cross-tenant image rejection, then object removal.
    const uploaded = (await (await expectStatus(request(productPath(a.id) + "/images", ownerA, "POST", png), 201)).json() as { product: Product }).product;
    assert.equal(uploaded.images.length, 1);
    const image = uploaded.images[0]!;
    assert.equal((await fetch(image.url)).status, 200);
    await expectStatus(request(productPath(a.id) + "/images/" + image.id, ownerB, "DELETE", {}), 404);
    await expectStatus(request(productPath(b.id) + "/images", ownerA, "POST", png), 404);
    await expectStatus(request(productPath(a.id) + "/images", ownerA, "POST", { ...png, access: "private" }), 400);
    await expectStatus(request(productPath(a.id) + "/images", ownerA, "POST", { mime_type: "image/png", content: Buffer.from("invalid").toString("base64") }), 400);
    // Private IDs cannot be supplied as public media, and catalogue cleanup cannot reach them.
    const secret = await files.createFiles({ filename: "fixture.pdf", mimeType: "application/pdf", content: Buffer.from("%PDF private fixture").toString("base64"), access: "private" });
    privateKeys.push(secret.id);
    assert.equal(secret.url, "");
    await expectStatus(request(productPath(a.id) + "/images", ownerA, "POST", { ...png, storage_key: secret.id }), 400);
    await expectStatus(request(productPath(a.id) + "/images/" + encodeURIComponent(secret.id), ownerA, "DELETE", {}), 400);
    assert.equal((await files.getAsBuffer(secret.id)).toString(), "%PDF private fixture");
    await expectStatus(request(productPath(a.id) + "/images/" + image.id, ownerA, "DELETE", {}), 200);
    assert.equal((await fetch(image.url)).status, 404);
    // Storage succeeds but tracking fails: generated file must be removed.
    const before = await publicFiles();
    await db.raw("alter table catalogue_media add constraint ?? check (profile_id <> " + db.raw("?", [profile.id]).toQuery() + ") not valid", [constraint]);
    try {
      const response = await request(productPath(a.id) + "/images", ownerA, "POST", png);
      assert.ok(response.status >= 400);
      assert.deepEqual(await publicFiles(), before);
      assert.equal((await read(ownerA, a.id)).images.length, 0);
    } finally { await db.raw("alter table catalogue_media drop constraint ??", [constraint]); }
  } catch (error) { failures.push(error); }
  finally {
    for (const cookie of cookies) {
      try { await expectStatus(request("/auth/session", { identity: "", email: "", cookie }, "DELETE"), 200); }
      catch (error) { failures.push(error); }
    }
    let removed = false;
    try {
      if (reservations.length) await inventory.deleteReservationItems(reservations);
      for (const key of privateKeys) await files.deleteFiles(key);
      const apps = await db<{ id: string }>("merchant_application").whereIn("id", appIds).whereIn("applicant_identity_id", identities).select("id");
      const merchants = await db<{ id: string }>("merchant").whereIn("source_application_id", apps.map((row) => row.id)).select("id");
      const mids = merchants.map((row) => row.id);
      const profiles = await db<{ id: string; medusa_product_id: string }>("product_marketplace_profile").whereIn("merchant_id", mids);
      const media = await db<{ file_key: string }>("catalogue_media").whereIn("profile_id", profiles.map((row) => row.id));
      if (profiles.length) await deleteProductsWorkflow(container).run({ input: { ids: profiles.map((row) => row.medusa_product_id) } });
      for (const row of media) { assert.ok(row.file_key.startsWith(PUBLIC_PREFIX)); await files.deleteFiles(row.file_key); }
      await db("catalogue_media").whereIn("profile_id", profiles.map((row) => row.id)).delete();
      await db("product_marketplace_profile").whereIn("merchant_id", mids).delete();
      await cleanupFixtureCommerce(container, mids);
      await db.transaction(async (trx) => {
        await trx("merchant_invitation").whereIn("merchant_id", mids).delete();
        await trx("merchant_member").whereIn("merchant_id", mids).delete();
        await trx("merchant_store").whereIn("merchant_id", mids).delete();
        await trx("merchant").whereIn("id", mids).delete();
        await trx("merchant_application").whereIn("id", apps.map((row) => row.id)).delete();
      });
      removed = true;
    } catch (error) { failures.push(new Error("M5 fixture cleanup failed; prefix " + prefix, { cause: error })); }
    if (removed) {
      for (const cleanup of [() => users.deleteUsers(userIds), () => auth.deleteAuthIdentities(identities)]) {
        try { await cleanup(); } catch (error) { failures.push(error); }
      }
    }
  }
  if (failures.length) throw new AggregateError(failures, "M5 verification or cleanup failed; prefix " + prefix);
  console.log("M5 integration passed: topology, RBAC, tenant isolation, native prices/inventory/reservations, rollback and media.");
}
