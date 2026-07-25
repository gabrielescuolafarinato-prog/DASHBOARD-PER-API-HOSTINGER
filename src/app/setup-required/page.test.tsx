import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import SetupRequiredPage from "./page";

describe("setup-required page", () => {
  it("renders without database or authentication configuration", () => {
    const markup = renderToStaticMarkup(<SetupRequiredPage />);
    expect(markup).toContain("Configurazione server richiesta");
    expect(markup).not.toContain("DATABASE_URL");
    expect(markup).not.toContain("AUTH_SECRET");
  });
});
