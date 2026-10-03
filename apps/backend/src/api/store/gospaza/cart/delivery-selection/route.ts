import { deliveryHandler } from "../../../../../lib/delivery-reservation-http";
export const GET = deliveryHandler("restore");
export const PUT = deliveryHandler("select");
export const DELETE = deliveryHandler("release");
