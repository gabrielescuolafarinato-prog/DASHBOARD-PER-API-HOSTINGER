import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import ApplicationError from "./error";

describe("application error boundary", () => {
  it("renders a controlled message without exposing internal error details", () => {
    const markup = renderToStaticMarkup(
      <ApplicationError
        error={
          new Error(
            "database failed: DATABASE_URL=postgresql://secret@example.test",
          )
        }
        reset={vi.fn()}
      />,
    );

    expect(markup).toContain("Accesso non verificabile");
    expect(markup).toContain("Riprova");
    expect(markup).not.toContain("DATABASE_URL");
    expect(markup).not.toContain("postgresql://");
    expect(markup).not.toContain("database failed");
  });
});
