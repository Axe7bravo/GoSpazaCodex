import { dirname, join } from "node:path";
import NativeModule from "@medusajs/loyalty-plugin/.medusa/server/src/modules/store-credit";
import { DmlEntity, MedusaServiceModelObjectsSymbol, Module, ModulesSdkUtils, toMikroOrmEntities } from "@medusajs/framework/utils";
import SafeStoreCreditService from "./service";

// Reuse the exact native DML objects through the SDK symbol also consumed by Module().
const nativeModels: unknown = Reflect.get(NativeModule.service, MedusaServiceModelObjectsSymbol);
if (!nativeModels || typeof nativeModels !== "object") throw new Error("Native Store Credit models unavailable");
const models = Object.values(nativeModels);
if (models.length !== 2 || !models.every(model => DmlEntity.isDmlEntity(model))) throw new Error("Unexpected native Store Credit models");
const entities = toMikroOrmEntities(models);
const nativePath = dirname(require.resolve("@medusajs/loyalty-plugin/.medusa/server/src/modules/store-credit"));
const migrationsPath = join(nativePath, "migrations");
const connectionLoader = ModulesSdkUtils.mikroOrmConnectionLoaderFactory({
  moduleName: "store_credit", moduleModels: entities, migrationsPath,
});
const containerLoader = ModulesSdkUtils.moduleContainerLoaderFactory({
  moduleModels: Object.fromEntries(entities.map(entity => [entity.name, entity])), moduleServices: {},
});
// No discoveryPath: that would reload the stock service. No plugin HTTP routes/hooks.
export default {
  ...Module("store_credit", { service: SafeStoreCreditService, loaders: [connectionLoader, containerLoader] }),
  // Migration discovery otherwise uses this wrapper's directory, not the connection loader's path.
  runMigrations: ModulesSdkUtils.buildMigrationScript({ moduleName: "store_credit", pathToMigrations: migrationsPath }),
  revertMigration: ModulesSdkUtils.buildRevertMigrationScript({ moduleName: "store_credit", pathToMigrations: migrationsPath }),
};
