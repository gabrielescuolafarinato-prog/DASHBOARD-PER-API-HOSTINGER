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

  it("marks read-only build history and logs as implemented", () => {
    expect(getCapability("node.builds.list").state).toBe("IMPLEMENTED");
    expect(getCapability("node.build.logs").state).toBe("IMPLEMENTED");
    expect(getCapability("node.deploy.archive").state).toBe("PLANNED");
    expect(getCapability("node.restart").state).toBe("PLANNED");
  });
});
