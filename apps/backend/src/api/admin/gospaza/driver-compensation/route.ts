import { driverCompensationHandler } from "../../../../lib/driver-compensation-http";
export const GET = driverCompensationHandler("history");
export const POST = driverCompensationHandler("publish");
