/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import {
  RESEARCH_FORWARD_RELATION,
  RESEARCH_RELATION_GRAMMAR,
  RESEARCH_RELATIONS,
  RESEARCH_REVERSE_RELATION,
} from "@plane/constants";
import type { TResearchNodeType, TResearchRelation, TResearchRelationTypes } from "@plane/types";

export const isResearchRelation = (relationType: string): relationType is TResearchRelationTypes =>
  relationType in RESEARCH_REVERSE_RELATION || relationType in RESEARCH_FORWARD_RELATION;

/**
 * Normalise a relation name to the stored (forward) relation.
 * "addressed_by" -> { relation: "addresses", reversed: true }
 */
export const toForwardResearchRelation = (
  relationType: TResearchRelationTypes
): { relation: TResearchRelation; reversed: boolean } => {
  if (relationType in RESEARCH_FORWARD_RELATION) {
    return {
      relation: RESEARCH_FORWARD_RELATION[relationType as keyof typeof RESEARCH_FORWARD_RELATION],
      reversed: true,
    };
  }
  return { relation: relationType as TResearchRelation, reversed: false };
};

export const isResearchRelationAllowed = (
  relation: TResearchRelation,
  sourceType: TResearchNodeType | null | undefined,
  targetType: TResearchNodeType | null | undefined
): boolean => {
  if (!sourceType || !targetType) return false;
  const { sources, targets } = RESEARCH_RELATION_GRAMMAR[relation];
  return sources.includes(sourceType) && targets.includes(targetType);
};

/** Forward relations the grammar allows from a node of sourceType to a node of targetType. */
export const getAllowedResearchRelations = (
  sourceType: TResearchNodeType | null | undefined,
  targetType: TResearchNodeType | null | undefined
): TResearchRelation[] =>
  RESEARCH_RELATIONS.filter((relation) => isResearchRelationAllowed(relation, sourceType, targetType));
