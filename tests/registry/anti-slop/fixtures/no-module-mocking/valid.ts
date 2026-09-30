import { mock } from "bun:test";
import { vi } from "vitest";

function makeRecorder() {
  return { module: (_id: string) => undefined };
}

function usesLocalMock() {
  const mock = makeRecorder();
  mock.module("./collaborator");
}

vi.fn();
mock.restore();
usesLocalMock();
