export type ZoneGeometry =
  | { type: "Polygon"; coordinates: [number, number][][] }
  | { type: "MultiPolygon"; coordinates: [number, number][][][] };
export interface ServiceZoneInput {
  name: string;
  active: boolean;
  geometry: ZoneGeometry;
  delivery_fee_minor: number;
  currency_code: "zar";
}
export interface ServiceZone extends ServiceZoneInput { id: string }
export interface ZoneAssignment { id: string; name: string; active: boolean }
export interface ZoneDetail { zone: ServiceZone; assignments: ZoneAssignment[] }
export interface ZoneList { zones: ServiceZone[]; stores: (ZoneAssignment & { merchant_status: string })[] }
export interface AddressLocation { latitude: number; longitude: number; source: "browser_geolocation" | "manual" }
export interface AddressWrite {
  first_name: string; last_name: string; address_1: string; address_2: string;
  city: string; province: string; postal_code: string; country_code: "za"; phone: string;
  location: AddressLocation | null;
}
export interface SavedAddress extends AddressWrite { id: string }
export interface Serviceability { serviceable: boolean; eligible_store_count: number; zone_ids: string[] }
