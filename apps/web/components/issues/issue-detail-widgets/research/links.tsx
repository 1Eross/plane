/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useState } from "react";
import { observer } from "mobx-react";
import { AddOutline, CloseOutline } from "@makeplane/propel/icons";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@makeplane/propel/components/menu";
// plane imports
import {
  RESEARCH_NODE_TYPE_MAP,
  RESEARCH_NODE_TYPES,
  RESEARCH_RELATION_GRAMMAR,
  RESEARCH_RELATION_I18N_LABEL,
  RESEARCH_RELATION_WEIGHT_I18N_LABEL,
  RESEARCH_RELATION_WEIGHTS,
  RESEARCH_RELATIONS,
  RESEARCH_REVERSE_RELATION,
  RESEARCH_STATUS_MAP,
  RESEARCH_WEIGHTED_RELATIONS,
} from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import type {
  ISearchIssueResponse,
  TIssueServiceType,
  TResearchNodeType,
  TResearchRelationTypes,
  TResearchRelationWeight,
} from "@plane/types";
import { toForwardResearchRelation } from "@plane/utils";
// components
import { ExistingIssuesListModal } from "@/components/core/modals/existing-issues-list-modal";
import { handleTriggerClick, handleTriggerKeyDown } from "@/components/common/trigger-guard";
import { ColorDot, ResearchSelect } from "@/components/issues/research/research-select";
import { useResearchErrorToast } from "@/components/issues/research/use-research";
// hooks
import { useIssueDetail } from "@/hooks/store/use-issue-detail";
import { useProject } from "@/hooks/store/use-project";

const DEFAULT_WEIGHT: TResearchRelationWeight = 2;

/** Relation names the grammar allows from a node of each type, seen from the node itself. Computed once. */
const RELATION_NAMES_BY_TYPE = {} as Record<TResearchNodeType, TResearchRelationTypes[]>;
for (const type of RESEARCH_NODE_TYPES) {
  const names: TResearchRelationTypes[] = [];
  for (const relation of RESEARCH_RELATIONS) {
    const { sources, targets } = RESEARCH_RELATION_GRAMMAR[relation];
    if (sources.includes(type)) names.push(relation);
    if (targets.includes(type)) names.push(RESEARCH_REVERSE_RELATION[relation]);
  }
  RELATION_NAMES_BY_TYPE[type] = names;
}

type Props = {
  workspaceSlug: string;
  projectId: string;
  issueId: string;
  disabled: boolean;
  issueServiceType: TIssueServiceType;
};

export const ResearchLinks = observer(function ResearchLinks(props: Props) {
  const { workspaceSlug, projectId, issueId, disabled, issueServiceType } = props;
  const { t } = useTranslation();
  const [pendingRelation, setPendingRelation] = useState<TResearchRelationTypes | null>(null);
  // store hooks
  const {
    issue: { getIssueById },
    relation: { getRelationsByIssueId },
    research: { getRelationWeight, createResearchRelation, updateResearchRelation, removeResearchRelation },
    setPeekIssue,
  } = useIssueDetail(issueServiceType);
  const { getProjectById } = useProject();
  const showError = useResearchErrorToast();
  // derived values
  const issue = getIssueById(issueId);
  const researchType = issue?.research_type;
  const relationNames = researchType ? RELATION_NAMES_BY_TYPE[researchType] : [];
  const relations = getRelationsByIssueId(issueId);
  const groups = relationNames.flatMap((name) => {
    const issueIds = relations?.[name] ?? [];
    return issueIds.length > 0 ? [{ name, issueIds }] : [];
  });

  if (!researchType) return null;

  const run = async (action: () => Promise<void>) => {
    try {
      await action();
    } catch (error) {
      showError(error);
    }
  };

  const handleSubmit = async (selected: ISearchIssueResponse[]) => {
    if (!pendingRelation || selected.length === 0) return;
    const isWeighted = RESEARCH_WEIGHTED_RELATIONS.includes(toForwardResearchRelation(pendingRelation).relation);
    await run(() =>
      createResearchRelation(
        workspaceSlug,
        projectId,
        issueId,
        pendingRelation,
        selected.map((item) => item.id),
        isWeighted ? DEFAULT_WEIGHT : undefined
      )
    );
    setPendingRelation(null);
  };

  const weightOptions = RESEARCH_RELATION_WEIGHTS.map((weight) => ({
    key: String(weight),
    label: t(RESEARCH_RELATION_WEIGHT_I18N_LABEL[weight]),
  }));

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-13 font-medium text-secondary">{t("research.links.title")}</span>
        {!disabled && (
          <Menu>
            <MenuTrigger
              aria-label={t("research.links.add")}
              onClick={handleTriggerClick}
              onKeyDown={handleTriggerKeyDown}
              render={
                <button
                  type="button"
                  className="flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-12 text-tertiary hover:bg-layer-1-hover"
                >
                  <AddOutline className="size-3.5" />
                  {t("research.links.add")}
                </button>
              }
            />
            <MenuContent side="bottom" align="end">
              {relationNames.map((name) => (
                <MenuItem
                  key={name}
                  label={t(RESEARCH_RELATION_I18N_LABEL[name])}
                  onClick={(e) => {
                    e.stopPropagation();
                    setPendingRelation(name);
                  }}
                />
              ))}
            </MenuContent>
          </Menu>
        )}
      </div>

      {groups.length === 0 && <p className="text-12 text-tertiary">{t("research.links.empty")}</p>}

      {groups.map(({ name, issueIds }) => {
        const isWeighted = RESEARCH_WEIGHTED_RELATIONS.includes(toForwardResearchRelation(name).relation);
        return (
          <div key={name} className="flex flex-col gap-1">
            <span className="text-12 text-tertiary">{t(RESEARCH_RELATION_I18N_LABEL[name])}</span>
            {issueIds.map((relatedIssueId) => {
              const relatedIssue = getIssueById(relatedIssueId);
              if (!relatedIssue) return null;
              const identifier = getProjectById(relatedIssue.project_id)?.identifier;
              const status = relatedIssue.research_status ? RESEARCH_STATUS_MAP[relatedIssue.research_status] : null;
              const nodeType = relatedIssue.research_type ? RESEARCH_NODE_TYPE_MAP[relatedIssue.research_type] : null;
              const weight = getRelationWeight(issueId, relatedIssueId) ?? DEFAULT_WEIGHT;
              return (
                <div
                  key={relatedIssueId}
                  className="group flex items-center gap-2 rounded-md px-2 py-1 hover:bg-layer-1-hover"
                >
                  {nodeType && (
                    <span className="text-11 font-semibold" style={{ color: nodeType.color }}>
                      {nodeType.short_label}
                    </span>
                  )}
                  <button
                    type="button"
                    className="min-w-0 grow truncate text-left text-13 text-primary"
                    onClick={() =>
                      relatedIssue.project_id &&
                      setPeekIssue({ workspaceSlug, projectId: relatedIssue.project_id, issueId: relatedIssueId })
                    }
                  >
                    <span className="text-tertiary">
                      {identifier}-{relatedIssue.sequence_id}
                    </span>{" "}
                    {relatedIssue.name}
                  </button>
                  {status && (
                    <span className="flex flex-shrink-0 items-center gap-1 text-12 text-secondary">
                      <ColorDot color={status.color} />
                      {t(status.i18n_label)}
                    </span>
                  )}
                  {isWeighted && (
                    <div className="w-28 flex-shrink-0">
                      <ResearchSelect
                        options={weightOptions}
                        value={String(weight)}
                        placeholder={t("research.links.weight")}
                        disabled={disabled}
                        variant="select-ghost-md"
                        onChange={(key) =>
                          void run(() =>
                            updateResearchRelation(workspaceSlug, projectId, issueId, relatedIssueId, {
                              weight: Number(key) as TResearchRelationWeight,
                            })
                          )
                        }
                      />
                    </div>
                  )}
                  {!disabled && (
                    <button
                      type="button"
                      aria-label={t("common.remove")}
                      className="flex-shrink-0 text-tertiary opacity-0 group-hover:opacity-100 hover:text-primary"
                      onClick={() =>
                        void run(() => removeResearchRelation(workspaceSlug, projectId, issueId, name, relatedIssueId))
                      }
                    >
                      <CloseOutline className="size-3.5" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}

      <ExistingIssuesListModal
        workspaceSlug={workspaceSlug}
        projectId={projectId}
        isOpen={!!pendingRelation}
        handleClose={() => setPendingRelation(null)}
        searchParams={{ issue_relation: true, issue_id: issueId }}
        handleOnSubmit={handleSubmit}
      />
    </div>
  );
});
