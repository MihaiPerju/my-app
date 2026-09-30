import { isImportedName } from "./guards";

const validated = { a: "x" } satisfies Record<string, string>;

const inferred = { a: 1, b: 2 };

const accumulator: Record<string, number> = {};

const candidate = "hello";
isImportedName(candidate);
