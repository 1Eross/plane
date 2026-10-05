/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import {
  RESEARCH_CYCLE_CHECKED_RELATIONS,
  RESEARCH_FEEDBACK_RELATIONS,
  RESEARCH_FLOW_RELATIONS,
} from "@plane/constants";
import type { TResearchGraphEdge, TResearchGraphNode, TResearchRelation } from "@plane/types";

export type TResearchGraphModel = {
  nodesById: Map<string, TResearchGraphNode>;
  // Flow tree (question -> hypothesis -> experiment -> evidence -> new question): drives ranks and collapsing
  flowParents: Map<string, string[]>;
  flowChildren: Map<string, string[]>;
  flowEdges: TResearchGraphEdge[];
  // Evidence feeding back into hypotheses and questions: drawn, never ranked or collapsed
  feedbackEdges: TResearchGraphEdge[];
  // Regular relations (relates_to, blocked_by, ...): dashed
  auxiliaryEdges: TResearchGraphEdge[];
};

/** Parent and child of a flow edge, or null when the edge is not part of the flow tree. */
export const getFlowEndpoints = (edge: TResearchGraphEdge): { parent: string; child: string } | null => {
  const flow = RESEARCH_FLOW_RELATIONS[edge.relation_type as TResearchRelation];
  if (!flow) return null;
  return flow.parent === "source"
    ? { parent: edge.source, child: edge.target }
    : { parent: edge.target, child: edge.source };
};

export const buildResearchGraph = (nodes: TResearchGraphNode[], edges: TResearchGraphEdge[]): TResearchGraphModel => {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const flowParents = new Map<string, string[]>(nodes.map((node) => [node.id, []]));
  const flowChildren = new Map<string, string[]>(nodes.map((node) => [node.id, []]));
  const flowEdges: TResearchGraphEdge[] = [];
  const feedbackEdges: TResearchGraphEdge[] = [];
  const auxiliaryEdges: TResearchGraphEdge[] = [];

  for (const edge of edges) {
    if (!nodesById.has(edge.source) || !nodesById.has(edge.target)) continue;
    const endpoints = getFlowEndpoints(edge);
    if (endpoints) {
      flowEdges.push(edge);
      flowParents.get(endpoints.child)?.push(endpoints.parent);
      flowChildren.get(endpoints.parent)?.push(endpoints.child);
    } else if (RESEARCH_FEEDBACK_RELATIONS.includes(edge.relation_type as TResearchRelation)) {
      feedbackEdges.push(edge);
    } else {
      auxiliaryEdges.push(edge);
    }
  }

  return { nodesById, flowParents, flowChildren, flowEdges, feedbackEdges, auxiliaryEdges };
};

export type TEmbeddedEvidence = {
  id: string;
  relation: TResearchRelation;
  weight: TResearchGraphEdge["weight"];
};

/**
 * Evidence shown inside the nodes it supports, opposes or informs instead of as cards of its own.
 * Evidence that raises a question stays a card (it is a parent in the flow tree), as does evidence that feeds nothing.
 */
export const groupResearchEvidence = (
  model: TResearchGraphModel
): { embeddedIds: Set<string>; evidenceByTarget: Map<string, TEmbeddedEvidence[]> } => {
  const embeddedIds = new Set<string>();
  const evidenceByTarget = new Map<string, TEmbeddedEvidence[]>();
  for (const edge of model.feedbackEdges) {
    const source = model.nodesById.get(edge.source);
    if (source?.research_type !== "evidence" || (model.flowChildren.get(edge.source)?.length ?? 0) > 0) continue;
    embeddedIds.add(edge.source);
    const items = evidenceByTarget.get(edge.target) ?? [];
    items.push({ id: edge.source, relation: edge.relation_type as TResearchRelation, weight: edge.weight });
    evidenceByTarget.set(edge.target, items);
  }
  return { embeddedIds, evidenceByTarget };
};

/**
 * Whether adding the stored relation source -> target closes a loop.
 * With the research grammar loops can only form through "raises" and "derived_from".
 */
export const wouldCreateResearchCycle = (
  edges: TResearchGraphEdge[],
  sourceId: string,
  targetId: string,
  relation: TResearchRelation
): boolean => {
  if (sourceId === targetId) return true;
  if (!RESEARCH_CYCLE_CHECKED_RELATIONS.includes(relation)) return false;

  const next = new Map<string, string[]>();
  for (const edge of edges) {
    if (!RESEARCH_CYCLE_CHECKED_RELATIONS.includes(edge.relation_type as TResearchRelation)) continue;
    const targets = next.get(edge.source) ?? [];
    targets.push(edge.target);
    next.set(edge.source, targets);
  }

  // A cycle appears if source is already reachable from target
  const seen = new Set<string>([targetId]);
  const stack = [targetId];
  while (stack.length) {
    const current = stack.pop()!;
    for (const neighbour of next.get(current) ?? []) {
      if (neighbour === sourceId) return true;
      if (!seen.has(neighbour)) {
        seen.add(neighbour);
        stack.push(neighbour);
      }
    }
  }
  return false;
};
