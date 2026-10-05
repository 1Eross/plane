/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { CloseOutline } from "@makeplane/propel/icons";
// plane imports
import {
  RESEARCH_RELATION_I18N_LABEL,
  RESEARCH_RELATION_WEIGHT_I18N_LABEL,
  RESEARCH_RELATION_WEIGHTS,
  RESEARCH_WEIGHTED_RELATIONS,
} from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import type { TResearchGraphEdge, TResearchRelation, TResearchRelationWeight } from "@plane/types";
import { cn } from "@plane/utils";

type Props = {
  edge: TResearchGraphEdge;
  sourceLabel: string;
  targetLabel: string;
  canEdit: boolean;
  onUpdate: (data: { relation_type?: TResearchRelation; weight?: TResearchRelationWeight }) => void;
  onRemove: () => void;
  onClose: () => void;
};

/** Details of a selected research link: weight and supports / opposes can change in place. */
export function ResearchEdgePanel(props: Props) {
  const { edge, sourceLabel, targetLabel, canEdit, onUpdate, onRemove, onClose } = props;
  const { t } = useTranslation();
  const relation = edge.relation_type as TResearchRelation;
  const isWeighted = RESEARCH_WEIGHTED_RELATIONS.includes(relation);

  return (
    <div className="flex max-w-md flex-col gap-2 rounded-md border border-subtle bg-surface-1 p-3 text-13 shadow-raised-200">
      <div className="flex items-start gap-2">
        <p className="grow text-secondary">
          <span className="font-medium text-primary">{sourceLabel}</span>{" "}
          {t(RESEARCH_RELATION_I18N_LABEL[relation]).toLowerCase()}{" "}
          <span className="font-medium text-primary">{targetLabel}</span>
        </p>
        <button type="button" aria-label={t("close")} className="text-tertiary hover:text-primary" onClick={onClose}>
          <CloseOutline className="size-3.5" />
        </button>
      </div>
      {isWeighted && (
        <div className="flex flex-wrap items-center gap-1.5">
          {(["supports", "opposes"] as const).map((option) => (
            <PanelButton
              key={option}
              active={relation === option}
              disabled={!canEdit}
              onClick={() => onUpdate({ relation_type: option })}
            >
              {t(RESEARCH_RELATION_I18N_LABEL[option])}
            </PanelButton>
          ))}
          <span className="mx-1 h-4 w-px bg-layer-3" />
          {RESEARCH_RELATION_WEIGHTS.map((weight) => (
            <PanelButton
              key={weight}
              active={edge.weight === weight}
              disabled={!canEdit}
              onClick={() => onUpdate({ weight })}
            >
              {t(RESEARCH_RELATION_WEIGHT_I18N_LABEL[weight])}
            </PanelButton>
          ))}
        </div>
      )}
      {canEdit && (
        <button
          type="button"
          className="self-start rounded-sm px-2 py-1 text-12 text-danger-primary hover:bg-danger-subtle"
          onClick={onRemove}
        >
          {t("research.graph.remove_link")}
        </button>
      )}
    </div>
  );
}

function PanelButton(props: { active: boolean; disabled: boolean; onClick: () => void; children: React.ReactNode }) {
  const { active, disabled, onClick, children } = props;
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled || active}
      className={cn(
        "rounded-sm border border-subtle px-2 py-0.5 text-12 text-secondary enabled:hover:bg-layer-1-hover",
        {
          "border-accent-strong bg-accent-subtle text-accent-primary": active,
        }
      )}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
