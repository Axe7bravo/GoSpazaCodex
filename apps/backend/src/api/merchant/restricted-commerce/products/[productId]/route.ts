import { restrictedHandler } from "../../../../../lib/restricted-http";
export const GET = restrictedHandler("classification");
export const POST = restrictedHandler("propose");
