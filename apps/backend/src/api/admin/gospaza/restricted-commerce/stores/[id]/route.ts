import { restrictedHandler } from "../../../../../../lib/restricted-http";
export const GET = restrictedHandler("registration",true);
export const POST = restrictedHandler("review",true);
