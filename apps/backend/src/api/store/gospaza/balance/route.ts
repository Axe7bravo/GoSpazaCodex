import { financialHandler } from "../../../../lib/financial-http";
export const GET = financialHandler("balance");
export const POST = financialHandler("apply-balance");
