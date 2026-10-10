import type { InferTypeOf } from "@medusajs/framework/types";
import type Completion from "./models/checkout-completion";
import type Inbox from "./models/yoco-inbox";
import type Compensation from "./models/technical-compensation";
export type CompletionRow = InferTypeOf<typeof Completion>;
export type InboxRow = InferTypeOf<typeof Inbox>;
export type CompensationRow = Omit<InferTypeOf<typeof Compensation>, "amount_minor"> & { amount_minor: number | string };
