/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type {
  TResearchNodeType,
  TResearchRelation,
  TResearchRelationTypes,
  TResearchRelationWeight,
  TResearchReverseRelation,
  TResearchStatus,
} from "@plane/types";

// Mirrors apps/api/plane/utils/research_grammar.py; the server is the source of truth

export const RESEARCH_NODE_TYPES: TResearchNodeType[] = ["question", "hypothesis", "experiment", "evidence"];

export const RESEARCH_STATUSES_BY_TYPE: Record<TResearchNodeType, TResearchStatus[]> = {
  question: ["open", "answered", "closed"],
  hypothesis: ["proposed", "testing", "confirmed", "rejected", "inconclusive", "superseded"],
  // Experiments are tracked by regular workflow states
  experiment: [],
  evidence: ["valid", "invalidated"],
};

export const INITIAL_RESEARCH_STATUS: Record<TResearchNodeType, TResearchStatus | null> = {
  question: "open",
  hypothesis: "proposed",
  experiment: null,
  evidence: "valid",
};

// Computed by the server, cannot be set by hand
export const COMPUTED_RESEARCH_STATUSES: TResearchStatus[] = ["answered"];

export const RESEARCH_VERDICT_STATUSES: TResearchStatus[] = ["confirmed", "rejected", "inconclusive"];

// A verdict needs at least one valid evidence linked by this relation
export const RESEARCH_VERDICT_BASIS: Partial<Record<TResearchStatus, TResearchRelation>> = {
  confirmed: "supports",
  rejected: "opposes",
};

// relation -> allowed source and target node types (stored direction: source <relation> target)
export const RESEARCH_RELATION_GRAMMAR: Record<
  TResearchRelation,
  { sources: TResearchNodeType[]; targets: TResearchNodeType[] }
> = {
  addresses: { sources: ["hypothesis"], targets: ["question"] },
  tests: { sources: ["experiment"], targets: ["hypothesis"] },
  produces: { sources: ["experiment"], targets: ["evidence"] },
  supports: { sources: ["evidence"], targets: ["hypothesis"] },
  opposes: { sources: ["evidence"], targets: ["hypothesis"] },
  informs: { sources: ["evidence"], targets: ["question"] },
  raises: { sources: ["question", "hypothesis", "experiment", "evidence"], targets: ["question"] },
  derived_from: { sources: ["hypothesis"], targets: ["hypothesis"] },
};

export const RESEARCH_RELATIONS = Object.keys(RESEARCH_RELATION_GRAMMAR) as TResearchRelation[];

export const RESEARCH_REVERSE_RELATION: Record<TResearchRelation, TResearchReverseRelation> = {
  addresses: "addressed_by",
  tests: "tested_by",
  produces: "produced_by",
  supports: "supported_by",
  opposes: "opposed_by",
  informs: "informed_by",
  raises: "raised_by",
  derived_from: "derives",
};

export const RESEARCH_FORWARD_RELATION = Object.fromEntries(
  Object.entries(RESEARCH_REVERSE_RELATION).map(([forward, reverse]) => [reverse, forward])
) as Record<TResearchReverseRelation, TResearchRelation>;

export const RESEARCH_WEIGHTED_RELATIONS: TResearchRelation[] = ["supports", "opposes"];

// With this grammar a cycle can only appear through these relations
export const RESEARCH_CYCLE_CHECKED_RELATIONS: TResearchRelation[] = ["raises", "derived_from"];

/**
 * Flow tree: the relations that drive layout ranks and collapsing.
 * "parent" says which end of the stored relation is the parent in the flow
 * question -> hypothesis -> experiment -> evidence -> new question.
 */
export const RESEARCH_FLOW_RELATIONS: Partial<Record<TResearchRelation, { parent: "source" | "target" }>> = {
  addresses: { parent: "target" },
  tests: { parent: "target" },
  produces: { parent: "source" },
  raises: { parent: "source" },
  derived_from: { parent: "target" },
};

// Drawn on top of the layout, never ranked or collapsed: evidence feeding back into hypotheses and questions
export const RESEARCH_FEEDBACK_RELATIONS: TResearchRelation[] = ["supports", "opposes", "informs"];

export const RESEARCH_RELATION_WEIGHTS: TResearchRelationWeight[] = [1, 2, 3];

export const RESEARCH_NODE_TYPE_MAP: Record<
  TResearchNodeType,
  { key: TResearchNodeType; i18n_label: string; short_label: string; color: string }
> = {
  question: { key: "question", i18n_label: "research.node_types.question", short_label: "Q", color: "#3F76FF" },
  hypothesis: { key: "hypothesis", i18n_label: "research.node_types.hypothesis", short_label: "H", color: "#8B5CF6" },
  experiment: { key: "experiment", i18n_label: "research.node_types.experiment", short_label: "E", color: "#F59E0B" },
  evidence: { key: "evidence", i18n_label: "research.node_types.evidence", short_label: "R", color: "#14B8A6" },
};

export const RESEARCH_STATUS_MAP: Record<TResearchStatus, { key: TResearchStatus; i18n_label: string; color: string }> =
  {
    open: { key: "open", i18n_label: "research.statuses.open", color: "#3F76FF" },
    answered: { key: "answered", i18n_label: "research.statuses.answered", color: "#16A34A" },
    closed: { key: "closed", i18n_label: "research.statuses.closed", color: "#60646C" },
    proposed: { key: "proposed", i18n_label: "research.statuses.proposed", color: "#60646C" },
    testing: { key: "testing", i18n_label: "research.statuses.testing", color: "#F59E0B" },
    confirmed: { key: "confirmed", i18n_label: "research.statuses.confirmed", color: "#16A34A" },
    rejected: { key: "rejected", i18n_label: "research.statuses.rejected", color: "#DC2626" },
    inconclusive: { key: "inconclusive", i18n_label: "research.statuses.inconclusive", color: "#A16207" },
    superseded: { key: "superseded", i18n_label: "research.statuses.superseded", color: "#9CA3AF" },
    valid: { key: "valid", i18n_label: "research.statuses.valid", color: "#16A34A" },
    invalidated: { key: "invalidated", i18n_label: "research.statuses.invalidated", color: "#DC2626" },
  };

export const RESEARCH_RELATION_I18N_LABEL: Record<TResearchRelationTypes, string> = {
  addresses: "research.relations.addresses",
  addressed_by: "research.relations.addressed_by",
  tests: "research.relations.tests",
  tested_by: "research.relations.tested_by",
  produces: "research.relations.produces",
  produced_by: "research.relations.produced_by",
  supports: "research.relations.supports",
  supported_by: "research.relations.supported_by",
  opposes: "research.relations.opposes",
  opposed_by: "research.relations.opposed_by",
  informs: "research.relations.informs",
  informed_by: "research.relations.informed_by",
  raises: "research.relations.raises",
  raised_by: "research.relations.raised_by",
  derived_from: "research.relations.derived_from",
  derives: "research.relations.derives",
};

export const RESEARCH_RELATION_WEIGHT_I18N_LABEL: Record<TResearchRelationWeight, string> = {
  1: "research.weights.weak",
  2: "research.weights.moderate",
  3: "research.weights.strong",
};
