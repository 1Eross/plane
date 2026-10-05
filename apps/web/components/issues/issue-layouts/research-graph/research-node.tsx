/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { memo } from "react";
import { observer } from "mobx-react";
import { Handle, Position } from "@xyflow/react";
import type { Node, NodeProps } from "@xyflow/react";
import { ChevronRightOutline, SubWorkItemsOutline, WarningTriangleOutline } from "@makeplane/propel/icons";
// plane imports
import { RESEARCH_NODE_TYPE_MAP, RESEARCH_STATUS_MAP } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import { cn } from "@plane/utils";
// hooks
import { useIssueDetail } from "@/hooks/store/use-issue-detail";
import { useProject } from "@/hooks/store/use-project";
import { useProjectState } from "@/hooks/store/use-project-state";
// local imports
import { RESEARCH_NODE_HEIGHT, RESEARCH_NODE_WIDTH } from "./auto-layout";

export type TResearchNodeData = {
  issueId: string;
  isGhost: boolean;
  collapsed: boolean;
  hasChildren: boolean;
  hiddenCount: number;
  // sum of weights of valid evidence for / against a hypothesis
  support: number;
  inconsistency: number;
  onToggleCollapse: (issueId: string) => void;
  onOpen: (issueId: string) => void;
};

export type TResearchFlowNode = Node<TResearchNodeData, "research">;

const ResearchNodeComponent = observer(function ResearchNodeComponent({ data }: NodeProps<TResearchFlowNode>) {
  const { issueId, isGhost, collapsed, hasChildren, hiddenCount, support, inconsistency, onToggleCollapse, onOpen } =
    data;
  const { t } = useTranslation();
  const {
    issue: { getIssueById },
  } = useIssueDetail();
  const { getProjectIdentifierById } = useProject();
  const { getStateById } = useProjectState();

  const issue = getIssueById(issueId);
  if (!issue?.research_type) return null;

  const nodeType = RESEARCH_NODE_TYPE_MAP[issue.research_type];
  const status = issue.research_status ? RESEARCH_STATUS_MAP[issue.research_status] : undefined;
  const state = issue.research_type === "experiment" && issue.state_id ? getStateById(issue.state_id) : undefined;
  const identifier = issue.project_id ? getProjectIdentifierById(issue.project_id) : "";

  return (
    <div
      className={cn(
        "flex cursor-pointer flex-col gap-1.5 rounded-lg border border-subtle bg-surface-1 px-3 py-2 shadow-raised-100 transition-colors hover:border-strong",
        { "opacity-50": isGhost, "border-warning-strong": issue.needs_review }
      )}
      style={{ width: RESEARCH_NODE_WIDTH, minHeight: RESEARCH_NODE_HEIGHT, borderLeft: `3px solid ${nodeType.color}` }}
      // the node holds its own collapse button, and buttons cannot nest
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
      role="button"
      tabIndex={0}
      onClick={() => onOpen(issueId)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(issueId);
        }
      }}
    >
      <Handle type="target" position={Position.Left} className="!size-1.5 !border-none !bg-transparent" />
      <div className="flex items-center gap-2 text-11">
        <span className="font-semibold" style={{ color: nodeType.color }}>
          {t(nodeType.i18n_label)}
        </span>
        <span className="text-tertiary">
          {identifier}-{issue.sequence_id}
        </span>
        {issue.needs_review && (
          <WarningTriangleOutline
            className="ml-auto size-3.5 text-warning-primary"
            aria-label={t("research.needs_review")}
          />
        )}
      </div>
      <p className="line-clamp-2 text-13 font-medium text-primary">{issue.name}</p>
      <div className="flex items-center gap-2 text-11 text-secondary">
        {status && (
          <span className="flex items-center gap-1">
            <span className="size-2 rounded-full" style={{ backgroundColor: status.color }} />
            {t(status.i18n_label)}
          </span>
        )}
        {state && (
          <span className="flex items-center gap-1">
            <span className="size-2 rounded-full" style={{ backgroundColor: state.color }} />
            {state.name}
          </span>
        )}
        {issue.research_type === "experiment" && (issue.sub_issues_count ?? 0) > 0 && (
          <span className="flex items-center gap-1">
            <SubWorkItemsOutline className="size-3" />
            {issue.sub_issues_count}
          </span>
        )}
        {issue.research_type === "hypothesis" && (support > 0 || inconsistency > 0) && (
          <span className="ml-auto flex items-center gap-1.5 font-medium">
            <span className="text-success-primary">+{support}</span>
            <span className="text-danger-primary">−{inconsistency}</span>
          </span>
        )}
      </div>
      {hasChildren && (
        <button
          type="button"
          className="absolute top-1/2 -right-3 flex h-5 min-w-5 -translate-y-1/2 items-center justify-center gap-0.5 rounded-full border border-subtle bg-surface-1 px-1 text-10 text-secondary hover:bg-layer-1-hover"
          aria-label={collapsed ? t("research.graph.expand") : t("research.graph.collapse")}
          onClick={(e) => {
            e.stopPropagation();
            onToggleCollapse(issueId);
          }}
        >
          {collapsed ? `+${hiddenCount}` : <ChevronRightOutline className="size-3 rotate-180" />}
        </button>
      )}
      <Handle type="source" position={Position.Right} className="!size-1.5 !border-none !bg-transparent" />
    </div>
  );
});

export const ResearchNode = memo(ResearchNodeComponent);
