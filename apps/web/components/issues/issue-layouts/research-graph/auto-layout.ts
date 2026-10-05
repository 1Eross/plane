/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { Graph, layout } from "@dagrejs/dagre";
// plane imports
import type { TResearchGraphModel } from "@plane/utils";
import { getFlowEndpoints } from "@plane/utils";

export const RESEARCH_NODE_WIDTH = 260;
export const RESEARCH_NODE_HEIGHT = 92;
// evidence listed inside a card: rows shown before the rest collapses into "+N"
export const RESEARCH_EVIDENCE_ROW_HEIGHT = 20;
export const RESEARCH_EVIDENCE_MAX_ROWS = 3;

export const getResearchNodeHeight = (evidenceCount: number): number => {
  if (evidenceCount === 0) return RESEARCH_NODE_HEIGHT;
  const rows =
    Math.min(evidenceCount, RESEARCH_EVIDENCE_MAX_ROWS) + (evidenceCount > RESEARCH_EVIDENCE_MAX_ROWS ? 1 : 0);
  return RESEARCH_NODE_HEIGHT + 8 + rows * RESEARCH_EVIDENCE_ROW_HEIGHT;
};

export type TNodePosition = { x: number; y: number };

/**
 * Left-to-right layout of the visible flow tree:
 * question -> hypothesis -> experiment -> evidence -> new question.
 * Feedback edges (supports / opposes / informs) do not take part in ranking.
 * Returns top-left positions, as React Flow expects.
 */
export const layoutResearchGraph = (
  model: TResearchGraphModel,
  visibleIds: ReadonlySet<string>,
  getHeight: (id: string) => number = () => RESEARCH_NODE_HEIGHT
): Map<string, TNodePosition> => {
  const graph = new Graph();
  graph.setGraph({ rankdir: "LR", nodesep: 28, ranksep: 90, marginx: 24, marginy: 24 });
  graph.setDefaultEdgeLabel(() => ({}));

  for (const id of visibleIds) graph.setNode(id, { width: RESEARCH_NODE_WIDTH, height: getHeight(id) });
  for (const edge of model.flowEdges) {
    const endpoints = getFlowEndpoints(edge);
    if (!endpoints || !visibleIds.has(endpoints.parent) || !visibleIds.has(endpoints.child)) continue;
    graph.setEdge(endpoints.parent, endpoints.child);
  }

  layout(graph);

  const positions = new Map<string, TNodePosition>();
  for (const id of visibleIds) {
    const node = graph.node(id);
    if (!node) continue;
    positions.set(id, { x: node.x - RESEARCH_NODE_WIDTH / 2, y: node.y - node.height / 2 });
  }
  return positions;
};
