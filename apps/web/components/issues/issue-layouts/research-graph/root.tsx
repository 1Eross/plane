/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { observer } from "mobx-react";
import { useParams } from "next/navigation";
import useSWR from "swr";
import { Background, Controls, MarkerType, Panel, ReactFlow } from "@xyflow/react";
import type { BuiltInEdge, Connection, Edge, EdgeMouseHandler, NodeChange } from "@xyflow/react";
// plane imports
import { Spinner } from "@plane/blocks/spinner";
import { setToast } from "@plane/blocks/toast";
import { EUserPermissions, EUserPermissionsLevel, RESEARCH_RELATION_I18N_LABEL } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import type {
  TResearchGraphEdge,
  TResearchGraphNode,
  TResearchGraphScopeType,
  TResearchRelation,
  TResearchRelationWeight,
  TWorkItemFilterExpression,
} from "@plane/types";
import { buildResearchGraph, cn, computeResearchVisibility, getFlowEndpoints, isResearchRelation } from "@plane/utils";
// components
import { AchMatrixDialog } from "@/components/issues/research/ach-matrix-dialog";
import { useResearchErrorToast } from "@/components/issues/research/use-research";
// hooks
import { useIssueDetail } from "@/hooks/store/use-issue-detail";
import { useProject } from "@/hooks/store/use-project";
import { useUserPermissions } from "@/hooks/store/user";
// services
import { IssueService, ResearchService } from "@/services/issue";
// local imports
import { ResearchActionDialog } from "./action-dialog";
import type { TActionDialogResult, TRelationChoice } from "./action-dialog";
import { layoutResearchGraph } from "./auto-layout";
import { ResearchEdgePanel } from "./edge-panel";
import { getConnectionChoices } from "./graph-actions";
import type { TNodeAction } from "./graph-actions";
import { useResearchGraphLayout } from "./use-graph-layout";
import { ResearchNode } from "./research-node";
import type { TResearchFlowNode } from "./research-node";

const researchService = new ResearchService();
const issueService = new IssueService();
const nodeTypes = { research: ResearchNode };

const FLOW_EDGE_COLOR = "#9CA3AF";
const FEEDBACK_EDGE_COLOR: Partial<Record<TResearchRelation, string>> = {
  supports: "#16A34A",
  opposes: "#DC2626",
  informs: "#3F76FF",
};
const CLOSED_STATUSES = new Set(["rejected", "superseded"]);

type TDialogState =
  | { kind: "create"; issueId: string; action: TNodeAction }
  | { kind: "connect"; sourceId: string; targetId: string; choices: TRelationChoice[] }
  | { kind: "merge"; hypothesisIds: string[] };

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
  const [hideClosed, setHideClosed] = useState(false);
  const [dialog, setDialog] = useState<TDialogState | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [matrixQuestionId, setMatrixQuestionId] = useState<string | null>(null);
  // positions of nodes being dragged, until the drop is saved to the layout
  const [dragPositions, setDragPositions] = useState<Record<string, { x: number; y: number }>>({});
  const [showAuxiliary, setShowAuxiliary] = useState(true);
  // store hooks
  const {
    peekIssue,
    setPeekIssue,
    rootIssueStore,
    issue: { getIssueById },
    research: { createResearchRelation, updateResearchRelation, removeResearchRelation },
    addCycleToIssue,
    changeModulesInIssue,
  } = useIssueDetail();
  const { getProjectIdentifierById } = useProject();
  const { allowPermissions } = useUserPermissions();
  const showError = useResearchErrorToast();
  const canEdit = allowPermissions(
    [EUserPermissions.ADMIN, EUserPermissions.MEMBER],
    EUserPermissionsLevel.PROJECT,
    workspaceSlug,
    projectId
  );
  const layout = useResearchGraphLayout(workspaceSlug, projectId, scopeType, scopeId, canEdit);
  const { collapsedIds } = layout;
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
  const autoPositions = useMemo(() => layoutResearchGraph(model, visibleIds), [model, visibleIds]);
  const { getSavedPosition } = layout;
  const getPosition = useCallback(
    (id: string) => dragPositions[id] ?? getSavedPosition(id) ?? autoPositions.get(id),
    [autoPositions, dragPositions, getSavedPosition]
  );

  const toggleCollapse = layout.toggleCollapsed;
  const openAction = useCallback(
    (issueId: string, action: TNodeAction) => setDialog({ kind: "create", issueId, action }),
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
      const position = getPosition(id);
      const node = model.nodesById.get(id);
      if (!position || !node) return [];
      return [
        {
          id,
          type: "research" as const,
          position,
          selected: selectedIds.has(id),
          draggable: canEdit,
          data: {
            issueId: id,
            isGhost: node.is_ghost,
            collapsed: collapsedIds.has(id),
            hasChildren: (model.flowChildren.get(id)?.length ?? 0) > 0,
            hiddenCount: hiddenDescendantCount.get(id) ?? 0,
            support: scores.get(id)?.support ?? 0,
            inconsistency: scores.get(id)?.inconsistency ?? 0,
            canEdit,
            onToggleCollapse: toggleCollapse,
            onOpen: openPeek,
            onAction: openAction,
            onOpenMatrix: setMatrixQuestionId,
          },
        },
      ];
    });
  }, [
    canEdit,
    collapsedIds,
    getPosition,
    hiddenDescendantCount,
    model,
    openAction,
    openPeek,
    selectedIds,
    toggleCollapse,
    visibleIds,
  ]);

  const flowEdges: BuiltInEdge[] = useMemo(() => {
    const isVisible = (edge: TResearchGraphEdge) => visibleIds.has(edge.source) && visibleIds.has(edge.target);
    const result: BuiltInEdge[] = [];
    for (const edge of model.flowEdges) {
      const endpoints = getFlowEndpoints(edge);
      if (!endpoints || !isVisible(edge)) continue;
      result.push({
        id: edge.id,
        source: endpoints.parent,
        target: endpoints.child,
        sourceHandle: "flow-out",
        targetHandle: "flow-in",
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
        sourceHandle: "feedback-out",
        targetHandle: "feedback-in",
        // rise above the row of nodes instead of running along it
        type: "smoothstep",
        pathOptions: { offset: 28, borderRadius: 10 },
        label: edge.weight
          ? `${t(RESEARCH_RELATION_I18N_LABEL[relation])} · ${edge.weight}`
          : t(RESEARCH_RELATION_I18N_LABEL[relation]),
        labelStyle: { fill: color, fontSize: 11 },
        labelBgStyle: { fill: "var(--bg-surface-1)", fillOpacity: 0.9 },
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
          sourceHandle: "feedback-out",
          targetHandle: "feedback-in",
          style: { stroke: FLOW_EDGE_COLOR, strokeDasharray: "4 4" },
        });
      }
    }
    return result;
  }, [model, showAuxiliary, t, visibleIds]);

  // ---------- editing ----------
  const refresh = useCallback(() => void mutate(), [mutate]);
  const issueLabel = (issueId: string) => {
    const issue = getIssueById(issueId);
    return issue?.project_id ? `${getProjectIdentifierById(issue.project_id)}-${issue.sequence_id}` : "";
  };

  // drag (positions are saved to the shared layout on drop) and selection
  const dragPositionsRef = useRef(dragPositions);
  dragPositionsRef.current = dragPositions;
  const { setPosition, setCollapsed, resetPositions } = layout;
  const onNodesChange = useCallback(
    (changes: NodeChange<TResearchFlowNode>[]) => {
      for (const change of changes) {
        if (change.type === "position") {
          const position = change.position ?? dragPositionsRef.current[change.id];
          if (change.position) setDragPositions((current) => ({ ...current, [change.id]: change.position! }));
          if (change.dragging === false && position) setPosition(change.id, position);
        } else if (change.type === "select") {
          setSelectedIds((current) => {
            const next = new Set(current);
            if (change.selected) next.add(change.id);
            else next.delete(change.id);
            return next;
          });
        }
      }
    },
    [setPosition]
  );

  // connecting two nodes by dragging from a handle
  const getChoices = useCallback(
    (sourceId: string, targetId: string): TRelationChoice[] => {
      const edges = data?.edges ?? [];
      // one relation per pair of nodes
      if (
        edges.some(
          (edge) => [edge.source, edge.target].includes(sourceId) && [edge.source, edge.target].includes(targetId)
        )
      )
        return [];
      return getConnectionChoices(
        edges,
        { id: sourceId, type: model.nodesById.get(sourceId)?.research_type },
        { id: targetId, type: model.nodesById.get(targetId)?.research_type }
      );
    },
    [data, model]
  );
  const createLink = useCallback(
    async (sourceId: string, targetId: string, choice: TRelationChoice, weight?: TResearchRelationWeight) => {
      const source = getIssueById(sourceId);
      if (!workspaceSlug || !source?.project_id) return;
      try {
        await createResearchRelation(workspaceSlug, source.project_id, sourceId, choice.name, [targetId], weight);
        refresh();
      } catch (error) {
        showError(error);
      }
    },
    [createResearchRelation, getIssueById, refresh, showError, workspaceSlug]
  );
  const isValidConnection = useCallback(
    (connection: Connection | Edge) =>
      !!connection.source && !!connection.target && getChoices(connection.source, connection.target).length > 0,
    [getChoices]
  );
  const onConnect = useCallback(
    (connection: Connection) => {
      const choices = getChoices(connection.source, connection.target);
      if (choices.length === 0) {
        setToast({ type: "error", title: t("research.graph.link_not_allowed") });
        return;
      }
      if (choices.length === 1 && !choices[0].weighted)
        void createLink(connection.source, connection.target, choices[0]);
      else setDialog({ kind: "connect", sourceId: connection.source, targetId: connection.target, choices });
    },
    [createLink, getChoices, t]
  );

  // growing the graph from a node: create the work item, put it in the scope, link it
  const createNode = async (issueId: string, action: TNodeAction, name: string) => {
    const origin = getIssueById(issueId);
    if (!workspaceSlug || !projectId || !origin?.project_id) return;
    try {
      const created = await issueService.createIssue(workspaceSlug, projectId, {
        name,
        research_type: action.createType,
      });
      if (scopeType === "cycle") await addCycleToIssue(workspaceSlug, projectId, scopeId, created.id);
      if (scopeType === "module") await changeModulesInIssue(workspaceSlug, projectId, created.id, [scopeId], []);
      await createResearchRelation(workspaceSlug, origin.project_id, issueId, action.relation, [created.id]);
      refresh();
    } catch (error) {
      showError(error);
    }
  };

  // merging selected hypotheses into a new one
  const selectedHypothesisIds = [...selectedIds].filter((id) => {
    const node = model.nodesById.get(id);
    return node?.research_type === "hypothesis" && !node.is_ghost;
  });
  const mergeHypotheses = async (name: string) => {
    if (!workspaceSlug || !projectId) return;
    try {
      await researchService.mergeHypotheses(workspaceSlug, projectId, { hypothesis_ids: selectedHypothesisIds, name });
      setSelectedIds(new Set());
      refresh();
    } catch (error) {
      showError(error);
    }
  };

  // editing a research link
  const selectedEdge = data?.edges.find((edge) => edge.id === selectedEdgeId && isResearchRelation(edge.relation_type));
  const onEdgeClick: EdgeMouseHandler = useCallback((_event, edge) => setSelectedEdgeId(edge.id), []);
  const updateSelectedEdge = async (payload: {
    relation_type?: TResearchRelation;
    weight?: TResearchRelationWeight;
  }) => {
    const source = selectedEdge ? getIssueById(selectedEdge.source) : undefined;
    if (!workspaceSlug || !selectedEdge || !source?.project_id) return;
    try {
      await updateResearchRelation(workspaceSlug, source.project_id, selectedEdge.source, selectedEdge.target, payload);
      refresh();
    } catch (error) {
      showError(error);
    }
  };
  const removeSelectedEdge = async () => {
    const source = selectedEdge ? getIssueById(selectedEdge.source) : undefined;
    if (!workspaceSlug || !selectedEdge || !source?.project_id) return;
    try {
      await removeResearchRelation(
        workspaceSlug,
        source.project_id,
        selectedEdge.source,
        selectedEdge.relation_type as TResearchRelation,
        selectedEdge.target
      );
      setSelectedEdgeId(null);
      refresh();
    } catch (error) {
      showError(error);
    }
  };

  const handleDialogSubmit = async (result: TActionDialogResult) => {
    if (!dialog) return;
    if (dialog.kind === "create") await createNode(dialog.issueId, dialog.action, result.name);
    else if (dialog.kind === "connect" && result.relation)
      await createLink(dialog.sourceId, dialog.targetId, result.relation, result.weight);
    else if (dialog.kind === "merge") await mergeHypotheses(result.name);
  };

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
          nodesDraggable={canEdit}
          nodesConnectable={canEdit}
          elementsSelectable
          multiSelectionKeyCode={["Shift", "Meta"]}
          deleteKeyCode={null}
          onNodesChange={onNodesChange}
          onConnect={onConnect}
          isValidConnection={isValidConnection}
          onEdgeClick={onEdgeClick}
          onNodeClick={(event, clickedNode) => {
            // Shift / Cmd click extends the selection instead
            if (!event.shiftKey && !event.metaKey) openPeek(clickedNode.id);
          }}
          onPaneClick={() => setSelectedEdgeId(null)}
          fitView
          // large research graphs: skip rendering what is off screen
          onlyRenderVisibleElements={flowNodes.length > 300}
          minZoom={0.2}
          maxZoom={1.5}
        >
          <Background gap={24} size={1} />
          <Controls showInteractive={false} position="bottom-left" />
          <Panel position="top-left">
            <div className="flex flex-wrap items-center gap-1 rounded-md border border-subtle bg-surface-1 p-1 text-12 shadow-raised-100">
              <ToolbarButton onClick={() => setCollapsed([])}>{t("research.graph.expand_all")}</ToolbarButton>
              <ToolbarButton onClick={() => setCollapsed(parentIds)}>{t("research.graph.collapse_all")}</ToolbarButton>
              <ToolbarButton active={hideClosed} onClick={() => setHideClosed((value) => !value)}>
                {t("research.graph.hide_closed")}
              </ToolbarButton>
              <ToolbarButton active={showAuxiliary} onClick={() => setShowAuxiliary((value) => !value)}>
                {t("research.graph.show_auxiliary")}
              </ToolbarButton>
              {canEdit && (
                <ToolbarButton
                  onClick={() => {
                    resetPositions();
                    setDragPositions({});
                  }}
                >
                  {t("research.graph.reset_layout")}
                </ToolbarButton>
              )}
              {canEdit && selectedHypothesisIds.length >= 2 && (
                <ToolbarButton
                  active
                  onClick={() => setDialog({ kind: "merge", hypothesisIds: selectedHypothesisIds })}
                >
                  {t("research.graph.merge")}
                </ToolbarButton>
              )}
            </div>
          </Panel>
          {selectedEdge && (
            <Panel position="top-center">
              <ResearchEdgePanel
                edge={selectedEdge}
                sourceLabel={issueLabel(selectedEdge.source)}
                targetLabel={issueLabel(selectedEdge.target)}
                canEdit={canEdit}
                onUpdate={(payload) => void updateSelectedEdge(payload)}
                onRemove={() => void removeSelectedEdge()}
                onClose={() => setSelectedEdgeId(null)}
              />
            </Panel>
          )}
          {data?.truncated && (
            <Panel position="top-right">
              <div className="rounded-md bg-warning-subtle px-2 py-1 text-12 text-warning-primary">
                {t("research.graph.truncated")}
              </div>
            </Panel>
          )}
        </ReactFlow>
      )}
      {matrixQuestionId && workspaceSlug && projectId && (
        <AchMatrixDialog
          workspaceSlug={workspaceSlug}
          projectId={projectId}
          questionId={matrixQuestionId}
          canEdit={canEdit}
          onClose={() => {
            setMatrixQuestionId(null);
            refresh();
          }}
        />
      )}
      {dialog && (
        <ResearchActionDialog
          title={
            dialog.kind === "create"
              ? t(`research.graph.actions.${dialog.action.key}`)
              : dialog.kind === "connect"
                ? t("research.graph.connect_title")
                : t("research.graph.merge_title")
          }
          submitLabel={
            dialog.kind === "create"
              ? t("research.graph.create")
              : dialog.kind === "connect"
                ? t("research.graph.link")
                : t("research.graph.merge")
          }
          withName={dialog.kind !== "connect"}
          relationChoices={dialog.kind === "connect" ? dialog.choices : undefined}
          onSubmit={handleDialogSubmit}
          onClose={() => setDialog(null)}
        />
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
