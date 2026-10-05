/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// plane imports
import { RESEARCH_REVERSE_RELATION, RESEARCH_WEIGHTED_RELATIONS } from "@plane/constants";
import type { TResearchGraphEdge, TResearchNodeType, TResearchRelation, TResearchRelationTypes } from "@plane/types";
import { getAllowedResearchRelations, wouldCreateResearchCycle } from "@plane/utils";
// local imports
import type { TRelationChoice } from "./action-dialog";

export type TNodeAction = {
  key: "add_hypothesis" | "add_experiment" | "add_result" | "refine_hypothesis" | "raise_question";
  // type of the node the action creates
  createType: TResearchNodeType;
  // relation name seen from the node the action starts at: "<existing> <relation> <new>"
  relation: TResearchRelationTypes;
};

const RAISE_QUESTION: TNodeAction = { key: "raise_question", createType: "question", relation: "raises" };

/** What can grow from a node of each type, following the research grammar. */
export const NODE_ACTIONS: Record<TResearchNodeType, TNodeAction[]> = {
  question: [{ key: "add_hypothesis", createType: "hypothesis", relation: "addressed_by" }, RAISE_QUESTION],
  hypothesis: [
    { key: "add_experiment", createType: "experiment", relation: "tested_by" },
    { key: "refine_hypothesis", createType: "hypothesis", relation: "derives" },
    RAISE_QUESTION,
  ],
  experiment: [{ key: "add_result", createType: "evidence", relation: "produces" }, RAISE_QUESTION],
  evidence: [RAISE_QUESTION],
};

/**
 * Relations a user can create by dragging from `source` to `target`, in either stored direction,
 * named from the source node and without the ones that would close a cycle.
 */
export const getConnectionChoices = (
  edges: TResearchGraphEdge[],
  source: { id: string; type: TResearchNodeType | null | undefined },
  target: { id: string; type: TResearchNodeType | null | undefined }
): TRelationChoice[] => {
  if (source.id === target.id) return [];
  const isWeighted = (relation: TResearchRelation) => RESEARCH_WEIGHTED_RELATIONS.includes(relation);
  const forward = getAllowedResearchRelations(source.type, target.type)
    .filter((relation) => !wouldCreateResearchCycle(edges, source.id, target.id, relation))
    .map((relation) => ({ name: relation as TResearchRelationTypes, weighted: isWeighted(relation) }));
  const reverse = getAllowedResearchRelations(target.type, source.type)
    .filter((relation) => !wouldCreateResearchCycle(edges, target.id, source.id, relation))
    .map((relation) => ({ name: RESEARCH_REVERSE_RELATION[relation], weighted: isWeighted(relation) }));
  return [...forward, ...reverse];
};
