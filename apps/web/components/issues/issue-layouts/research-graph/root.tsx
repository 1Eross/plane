/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { observer } from "mobx-react";
import { useParams } from "next/navigation";
import useSWR from "swr";
import { Background, Controls, MarkerType, Panel, ReactFlow } from "@xyflow/react";
import type { Edge } from "@xyflow/react";
// plane imports
import { Spinner } from "@plane/blocks/spinner";
import { RESEARCH_RELATION_I18N_LABEL } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import type {
  TResearchGraphEdge,
  TResearchGraphNode,
  TResearchGraphScopeType,
  TResearchRelation,
  TWorkItemFilterExpression,
} from "@plane/types";
import { buildResearchGraph, cn, computeResearchVisibility, getFlowEndpoints } from "@plane/utils";
// hooks
import { useIssueDetail } from "@/hooks/store/use-issue-detail";
// services
import { ResearchService } from "@/services/issue";
// local imports
import { layoutResearchGraph } from "./auto-layout";
import { ResearchNode } from "./research-node";
import type { TResearchFlowNode } from "./research-node";

const researchService = new ResearchService();
const nodeTypes = { research: ResearchNode };

const FLOW_EDGE_COLOR = "#9CA3AF";
const FEEDBACK_EDGE_COLOR: Partial<Record<TResearchRelation, string>> = {
  supports: "#16A34A",
  opposes: "#DC2626",
  informs: "#3F76FF",
};
const CLOSED_STATUSES = new Set(["rejected", "superseded"]);

type Props = {
  scopeType: TResearchGraphScopeType;
  scopeId: string;
  filters?: TWorkItemFilterExpression;
};

export const ResearchGraphRoot = observer(function ResearchGraphRoot(props: Props) {
  const { scopeType, scopeId, filters } = props;
  const { workspaceSlug: routerWorkspaceSlug, projectId: routerProjectId } = useParams();
  const workspaceSlug = routerWorkspaceSlug?.toString();
  const projectId = routerProjectId?.toString();
  const { t } = useTranslation();
  // states
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  const [hideClosed, setHideClosed] = useState(false);
  const [showAuxiliary, setShowAuxiliary] = useState(true);
  // store hooks
  const {
    peekIssue,
    setPeekIssue,
    rootIssueStore,
    issue: { getIssueById },
  } = useIssueDetail();
  // derived values
  const filtersKey = filters && Object.keys(filters).length > 0 ? JSON.stringify(filters) : "";

  const { data, isLoading, mutate } = useSWR(
    workspaceSlug && projectId ? ["RESEARCH_GRAPH", workspaceSlug, projectId, scopeType, scopeId, filtersKey] : null,
    async () => {
      const graph = await researchService.getResearchGraph(
        workspaceSlug!,
        projectId!,
        { scope_type: scopeType, scope_id: scopeId },
        filtersKey ? { filters: filtersKey } : {}
      );
      // keep nodes in the shared issue store so the peek overview and edits stay reactive
      rootIssueStore.issues.addIssue(graph.nodes);
      return graph;
    },
    { revalidateOnFocus: false }
  );

  // relations may change in the peek overview; refresh once it closes
  const isPeekOpen = !!peekIssue;
  useEffect(() => {
    if (!isPeekOpen) void mutate();
  }, [isPeekOpen, mutate]);

  // Type and status are read from the store, so edits made in the peek overview show up without a refetch.
  // The key is built during render (MobX tracks those reads); the graph is rebuilt only when it changes.
  const nodesKey = (data?.nodes ?? [])
    .map((node) => {
      const issue = getIssueById(node.id);
      return [
        node.id,
        issue?.research_type ?? node.research_type ?? "",
        issue?.research_status ?? node.research_status ?? "",
      ].join(":");
    })
    .join("|");
  const model = useMemo(() => {
    const fields = new Map(
      nodesKey
        ? nodesKey.split("|").map((entry) => {
            const [id, researchType, researchStatus] = entry.split(":");
            return [id, { research_type: researchType || null, research_status: researchStatus || null }] as const;
          })
        : []
    );
    const nodes = (data?.nodes ?? []).map((node) => Object.assign({}, node, fields.get(node.id)) as TResearchGraphNode);
    return buildResearchGraph(nodes, data?.edges ?? []);
  }, [data, nodesKey]);
  const { visibleIds, hiddenDescendantCount } = useMemo(
    () =>
      computeResearchVisibility(model, {
        collapsedIds,
        isHidden: hideClosed ? (node) => CLOSED_STATUSES.has(node.research_status ?? "") : undefined,
      }),
    [model, collapsedIds, hideClosed]
  );
  const positions = useMemo(() => layoutResearchGraph(model, visibleIds), [model, visibleIds]);

  const toggleCollapse = useCallback(
    (issueId: string) =>
      setCollapsedIds((current) => {
        const next = new Set(current);
        if (next.has(issueId)) next.delete(issueId);
        else next.add(issueId);
        return next;
      }),
    []
  );
  const openPeek = useCallback(
    (issueId: string) => {
      const issue = getIssueById(issueId);
      if (workspaceSlug && issue?.project_id) setPeekIssue({ workspaceSlug, projectId: issue.project_id, issueId });
    },
    [getIssueById, setPeekIssue, workspaceSlug]
  );

  const flowNodes: TResearchFlowNode[] = useMemo(() => {
    // weight of valid evidence for / against each hypothesis
    const scores = new Map<string, { support: number; inconsistency: number }>();
    for (const edge of model.feedbackEdges) {
      if (edge.relation_type !== "supports" && edge.relation_type !== "opposes") continue;
      if (model.nodesById.get(edge.source)?.research_status !== "valid") continue;
      const score = scores.get(edge.target) ?? { support: 0, inconsistency: 0 };
      if (edge.relation_type === "supports") score.support += edge.weight ?? 0;
      else score.inconsistency += edge.weight ?? 0;
      scores.set(edge.target, score);
    }
    return [...visibleIds].flatMap((id) => {
      const position = positions.get(id);
      const node = model.nodesById.get(id);
      if (!position || !node) return [];
      return [
        {
          id,
          type: "research" as const,
          position,
          data: {
            issueId: id,
            isGhost: node.is_ghost,
            collapsed: collapsedIds.has(id),
            hasChildren: (model.flowChildren.get(id)?.length ?? 0) > 0,
            hiddenCount: hiddenDescendantCount.get(id) ?? 0,
            support: scores.get(id)?.support ?? 0,
            inconsistency: scores.get(id)?.inconsistency ?? 0,
            onToggleCollapse: toggleCollapse,
            onOpen: openPeek,
          },
        },
      ];
    });
  }, [collapsedIds, hiddenDescendantCount, model, openPeek, positions, toggleCollapse, visibleIds]);

  const flowEdges: Edge[] = useMemo(() => {
    const isVisible = (edge: TResearchGraphEdge) => visibleIds.has(edge.source) && visibleIds.has(edge.target);
    const result: Edge[] = [];
    for (const edge of model.flowEdges) {
      const endpoints = getFlowEndpoints(edge);
      if (!endpoints || !isVisible(edge)) continue;
      result.push({
        id: edge.id,
        source: endpoints.parent,
        target: endpoints.child,
        style: { stroke: FLOW_EDGE_COLOR, strokeWidth: 1.5 },
        markerEnd: { type: MarkerType.ArrowClosed, color: FLOW_EDGE_COLOR },
      });
    }
    for (const edge of model.feedbackEdges) {
      if (!isVisible(edge)) continue;
      const relation = edge.relation_type as TResearchRelation;
      const color = FEEDBACK_EDGE_COLOR[relation] ?? FLOW_EDGE_COLOR;
      const weight = edge.weight ?? 1;
      result.push({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        label: edge.weight
          ? `${t(RESEARCH_RELATION_I18N_LABEL[relation])} · ${edge.weight}`
          : t(RESEARCH_RELATION_I18N_LABEL[relation]),
        labelStyle: { fill: color, fontSize: 11 },
        labelBgStyle: { fillOpacity: 0.85 },
        style: { stroke: color, strokeWidth: 1 + weight * 0.75 },
        markerEnd: { type: MarkerType.ArrowClosed, color },
      });
    }
    if (showAuxiliary) {
      for (const edge of model.auxiliaryEdges) {
        if (!isVisible(edge)) continue;
        result.push({
          id: edge.id,
          source: edge.source,
          target: edge.target,
          style: { stroke: FLOW_EDGE_COLOR, strokeDasharray: "4 4" },
        });
      }
    }
    return result;
  }, [model, showAuxiliary, t, visibleIds]);

  if (isLoading && !data) {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <Spinner />
      </div>
    );
  }

  const parentIds = [...model.flowChildren].filter(([, children]) => children.length > 0).map(([id]) => id);

  return (
    <div className="relative h-full w-full">
      {model.nodesById.size === 0 ? (
        <div className="flex h-full w-full flex-col items-center justify-center gap-1 text-center">
          <p className="text-14 font-medium text-primary">{t("research.graph.empty_title")}</p>
          <p className="text-13 text-tertiary">{t("research.graph.empty_description")}</p>
        </div>
      ) : (
        <ReactFlow
          nodes={flowNodes}
          edges={flowEdges}
          nodeTypes={nodeTypes}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          fitView
          minZoom={0.2}
          maxZoom={1.5}
        >
          <Background gap={24} size={1} />
          <Controls showInteractive={false} position="bottom-left" />
          <Panel position="top-left">
            <div className="flex flex-wrap items-center gap-1 rounded-md border border-subtle bg-surface-1 p-1 text-12 shadow-raised-100">
              <ToolbarButton onClick={() => setCollapsedIds(new Set())}>{t("research.graph.expand_all")}</ToolbarButton>
              <ToolbarButton onClick={() => setCollapsedIds(new Set(parentIds))}>
                {t("research.graph.collapse_all")}
              </ToolbarButton>
              <ToolbarButton active={hideClosed} onClick={() => setHideClosed((value) => !value)}>
                {t("research.graph.hide_closed")}
              </ToolbarButton>
              <ToolbarButton active={showAuxiliary} onClick={() => setShowAuxiliary((value) => !value)}>
                {t("research.graph.show_auxiliary")}
              </ToolbarButton>
            </div>
          </Panel>
          {data?.truncated && (
            <Panel position="top-right">
              <div className="rounded-md bg-warning-subtle px-2 py-1 text-12 text-warning-primary">
                {t("research.graph.truncated")}
              </div>
            </Panel>
          )}
        </ReactFlow>
      )}
    </div>
  );
});

function ToolbarButton(props: { active?: boolean; onClick: () => void; children: React.ReactNode }) {
  const { active = false, onClick, children } = props;
  return (
    <button
      type="button"
      aria-pressed={active}
      className={cn("rounded-sm px-2 py-1 text-secondary hover:bg-layer-1-hover", {
        "bg-layer-1-active text-primary": active,
      })}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
