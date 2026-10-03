export { listZones as GET } from "../../../../lib/location-http";
import { saveZone } from "../../../../lib/location-http";
export const POST = saveZone(true);
