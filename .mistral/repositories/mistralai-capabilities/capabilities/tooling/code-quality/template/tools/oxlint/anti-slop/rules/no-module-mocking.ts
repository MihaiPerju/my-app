import { defineRule } from "@oxlint/plugins";

import type { ESTree, Scope, SourceCode, Variable } from "@oxlint/plugins";

type ModuleMockApi = {
  /** The binding the mocking methods hang off at a call site. */
  readonly binding: string;
  /** The methods on that binding which replace a whole module. */
  readonly methods: Record<string, true>;
  /** Whether the runner also injects the binding as a global, so an import is not required. */
  readonly global: boolean;
};

/**
 * Every runner's module-mocking entry point, keyed by the module it is imported from.
 *
 * The binding and its methods are paired per runner rather than flattened into one method set:
 * bun spells it `mock.module` and vitest spells it `vi.mock`, so a loose "is this method named
 * `mock`" test against any object would report ordinary application calls like `recorder.mock()`.
 */
const MODULE_MOCK_APIS: Record<string, ModuleMockApi> = {
  vitest: {
    binding: "vi",
    methods: { doMock: true, mock: true, unstable_mockModule: true },
    global: true,
  },
  "@jest/globals": {
    binding: "jest",
    methods: { doMock: true, mock: true, unstable_mockModule: true },
    global: true,
  },
  "bun:test": { binding: "mock", methods: { module: true }, global: false },
};

const GLOBAL_APIS = Object.values(MODULE_MOCK_APIS).filter((api) => api.global);

function resolveVariable(
  sourceCode: SourceCode,
  identifier: ESTree.IdentifierReference,
): Variable | null {
  let scope: Scope | null = sourceCode.getScope(identifier);
  while (scope !== null) {
    const variable = scope.set.get(identifier.name);
    if (variable !== undefined) return variable;
    scope = scope.upper;
  }
  return null;
}

function importedName(node: ESTree.Node): string | null {
  if (node.type !== "ImportSpecifier") return null;
  return node.imported.type === "Identifier" ? node.imported.name : node.imported.value;
}

/** The method being called, whether spelled `o.m()` or `o["m"]()`. */
function calleeMethodName(callee: ESTree.MemberExpression): string | null {
  if (callee.computed) {
    return callee.property.type === "Literal" && typeof callee.property.value === "string"
      ? callee.property.value
      : null;
  }
  return callee.property.type === "Identifier" ? callee.property.name : null;
}

/**
 * The runner API an object identifier denotes, resolved through its import binding.
 *
 * A shadowing local binding is what makes the lookup necessary: a test that declares its own `mock`
 * is not calling bun's, and reporting it would be a false positive.
 */
function resolveApi(
  sourceCode: SourceCode,
  expression: ESTree.Expression,
): ModuleMockApi | null {
  if (expression.type !== "Identifier") return null;

  const asGlobal =
    GLOBAL_APIS.find((api) => api.binding === expression.name) ?? null;
  if (asGlobal !== null && sourceCode.isGlobalReference(expression)) return asGlobal;

  const variable = resolveVariable(sourceCode, expression);
  if (variable === null || variable.defs.length === 0) return asGlobal;

  for (const definition of variable.defs) {
    if (definition.type !== "ImportBinding" || definition.parent?.type !== "ImportDeclaration") {
      continue;
    }
    const api = MODULE_MOCK_APIS[String(definition.parent.source.value)];
    if (api !== undefined && importedName(definition.node) === api.binding) return api;
  }
  return null;
}

/** Ban test framework module mocking in favor of real dependency seams. */
export const noModuleMockingRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow Vitest, Jest and Bun module mocking; tests must replace dependencies through real interfaces.",
    },
    messages: {
      moduleMock:
        "Replace module mocking with dependency injection through a real interface, service layer, or faithful test implementation.",
    },
  },
  createOnce(context) {
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== "MemberExpression") return;
        const method = calleeMethodName(callee);
        if (method === null) return;
        const api = resolveApi(context.sourceCode, callee.object);
        if (api === null || api.methods[method] !== true) return;
        context.report({ node, messageId: "moduleMock" });
      },
    };
  },
});
