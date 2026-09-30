import type { Nodes, Parents, Root } from "mdast";

import type { MarkdownSnapshot, UnstableMarkdownTransform } from "./types";

export type MarkdownTransformPlan = {
  readonly cache: WeakMap<Nodes, Nodes>;
  readonly transformsByParentType: Map<
    string,
    readonly UnstableMarkdownTransform[]
  >;
};

function hasChildren(node: unknown): node is Parents {
  return (
    typeof node === "object" &&
    node !== null &&
    "children" in node &&
    Array.isArray((node as { readonly children?: unknown }).children)
  );
}

function transformNode(
  node: Nodes,
  plan: MarkdownTransformPlan | undefined,
): Nodes {
  const cachedNode = plan?.cache.get(node);

  if (cachedNode !== undefined) {
    return cachedNode;
  }

  if (!hasChildren(node)) {
    plan?.cache.set(node, node);
    return node;
  }

  let children = node.children as readonly Nodes[];
  let nextChildren: Nodes[] | undefined;

  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];

    if (child === undefined) {
      continue;
    }

    const transformedChild = transformNode(child, plan);

    if (transformedChild === child && nextChildren === undefined) {
      continue;
    }

    nextChildren ??= children.slice(0, index);
    nextChildren.push(transformedChild);
  }

  children = nextChildren ?? children;

  const transforms = plan?.transformsByParentType.get(node.type);

  if (transforms !== undefined) {
    for (const transform of transforms) {
      children = transform.transform(children);
    }
  }

  const transformedNode =
    children === node.children
      ? node
      : ({
          ...node,
          children,
        } as Nodes);

  plan?.cache.set(node, transformedNode);

  return transformedNode;
}

export function createMarkdownTransformPlan(
  transforms: readonly UnstableMarkdownTransform[] | undefined,
): MarkdownTransformPlan | undefined {
  if (transforms === undefined || transforms.length === 0) {
    return undefined;
  }

  const transformsByParentType = new Map<string, UnstableMarkdownTransform[]>();

  for (const transform of transforms) {
    for (const parentType of transform.parentTypes) {
      const existing = transformsByParentType.get(parentType);

      if (existing === undefined) {
        transformsByParentType.set(parentType, [transform]);
        continue;
      }

      existing.push(transform);
    }
  }

  return {
    cache: new WeakMap(),
    transformsByParentType,
  };
}

export function applyMarkdownTransforms(
  snapshot: MarkdownSnapshot,
  plan: MarkdownTransformPlan | undefined,
): MarkdownSnapshot {
  if (plan === undefined) {
    return snapshot;
  }

  const ast = transformNode(snapshot.ast, plan) as Root;

  if (ast === snapshot.ast) {
    return snapshot;
  }

  return {
    ...snapshot,
    ast,
  };
}
