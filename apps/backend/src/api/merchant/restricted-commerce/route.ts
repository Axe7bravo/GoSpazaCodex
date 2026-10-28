import { restrictedHandler } from "../../../lib/restricted-http";
export const GET = restrictedHandler("registration");
export const POST = restrictedHandler("submit");
