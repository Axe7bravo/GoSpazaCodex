import { restrictedHandler } from "../../../../../../../../lib/restricted-http";
export const GET = restrictedHandler("classification",true);
export const POST = restrictedHandler("review-classification",true);
