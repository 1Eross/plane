/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { describe, expect, it } from "vitest";
import type {
  TResearchGraphEdge,
  TResearchGraphNode,
  TResearchMatrixCell,
  TResearchNodeType,
  TResearchStatus,
} from "@plane/types";
import { findNonDiagnosticEvidence, rankHypotheses } from "./ach";
import { getResearchBranchName, slugifyBranchDescription } from "./branch-name";
import { getAllowedResearchRelations, isResearchRelationAllowed, toForwardResearchRelation } from "./grammar";
import { buildResearchGraph, getFlowEndpoints, groupResearchEvidence, wouldCreateResearchCycle } from "./graph";
import { computeResearchVisibility } from "./visibility";

const node = (id: string, research_type: TResearchNodeType, research_status: TResearchStatus | null = null) =>
  ({ id, name: id, research_type, research_status, is_ghost: false }) as unknown as TResearchGraphNode;

let edgeId = 0;
const edge = (source: string, target: string, relation_type: string, weight: 1 | 2 | 3 | null = null) =>
  ({ id: `e${++edgeId}`, source, target, relation_type, weight }) as TResearchGraphEdge;

describe("grammar", () => {
  it("normalises reverse relation names", () => {
    expect(toForwardResearchRelation("addressed_by")).toEqual({ relation: "addresses", reversed: true });
    expect(toForwardResearchRelation("derives")).toEqual({ relation: "derived_from", reversed: true });
    expect(toForwardResearchRelation("supports")).toEqual({ relation: "supports", reversed: false });
  });

  it("lists the relations allowed between node types", () => {
    expect(getAllowedResearchRelations("evidence", "hypothesis")).toEqual(["supports", "opposes"]);
    expect(getAllowedResearchRelations("evidence", "question")).toEqual(["informs", "raises"]);
    expect(getAllowedResearchRelations("hypothesis", "hypothesis")).toEqual(["derived_from"]);
    expect(getAllowedResearchRelations("question", "experiment")).toEqual([]);
    expect(getAllowedResearchRelations(null, "question")).toEqual([]);
  });

  it("rejects regular work items", () => {
    expect(isResearchRelationAllowed("raises", undefined, "question")).toBe(false);
  });
});

describe("graph model", () => {
  it("orients flow edges from question down to evidence and on to new questions", () => {
    expect(getFlowEndpoints(edge("h", "q", "addresses"))).toEqual({ parent: "q", child: "h" });
    expect(getFlowEndpoints(edge("e", "h", "tests"))).toEqual({ parent: "h", child: "e" });
    expect(getFlowEndpoints(edge("e", "r", "produces"))).toEqual({ parent: "e", child: "r" });
    expect(getFlowEndpoints(edge("r", "q2", "raises"))).toEqual({ parent: "r", child: "q2" });
    expect(getFlowEndpoints(edge("h2", "h1", "derived_from"))).toEqual({ parent: "h1", child: "h2" });
    expect(getFlowEndpoints(edge("r", "h", "supports"))).toBeNull();
  });

  it("splits flow, feedback and auxiliary edges and drops dangling ones", () => {
    const graph = buildResearchGraph(
      [node("q", "question"), node("h", "hypothesis"), node("r", "evidence")],
      [
        edge("h", "q", "addresses"),
        edge("r", "h", "supports", 2),
        edge("r", "q", "relates_to"),
        edge("h", "missing", "derived_from"),
      ]
    );
    expect(graph.flowEdges).toHaveLength(1);
    expect(graph.feedbackEdges).toHaveLength(1);
    expect(graph.auxiliaryEdges).toHaveLength(1);
    expect(graph.flowParents.get("h")).toEqual(["q"]);
    expect(graph.flowChildren.get("q")).toEqual(["h"]);
  });
});

describe("evidence inside its targets", () => {
  it("folds evidence into every node it supports, opposes or informs", () => {
    const graph = buildResearchGraph(
      [node("q", "question"), node("h1", "hypothesis"), node("h2", "hypothesis"), node("r", "evidence", "valid")],
      [edge("r", "h1", "supports", 2), edge("r", "h2", "opposes", 1), edge("r", "q", "informs")]
    );
    const { embeddedIds, evidenceByTarget } = groupResearchEvidence(graph);
    expect([...embeddedIds]).toEqual(["r"]);
    expect(evidenceByTarget.get("h1")).toEqual([{ id: "r", relation: "supports", weight: 2 }]);
    expect(evidenceByTarget.get("h2")).toEqual([{ id: "r", relation: "opposes", weight: 1 }]);
    expect(evidenceByTarget.get("q")).toEqual([{ id: "r", relation: "informs", weight: null }]);
  });

  it("keeps evidence as a card when it raises a question or feeds nothing", () => {
    const graph = buildResearchGraph(
      [node("h", "hypothesis"), node("q2", "question"), node("raising", "evidence"), node("loose", "evidence")],
      [edge("raising", "h", "supports", 1), edge("raising", "q2", "raises")]
    );
    const { embeddedIds, evidenceByTarget } = groupResearchEvidence(graph);
    expect(embeddedIds.size).toBe(0);
    expect(evidenceByTarget.size).toBe(0);
  });
});

describe("cycle check", () => {
  const edges = [edge("q1", "q2", "raises"), edge("q2", "q3", "raises"), edge("h2", "h1", "derived_from")];

  it("detects loops through raises and derived_from", () => {
    expect(wouldCreateResearchCycle(edges, "q3", "q1", "raises")).toBe(true);
    expect(wouldCreateResearchCycle(edges, "h1", "h2", "derived_from")).toBe(true);
    expect(wouldCreateResearchCycle(edges, "q1", "q1", "raises")).toBe(true);
  });

  it("allows legitimate structures", () => {
    expect(wouldCreateResearchCycle(edges, "q1", "q3", "raises")).toBe(false);
    // a merged hypothesis with several parents
    expect(wouldCreateResearchCycle(edges, "h2", "h3", "derived_from")).toBe(false);
    // evidence feeding back is never a cycle
    expect(wouldCreateResearchCycle(edges, "r", "h1", "supports")).toBe(false);
  });
});

describe("visibility", () => {
  // q <- h1, h2 (addresses); h3 derived from h1 and h2 (merge); e tests h3; e produces r
  const nodes = [
    node("q", "question", "open"),
    node("h1", "hypothesis", "rejected"),
    node("h2", "hypothesis", "testing"),
    node("h3", "hypothesis", "proposed"),
    node("e", "experiment"),
    node("r", "evidence", "valid"),
  ];
  const edges = [
    edge("h1", "q", "addresses"),
    edge("h2", "q", "addresses"),
    edge("h3", "h1", "derived_from"),
    edge("h3", "h2", "derived_from"),
    edge("e", "h3", "tests"),
    edge("e", "r", "produces"),
    edge("r", "h2", "supports", 1),
  ];
  const graph = buildResearchGraph(nodes, edges);

  it("shows everything by default", () => {
    expect(computeResearchVisibility(graph).visibleIds.size).toBe(6);
  });

  it("keeps a merged node while one parent branch is expanded", () => {
    const { visibleIds } = computeResearchVisibility(graph, { collapsedIds: new Set(["h1"]) });
    expect(visibleIds.has("h3")).toBe(true);
    expect(visibleIds.has("r")).toBe(true);
  });

  it("hides the merged node once every parent branch is collapsed", () => {
    const { visibleIds, hiddenDescendantCount } = computeResearchVisibility(graph, {
      collapsedIds: new Set(["h1", "h2"]),
    });
    expect([...visibleIds].toSorted()).toEqual(["h1", "h2", "q"]);
    expect(hiddenDescendantCount.get("h1")).toBe(3);
  });

  it("collapsing the root hides the whole tree", () => {
    const { visibleIds, hiddenDescendantCount } = computeResearchVisibility(graph, { collapsedIds: new Set(["q"]) });
    expect([...visibleIds]).toEqual(["q"]);
    expect(hiddenDescendantCount.get("q")).toBe(5);
  });

  it("hiding rejected branches keeps nodes reachable through another parent", () => {
    const { visibleIds } = computeResearchVisibility(graph, {
      isHidden: (item) => item.research_status === "rejected",
    });
    expect(visibleIds.has("h1")).toBe(false);
    expect(visibleIds.has("h3")).toBe(true);
  });

  it("does not loop forever on a cycle", () => {
    const cyclic = buildResearchGraph(
      [node("a", "question"), node("b", "question")],
      [edge("a", "b", "raises"), edge("b", "a", "raises")]
    );
    expect(computeResearchVisibility(cyclic).visibleIds.size).toBe(2);
  });
});

describe("analysis of competing hypotheses", () => {
  const cells: TResearchMatrixCell[] = [
    { evidence_id: "r1", hypothesis_id: "h1", relation_type: "opposes", weight: 3 },
    { evidence_id: "r1", hypothesis_id: "h2", relation_type: "supports", weight: 1 },
    { evidence_id: "r2", hypothesis_id: "h1", relation_type: "supports", weight: 2 },
    { evidence_id: "r2", hypothesis_id: "h2", relation_type: "supports", weight: 2 },
    { evidence_id: "r3", hypothesis_id: "h2", relation_type: "opposes", weight: 3 },
  ];

  it("ranks by disconfirmation and ignores invalid evidence", () => {
    const ranked = rankHypotheses({
      hypothesisIds: ["h1", "h2"],
      cells,
      validEvidenceIds: new Set(["r1", "r2"]),
    });
    expect(ranked.map((item) => item.hypothesisId)).toEqual(["h2", "h1"]);
    expect(ranked[0]).toMatchObject({ inconsistency: 0, support: 3, rank: 1 });
  });

  it("supports what-if analysis by excluding evidence", () => {
    const ranked = rankHypotheses({
      hypothesisIds: ["h1", "h2"],
      cells,
      validEvidenceIds: new Set(["r1", "r2", "r3"]),
      excludedEvidenceIds: new Set(["r1"]),
    });
    expect(ranked.map((item) => item.hypothesisId)).toEqual(["h1", "h2"]);
  });

  it("flags evidence that rates every hypothesis the same", () => {
    expect(findNonDiagnosticEvidence({ hypothesisIds: ["h1", "h2"], cells })).toEqual(new Set(["r2"]));
    expect(findNonDiagnosticEvidence({ hypothesisIds: ["h1"], cells }).size).toBe(0);
  });
});

describe("branch names", () => {
  it("builds experiment branches", () => {
    expect(
      getResearchBranchName({
        projectIdentifier: "RND",
        sequenceId: 57,
        name: "Cache warm-up for the API",
        researchType: "experiment",
      })
    ).toBe("exp/rnd-57-cache-warm-up-api");
  });

  it("transliterates Cyrillic and defaults to feat", () => {
    expect(getResearchBranchName({ projectIdentifier: "RND", sequenceId: 3, name: "Прогрев кэша" })).toBe(
      "feat/rnd-3-progrev-kesha"
    );
  });

  it("keeps descriptions short and never empty", () => {
    expect(slugifyBranchDescription("one two three four five six seven")).toBe("one-two-three-four-five");
    expect(slugifyBranchDescription("!!!")).toBe("work");
    expect(slugifyBranchDescription("Ünïcödé — test")).toBe("unicode-test");
  });
});
