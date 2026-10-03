import { ModuleProvider, Modules } from "@medusajs/framework/utils";
import RoutedFileProvider from "./service";
export default ModuleProvider(Modules.FILE, { services: [RoutedFileProvider] });
