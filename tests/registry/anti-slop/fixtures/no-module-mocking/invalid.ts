import { vi } from "vitest";
import { jest } from "@jest/globals";
import { mock } from "bun:test";

vi.mock("./collaborator");

jest.mock("./collaborator");

mock.module("./collaborator", () => ({}));

vi["mock"]("./collaborator");
