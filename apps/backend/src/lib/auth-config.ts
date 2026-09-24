export const AUTH_METHODS = {
  customer: ["emailpass"],
  user: ["emailpass"],
  merchant: ["emailpass"],
  driver: ["emailpass"],
};
export type ActorType = keyof typeof AUTH_METHODS;

