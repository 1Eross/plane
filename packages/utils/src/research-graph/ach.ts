/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { TResearchMatrixCell } from "@plane/types";

// Analysis of Competing Hypotheses helpers, mirroring the server's research matrix; used for "what if" analysis

export type THypothesisScore = {
  hypothesisId: string;
  inconsistency: number;
  support: number;
  rank: number;
};

/**
 * Rank hypotheses by disconfirmation: the least weight of valid evidence
 * against a hypothesis comes first, support only breaks ties.
 */
export const rankHypotheses = ({
  hypothesisIds,
  cells,
  validEvidenceIds,
  excludedEvidenceIds = new Set(),
}: {
  hypothesisIds: string[];
  cells: TResearchMatrixCell[];
  validEvidenceIds: ReadonlySet<string>;
  excludedEvidenceIds?: ReadonlySet<string>;
}): THypothesisScore[] => {
  const scores = new Map(hypothesisIds.map((id) => [id, { inconsistency: 0, support: 0 }]));
  for (const cell of cells) {
    const score = scores.get(cell.hypothesis_id);
    if (!score || !validEvidenceIds.has(cell.evidence_id) || excludedEvidenceIds.has(cell.evidence_id)) continue;
    if (cell.relation_type === "opposes") score.inconsistency += cell.weight ?? 0;
    else score.support += cell.weight ?? 0;
  }
  return hypothesisIds
    .map((hypothesisId, index) => ({ hypothesisId, index, ...scores.get(hypothesisId)! }))
    .toSorted((a, b) => a.inconsistency - b.inconsistency || b.support - a.support || a.index - b.index)
    .map(({ hypothesisId, inconsistency, support }, index) => ({
      hypothesisId,
      inconsistency,
      support,
      rank: index + 1,
    }));
};

/** Evidence that rates every hypothesis the same cannot tell them apart. */
export const findNonDiagnosticEvidence = ({
  hypothesisIds,
  cells,
}: {
  hypothesisIds: string[];
  cells: TResearchMatrixCell[];
}): Set<string> => {
  const rows = new Map<string, Map<string, string>>();
  for (const cell of cells) {
    if (!hypothesisIds.includes(cell.hypothesis_id)) continue;
    const row = rows.get(cell.evidence_id) ?? new Map<string, string>();
    row.set(cell.hypothesis_id, `${cell.relation_type}:${cell.weight ?? ""}`);
    rows.set(cell.evidence_id, row);
  }
  const nonDiagnostic = new Set<string>();
  if (hypothesisIds.length < 2) return nonDiagnostic;
  for (const [evidenceId, row] of rows) {
    if (row.size === hypothesisIds.length && new Set(row.values()).size === 1) nonDiagnostic.add(evidenceId);
  }
  return nonDiagnostic;
};
