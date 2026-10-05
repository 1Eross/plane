/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { TBaseIssue } from "./issues/issue";

// Research graph: work items with a research type are nodes, research relations are typed edges

export type TResearchNodeType = "question" | "hypothesis" | "experiment" | "evidence";

export type TQuestionStatus = "open" | "answered" | "closed";
export type THypothesisStatus = "proposed" | "testing" | "confirmed" | "rejected" | "inconclusive" | "superseded";
export type TEvidenceStatus = "valid" | "invalidated";
export type TResearchStatus = TQuestionStatus | THypothesisStatus | TEvidenceStatus;

// Stored direction: "issue <relation> related_issue", e.g. "hypothesis addresses question"
export type TResearchRelation =
  | "addresses"
  | "tests"
  | "produces"
  | "supports"
  | "opposes"
  | "informs"
  | "raises"
  | "derived_from";

export type TResearchReverseRelation =
  | "addressed_by"
  | "tested_by"
  | "produced_by"
  | "supported_by"
  | "opposed_by"
  | "informed_by"
  | "raised_by"
  | "derives";

export type TResearchRelationTypes = TResearchRelation | TResearchReverseRelation;

export type TResearchRelationWeight = 1 | 2 | 3;

export type TIssueResearchDetails = {
  issue_id: string;
  research_type: TResearchNodeType | null;
  research_status: TResearchStatus | null;
  needs_review: boolean;
  statement?: string;
  success_criteria?: string;
  conclusion_html?: string;
  confidence?: number | null;
  repo_url?: string;
  branch?: string;
  commit_sha?: string;
  artifact_url?: string;
  verdict_at?: string | null;
  verdict_by_id?: string | null;
  updated_at?: string;
};

export type TIssueResearchDetailsPayload = Partial<
  Pick<
    TIssueResearchDetails,
    | "statement"
    | "success_criteria"
    | "conclusion_html"
    | "confidence"
    | "repo_url"
    | "branch"
    | "commit_sha"
    | "artifact_url"
  >
>;

export type TResearchGraphScopeType = "project" | "cycle" | "module" | "view";

export type TResearchGraphNode = TBaseIssue & {
  // A research neighbour that did not match the filters, shown so the graph does not break apart
  is_ghost: boolean;
};

export type TResearchGraphEdge = {
  id: string;
  // Stored direction; relation_type is a forward research relation or a regular relation type
  source: string;
  target: string;
  relation_type: string;
  weight: TResearchRelationWeight | null;
};

export type TResearchGraph = {
  nodes: TResearchGraphNode[];
  edges: TResearchGraphEdge[];
  truncated: boolean;
};

export type TResearchGraphLayoutNode = {
  x?: number;
  y?: number;
  collapsed?: boolean;
};

export type TResearchGraphLayout = {
  scope_type: TResearchGraphScopeType;
  scope_id: string;
  nodes: Record<string, TResearchGraphLayoutNode>;
  updated_at: string | null;
};

export type TResearchMergePayload = {
  hypothesis_ids: string[];
  name: string;
};

export type TResearchMergeResponse = {
  issue: TBaseIssue;
  derived_from: string[];
  addresses: string[];
};

export type TResearchMatrixItem = {
  id: string;
  name: string;
  sequence_id: number;
  research_status: TResearchStatus | null;
  needs_review: boolean;
};

export type TResearchMatrixHypothesis = TResearchMatrixItem & {
  inconsistency: number;
  support: number;
  rank: number;
};

export type TResearchMatrixEvidence = TResearchMatrixItem & {
  diagnostic: boolean;
};

export type TResearchMatrixCell = {
  evidence_id: string;
  hypothesis_id: string;
  relation_type: "supports" | "opposes";
  weight: TResearchRelationWeight | null;
};

export type TResearchMatrix = {
  question: TResearchMatrixItem;
  hypotheses: TResearchMatrixHypothesis[];
  evidence: TResearchMatrixEvidence[];
  cells: TResearchMatrixCell[];
};
