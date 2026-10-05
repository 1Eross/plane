/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { TResearchGraphNode } from "@plane/types";
import type { TResearchGraphModel } from "./graph";

export type TResearchVisibilityOptions = {
  collapsedIds?: ReadonlySet<string>;
  // Nodes hidden by a filter, e.g. rejected / superseded branches; their children follow the DAG rule
  isHidden?: (node: TResearchGraphNode) => boolean;
};

export type TResearchVisibility = {
  visibleIds: Set<string>;
  // For each collapsed node: how many nodes below it are hidden
  hiddenDescendantCount: Map<string, number>;
};

/**
 * Collapsing in a DAG: a node stays visible while at least one of its flow
 * parents is visible and expanded. A merged hypothesis disappears only when
 * every branch leading to it is collapsed or hidden.
 */
export const computeResearchVisibility = (
  graph: TResearchGraphModel,
  { collapsedIds = new Set(), isHidden = () => false }: TResearchVisibilityOptions = {}
): TResearchVisibility => {
  const { nodesById, flowParents, flowChildren } = graph;

  // Kahn's topological order over the flow tree
  const pendingParents = new Map<string, number>();
  for (const [id, parents] of flowParents) pendingParents.set(id, parents.length);
  const order: string[] = [];
  const queue = [...nodesById.keys()].filter((id) => pendingParents.get(id) === 0);
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const child of flowChildren.get(id) ?? []) {
      const remaining = (pendingParents.get(child) ?? 0) - 1;
      pendingParents.set(child, remaining);
      if (remaining === 0) queue.push(child);
    }
  }
  // Nodes left over sit on a cycle the server should have prevented; treat them as roots
  const ordered = new Set(order);
  const onCycle = [...nodesById.keys()].filter((id) => !ordered.has(id));

  const visibleIds = new Set<string>();
  const decide = (id: string, ignoreParents: boolean) => {
    const node = nodesById.get(id);
    if (!node || isHidden(node)) return;
    const parents = ignoreParents ? [] : (flowParents.get(id) ?? []);
    const reachable =
      parents.length === 0 || parents.some((parent) => visibleIds.has(parent) && !collapsedIds.has(parent));
    if (reachable) visibleIds.add(id);
  };
  order.forEach((id) => decide(id, false));
  onCycle.forEach((id) => decide(id, true));

  const hiddenDescendantCount = new Map<string, number>();
  for (const collapsedId of collapsedIds) {
    if (!visibleIds.has(collapsedId)) continue;
    const seen = new Set<string>();
    const stack = [...(flowChildren.get(collapsedId) ?? [])];
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      stack.push(...(flowChildren.get(id) ?? []));
    }
    hiddenDescendantCount.set(collapsedId, [...seen].filter((id) => !visibleIds.has(id)).length);
  }

  return { visibleIds, hiddenDescendantCount };
};
