import { ModuleProvider, Modules } from "@medusajs/framework/utils";
import RegisteredYocoPaymentService from "./registered-service";

// Registered only when the explicit YOCO_ENABLED configuration is valid.
export default ModuleProvider(Modules.PAYMENT, { services: [RegisteredYocoPaymentService] });
