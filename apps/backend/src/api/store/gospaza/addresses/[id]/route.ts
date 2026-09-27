export { deleteAddress as DELETE } from "../../../../../lib/location-http";
import { saveAddress } from "../../../../../lib/location-http";
export const PATCH = saveAddress(false);
