import { describe, expect, test } from "bun:test";
import { UnexpectedResponseError } from "../src/riot/auth.ts";
import { BadClaimsError, MaintenanceError, parseStorefront } from "../src/riot/store.ts";
import { LEVEL_BULLDOG, LEVEL_JUDGE, LEVEL_VANDAL, storefrontBody } from "./fakes.ts";

describe("parseStorefront", () => {
  test("reads the offers, the time left and the VP prices", () => {
    const body = storefrontBody([LEVEL_VANDAL, LEVEL_JUDGE], { [LEVEL_VANDAL]: 2175, [LEVEL_JUDGE]: 1775 }, 3600);
    expect(parseStorefront(200, body)).toEqual({
      offers: [LEVEL_VANDAL, LEVEL_JUDGE],
      remainingSeconds: 3600,
      prices: { [LEVEL_VANDAL]: 2175, [LEVEL_JUDGE]: 1775 },
    });
  });

  test("an offer without a VP cost simply has no price", () => {
    const body = storefrontBody([LEVEL_BULLDOG]);
    expect(parseStorefront(200, body).prices).toEqual({});
  });

  test("BAD_CLAIMS is BadClaimsError", () => {
    expect(() => parseStorefront(400, { httpStatus: 400, errorCode: "BAD_CLAIMS" })).toThrow(BadClaimsError);
  });

  test("SCHEDULED_DOWNTIME is MaintenanceError (SkinPeek's isMaintenance)", () => {
    expect(() => parseStorefront(403, { httpStatus: 403, errorCode: "SCHEDULED_DOWNTIME" })).toThrow(MaintenanceError);
  });

  test("other errors are UnexpectedResponseError with the status and code", () => {
    expect(() => parseStorefront(404, { errorCode: "RESOURCE_NOT_FOUND" })).toThrow("E6 storefront returned 404 RESOURCE_NOT_FOUND");
    expect(() => parseStorefront(502, null)).toThrow(UnexpectedResponseError);
  });

  test("a 200 without SkinsPanelLayout is UnexpectedResponseError", () => {
    expect(() => parseStorefront(200, { FeaturedBundle: {} })).toThrow(UnexpectedResponseError);
  });
});
