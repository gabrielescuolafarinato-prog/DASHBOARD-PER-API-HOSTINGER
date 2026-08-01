import { describe, expect, it } from "vitest";
import { getCapability } from "./capabilities";

describe("Hostinger capability policy", () => {
  it("denies an unregistered capability by default", () => {
    expect(getCapability("unknown.global.action")).toMatchObject({
      state: "DENIED",
      category: "DENY_GLOBAL",
    });
  });

  it("marks public-API gaps explicitly", () => {
    expect(getCapability("hostinger.environment").state).toBe("NOT_AVAILABLE");
  });

  it("marks only the delivered Node.js capabilities as implemented", () => {
    expect(getCapability("node.builds.list").state).toBe("IMPLEMENTED");
    expect(getCapability("node.build.logs").state).toBe("IMPLEMENTED");
    expect(getCapability("node.restart").state).toBe("IMPLEMENTED");
    expect(getCapability("node.deploy.archive").state).toBe("PLANNED");
  });

  it.each([
    "database.list",
    "database.create",
    "database.password.change",
    "database.repair",
    "database.delete",
    "database.phpmyadmin.link",
    "database.remote.connections",
  ])("marks the completed database capability %s as implemented", (key) => {
    expect(getCapability(key)).toMatchObject({
      state: "IMPLEMENTED",
      category: "SITE_RESOURCE",
    });
  });

  it.each([
    "site.cache.clear",
    "site.cache.toggle",
    "site.cacheless.toggle",
    "site.vulnerabilities.list",
    "site.vulnerabilities.patch",
  ])("marks the completed site capability %s as implemented", (key) => {
    expect(getCapability(key)).toMatchObject({
      state: "IMPLEMENTED",
      category: "SITE_DIRECT",
    });
  });

  it.each([
    "dns.records.list",
    "dns.records.create",
    "dns.records.update",
    "dns.records.delete",
    "dns.snapshots.list",
    "dns.snapshots.view",
  ])("marks the delivered domain capability %s as implemented", (key) => {
    expect(getCapability(key)).toMatchObject({
      state: "IMPLEMENTED",
      category: "DOMAIN_ASSET",
    });
  });

  it.each([
    "subdomains.list",
    "subdomains.create",
    "subdomains.delete",
    "aliases.list",
    "aliases.create",
    "aliases.delete",
  ])("marks the delivered website-domain capability %s as implemented", (key) => {
    expect(getCapability(key)).toMatchObject({
      state: "IMPLEMENTED",
      category: "SITE_RESOURCE",
    });
  });

  it.each(["dns.snapshots.restore", "dns.zone.reset"])(
    "keeps destructive full-zone capability %s planned and unavailable",
    (key) => {
      expect(getCapability(key).state).toBe("PLANNED");
    },
  );
});
