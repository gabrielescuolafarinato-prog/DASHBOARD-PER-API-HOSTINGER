import { describe, expect, it } from "vitest";
import {
  assertHostingerSiteAccess,
  hasHostingerSiteAccess,
  hostingerSiteCapabilities,
} from "./permissions";

describe("uniform Hostinger site capability policy", () => {
  it.each(hostingerSiteCapabilities)(
    "grants ADMIN and MEMBER the same access to %s",
    (capability) => {
      expect(hasHostingerSiteAccess("ADMIN", capability)).toBe(true);
      expect(hasHostingerSiteAccess("MEMBER", capability)).toBe(true);
      expect(() =>
        assertHostingerSiteAccess("ADMIN", capability),
      ).not.toThrow();
      expect(() =>
        assertHostingerSiteAccess("MEMBER", capability),
      ).not.toThrow();
    },
  );

  it.each([
    "unknown.global.action",
    "node.deploy.archive",
    "hostinger.site.sync",
    "site.file.manager",
  ])("denies unimplemented, administrative or unknown key %s", (key) => {
    expect(hasHostingerSiteAccess("ADMIN", key)).toBe(false);
    expect(hasHostingerSiteAccess("MEMBER", key)).toBe(false);
  });
});
