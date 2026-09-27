export { listAddresses as GET } from "../../../../lib/location-http";
import { saveAddress } from "../../../../lib/location-http";
export const POST = saveAddress(true);
