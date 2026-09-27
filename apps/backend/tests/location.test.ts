import test from "node:test";
import assert from "node:assert/strict";
import { geometryService, validateGeometry, coordinates, input, zoneInput } from "../src/modules/marketplace/location-policy";
const square = { type: "Polygon", coordinates: [[[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]]] };
test("Polygon interior, exterior and boundaries are deterministic", () => {
  const geometry = validateGeometry(square);
  assert.equal(geometryService.contains(geometry, 2, 2), true);
  assert.equal(geometryService.contains(geometry, 5, 2), false);
  assert.equal(geometryService.contains(geometry, 0, 2), true);
  assert.equal(geometryService.contains(geometry, 0, 0), true);
});
test("holes exclude interiors but include their boundaries", () => {
  const geometry = validateGeometry({ ...square, coordinates: [...square.coordinates, [[1, 1], [1, 3], [3, 3], [3, 1], [1, 1]]] });
  assert.equal(geometryService.contains(geometry, 2, 2), false);
  assert.equal(geometryService.contains(geometry, 1, 2), true);
});
test("MultiPolygon matches either island with longitude/latitude order", () => {
  const geometry = validateGeometry({ type: "MultiPolygon", coordinates: [square.coordinates, [[[20, 10], [22, 10], [22, 12], [20, 12], [20, 10]]]] });
  assert.equal(geometryService.contains(geometry, 11, 21), true);
  assert.equal(geometryService.contains(geometry, 21, 11), false);
});
test("reject malformed, self-intersecting, degenerate, open and unbounded geometry", () => {
  for (const geometry of [null, {}, { ...square, coordinates: [] },
    { ...square, coordinates: [[[0, 0], [4, 4], [4, 0], [0, 4], [0, 0]]] },
    { ...square, coordinates: [[[0, 0], [1, 1], [2, 2], [0, 0]]] },
    { ...square, coordinates: [[[0, 0], [4, 0], [4, 4], [0, 4]]] },
    { ...square, coordinates: [[[181, 0], [4, 0], [4, 4], [181, 0]]] },
  ]) assert.throws(() => validateGeometry(geometry));
});
test("range and fee validation rejects spoofed selectors, floats and negative fees", () => {
  for (const point of [{ latitude: 91, longitude: 0 }, { latitude: 0, longitude: -181 }, { latitude: NaN, longitude: 0 },
    { latitude: 0, longitude: 0, zone_id: "forced" }, { latitude: 0, longitude: 0, merchant_store_id: "forced" }]) {
    assert.throws(() => input(coordinates, point));
  }
  const zone = { name: "Fixture", active: true, geometry: square, currency_code: "zar" };
  for (const fee of [-1, 1.2, Infinity, 2147483648]) assert.throws(() => input(zoneInput, { ...zone, delivery_fee_minor: fee }));
  assert.equal(input(zoneInput, { ...zone, delivery_fee_minor: 1099 }).delivery_fee_minor, 1099);
});
