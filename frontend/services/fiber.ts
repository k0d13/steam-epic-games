// React keeps each DOM node's fiber under a key suffixed per build, the only way
// into components Steam doesn't export.

export interface Fiber {
  memoizedProps: Record<string, unknown> | null;
  stateNode: unknown;
  child: Fiber | null;
  sibling: Fiber | null;
  return: Fiber | null;
}

/** A DOM node's fiber, or the root fiber for a React container. */
export function getFiber(node: Element): Fiber | undefined {
  for (const key of Object.keys(node)) {
    if (key.startsWith("__reactFiber$") || key.startsWith("__reactContainer$")) {
      return Reflect.get(node, key) as Fiber;
    }
  }
  return undefined;
}

/** The first fiber from `node` up to the root that `matches`, and what it returned. */
export function findUp<T>(node: Element, matches: (fiber: Fiber) => T | undefined): T | undefined {
  for (let fiber = getFiber(node); fiber; fiber = fiber.return ?? undefined) {
    const found = matches(fiber);
    if (found !== undefined) return found;
  }
  return undefined;
}
