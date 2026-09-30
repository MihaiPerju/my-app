const dictionary: Record<string, string> = { a: "x" };

function buildIndex(): { [key: string]: string } {
  return { a: "x" };
}

const anything: unknown = { a: 1 };

function isName(value: unknown): value is string {
  return typeof value === "string";
}

const candidate = "hello";
isName(candidate);
