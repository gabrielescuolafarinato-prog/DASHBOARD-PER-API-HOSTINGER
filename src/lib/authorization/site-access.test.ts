import { describe, expect, it } from "vitest";
import { authorizeSiteRecord, type SiteAccessRecord } from "./policy";

const membership: SiteAccessRecord = {
  siteId: "11111111-1111-4111-8111-111111111111",
  name: "Production",
  primaryDomain: "example.com",
  hostingerUsername: "u123",
  membershipRole: "MEMBER",
};

describe("site access boundary", () => {
  it("rejects manual siteId tampering with a not-found response", () => {
    expect(() =>
      authorizeSiteRecord("22222222-2222-4222-8222-222222222222", membership),
    ).toThrowError(expect.objectContaining({ status: 404 }));
  });

  it("rejects a user without membership", () => {
    expect(() => authorizeSiteRecord(membership.siteId, undefined)).toThrowError(
      expect.objectContaining({ status: 404 }),
    );
  });
});
