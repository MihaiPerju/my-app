import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";

import {
  EmptyState,
  ErrorState,
  LoadingState,
} from "@mistralai-capabilities/feature-mistral-design-system/components";

afterEach(cleanup);

describe("product states", () => {
  test("renders an empty state", () => {
    render(<EmptyState title="No documents" description="Add a document to begin." />);

    expect(screen.getByRole("heading", { name: "No documents" })).toBeTruthy();
    expect(screen.getByText("Add a document to begin.")).toBeTruthy();
  });

  test("renders normalized error message, detail, and status", () => {
    render(
      <ErrorState
        title="Request failed"
        error={{ message: "Validation failed", detail: "Field is required", status: 422 }}
      />,
    );

    expect(screen.getByRole("heading", { name: "Request failed" })).toBeTruthy();
    expect(screen.getByText("Validation failed")).toBeTruthy();
    expect(screen.getByText("Field is required")).toBeTruthy();
    expect(screen.getByText("422")).toBeTruthy();
  });

  test("renders an accessible loading state", () => {
    render(<LoadingState title="Analyzing document" description="Extracting pages." />);

    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.getByText("Analyzing document")).toBeTruthy();
    expect(screen.getByRole("progressbar")).toBeTruthy();
  });
});
