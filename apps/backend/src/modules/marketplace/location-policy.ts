import { z } from "@medusajs/framework/zod";
import { MedusaError } from "@medusajs/framework/utils";

export type Position = [number, number];
export type Geometry = { type: "Polygon"; coordinates: Position[][] } | { type: "MultiPolygon"; coordinates: Position[][][] };
const position = z.tuple([z.number().finite().min(-180).max(180), z.number().finite().min(-90).max(90)]);
const ring = z.array(position).min(4).max(500);
const polygon = z.array(ring).min(1).max(20);
const shape = z.discriminatedUnion("type", [
  z.object({ type: z.literal("Polygon"), coordinates: polygon }).strict(),
  z.object({ type: z.literal("MultiPolygon"), coordinates: z.array(polygon).min(1).max(20) }).strict(),
]);
export const coordinates = z.object({
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
}).strict();
export const locationInput = coordinates.extend({ source: z.enum(["browser_geolocation", "manual"]) }).strict();
export function input<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new MedusaError(MedusaError.Types.INVALID_DATA, "Invalid location or service-zone input.");
  return parsed.data;
}
function cross(a: Position, b: Position, p: Position) {
  return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
}
function onSegment(a: Position, b: Position, p: Position) {
  return Math.abs(cross(a, b, p)) <= 1e-10 && p[0] >= Math.min(a[0], b[0]) && p[0] <= Math.max(a[0], b[0])
    && p[1] >= Math.min(a[1], b[1]) && p[1] <= Math.max(a[1], b[1]);
}
function intersects(a: Position, b: Position, c: Position, d: Position) {
  return onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b)
    || ((cross(a, b, c) > 0) !== (cross(a, b, d) > 0)) && ((cross(c, d, a) > 0) !== (cross(c, d, b) > 0));
}
// 0 outside, 1 inside, 2 boundary. Outer and hole boundaries are included.
function inRing(point: Position, points: Position[]): number {
  let inside = false;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!, b = points[i + 1]!;
    if (onSegment(a, b, point)) return 2;
    if ((a[1] > point[1]) !== (b[1] > point[1]) &&
        point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside ? 1 : 0;
}
export function validateGeometry(value: unknown): Geometry {
  const geometry = input(shape, value);
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  if (polygons.flat(2).length > 2000) throw new MedusaError(MedusaError.Types.INVALID_DATA, "Geometry exceeds 2000 coordinates.");
  for (const rings of polygons) {
    for (const points of rings) {
      const first = points[0]!, last = points.at(-1)!;
      let area = 0;
      if (first[0] !== last[0] || first[1] !== last[1]) throw new MedusaError(MedusaError.Types.INVALID_DATA, "Polygon rings must be closed.");
      for (let i = 0; i < points.length - 1; i++) {
        const a = points[i]!, b = points[i + 1]!;
        if ((a[0] === b[0] && a[1] === b[1]) || Math.abs(a[0] - b[0]) > 180) throw new MedusaError(MedusaError.Types.INVALID_DATA, "Duplicate points and antimeridian edges are unsupported.");
        area += a[0] * b[1] - b[0] * a[1];
        for (let j = i + 2; j < points.length - 1; j++) {
          if (i === 0 && j === points.length - 2) continue;
          if (intersects(a, b, points[j]!, points[j + 1]!)) throw new MedusaError(MedusaError.Types.INVALID_DATA, "Polygon rings must not self-intersect.");
        }
      }
      if (Math.abs(area) < 1e-10) throw new MedusaError(MedusaError.Types.INVALID_DATA, "Polygon rings need nonzero area.");
    }
    for (let i = 1; i < rings.length; i++) {
      if (inRing(rings[i]![0]!, rings[0]!) !== 1) throw new MedusaError(MedusaError.Types.INVALID_DATA, "Holes must be inside the outer ring.");
      for (let j = 0; j < i; j++) {
        const a = rings[i]!, b = rings[j]!;
        for (let k = 0; k < a.length - 1; k++) for (let l = 0; l < b.length - 1; l++) {
          if (intersects(a[k]!, a[k + 1]!, b[l]!, b[l + 1]!)) throw new MedusaError(MedusaError.Types.INVALID_DATA, "Polygon rings must not intersect.");
        }
        if (j > 0 && (inRing(a[0]!, b) || inRing(b[0]!, a))) throw new MedusaError(MedusaError.Types.INVALID_DATA, "Holes must not overlap.");
      }
    }
  }
  return geometry;
}
export const geometryService = {
  contains(geometry: Geometry, latitude: number, longitude: number): boolean {
    input(coordinates, { latitude, longitude });
    const point: Position = [longitude, latitude];
    const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
    return polygons.some((rings) => {
      const outer = inRing(point, rings[0]!);
      return outer === 2 || outer === 1 && !rings.slice(1).some((hole) => inRing(point, hole) === 1);
    });
  },
};
export const zoneInput = z.object({
  name: z.string().trim().min(1).max(150),
  active: z.boolean(),
  geometry: shape,
  delivery_fee_minor: z.number().int().min(0).max(2147483647),
  currency_code: z.literal("zar"),
}).strict();
const text = (max: number) => z.string().trim().max(max);
export const addressInput = z.object({
  first_name: text(100).min(1), last_name: text(100).min(1),
  address_1: text(200).min(1), address_2: text(200),
  city: text(100).min(1), province: text(100).min(1), postal_code: text(20).min(1),
  country_code: z.literal("za"), phone: text(40),
  location: locationInput.nullable(),
}).strict();
export type AddressInput = z.infer<typeof addressInput>;
export type ZoneInput = z.infer<typeof zoneInput>;
