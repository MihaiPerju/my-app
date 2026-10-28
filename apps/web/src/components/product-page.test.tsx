import { Button } from "@mistralai/ui/button";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";

import {
  ProductPage,
  ProductSection,
} from "@mistralai-capabilities/feature-mistral-design-system/components";

afterEach(cleanup);

describe("ProductPage", () => {
  test("renders product chrome and explicit layout regions", () => {
    render(
      <ProductPage
        eyebrow="Search toolkit"
        title="Evidence explorer"
        description="Inspect grounded results."
        actions={<Button>New search</Button>}
        topBar="Connected"
        panel="Result preview"
        sidebar="Saved searches"
      >
        <ProductSection title="Configuration">Search form</ProductSection>
      </ProductPage>,
    );

    expect(screen.getByRole("heading", { name: "Evidence explorer" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Configuration" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "New search" })).toBeTruthy();
    expect(screen.getByText("Connected")).toBeTruthy();
    expect(screen.getByText("Search form")).toBeTruthy();
    expect(screen.getByText("Result preview")).toBeTruthy();
    expect(screen.getByText("Saved searches")).toBeTruthy();
  });
});
