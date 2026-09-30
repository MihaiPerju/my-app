import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

const FORBIDDEN_SYMBOL_NAME = "shape";

function containsForbiddenSymbolName(name: string): boolean {
  return name.toLowerCase().includes(FORBIDDEN_SYMBOL_NAME);
}

/**
 * Return whether an identifier names something this file does not choose, so renaming it is not an
 * option the author has: a static member read (`props.shapeRendering`), a JSX attribute name
 * (`<svg shapeRendering="…" />`, fixed by SVG/DOM), or the `imported` half of an aliased import
 * specifier (`import { IconShapeCircle as CircleIcon }` — the export name belongs to the module).
 */
function isBorrowedName(node: ESTree.Node): boolean {
  const parent = node.parent;
  if (parent === null) return false;
  if (parent.type === "MemberExpression") {
    return parent.property === node && parent.computed === false;
  }
  if (parent.type === "JSXAttribute") {
    return parent.name === node;
  }
  if (parent.type === "ImportSpecifier") {
    // Exempt the export name, but keep reporting the local binding. For an unaliased specifier the
    // parser gives `imported` and `local` the same node (or two at the same position), so the
    // `local !== node` guard leaves an unaliased `import { IconShapeCircle }` reported exactly once.
    return parent.imported === node && parent.local !== node;
  }
  return false;
}

/** Ban the case-insensitive substring "shape" in every JavaScript and TypeScript symbol name. */
export const noForbiddenTermInSymbolNamesRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        'Disallow the case-insensitive substring "shape" in JavaScript, TypeScript, private, and JSX symbol names, except names this file does not choose: a static member read, a JSX attribute name, and the imported half of an aliased import specifier.',
    },
    messages: {
      forbiddenSymbolName:
        'Rename symbol "{{name}}" for its domain role; "shape" describes structure rather than ownership.',
    },
  },
  createOnce(context) {
    const reportForbiddenSymbolName = (node: ESTree.Node & { name: string }) => {
      if (!containsForbiddenSymbolName(node.name) || isBorrowedName(node)) return;
      context.report({
        node,
        messageId: "forbiddenSymbolName",
        data: { name: node.name },
      });
    };

    return {
      Identifier: reportForbiddenSymbolName,
      PrivateIdentifier: reportForbiddenSymbolName,
      JSXIdentifier: reportForbiddenSymbolName,
    };
  },
});
