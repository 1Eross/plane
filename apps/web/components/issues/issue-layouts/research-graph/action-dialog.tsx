/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useState } from "react";
import { Button } from "@makeplane/propel/components/button";
import {
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogHeading,
  DialogMain,
  DialogTitle,
} from "@makeplane/propel/components/dialog";
import { Input, InputGroup } from "@makeplane/propel/components/input";
// plane imports
import {
  RESEARCH_RELATION_I18N_LABEL,
  RESEARCH_RELATION_WEIGHT_I18N_LABEL,
  RESEARCH_RELATION_WEIGHTS,
} from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import type { TResearchRelationTypes, TResearchRelationWeight } from "@plane/types";
import { cn } from "@plane/utils";

export type TRelationChoice = {
  // relation name seen from the node the action starts at
  name: TResearchRelationTypes;
  weighted: boolean;
};

export type TActionDialogResult = {
  name: string;
  relation?: TRelationChoice;
  weight?: TResearchRelationWeight;
};

type Props = {
  title: string;
  submitLabel: string;
  // ask for the name of a new node
  withName: boolean;
  relationChoices?: TRelationChoice[];
  onSubmit: (result: TActionDialogResult) => Promise<void>;
  onClose: () => void;
};

const DEFAULT_WEIGHT: TResearchRelationWeight = 2;

/** Small dialog for map actions: name a new node and / or pick a relation and its weight. */
export function ResearchActionDialog(props: Props) {
  const { title, submitLabel, withName, relationChoices = [], onSubmit, onClose } = props;
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [relation, setRelation] = useState<TRelationChoice | undefined>(relationChoices[0]);
  const [weight, setWeight] = useState<TResearchRelationWeight>(DEFAULT_WEIGHT);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const canSubmit = (!withName || name.trim().length > 0) && (relationChoices.length === 0 || !!relation);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit || isSubmitting) return;
    setIsSubmitting(true);
    try {
      await onSubmit({ name: name.trim(), relation, weight: relation?.weighted ? weight : undefined });
      onClose();
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent size="sm">
        <form onSubmit={(e) => void handleSubmit(e)} className="flex min-h-0 flex-1 flex-col">
          <DialogMain>
            <DialogHeader>
              <DialogHeading>
                <DialogTitle>{title}</DialogTitle>
              </DialogHeading>
            </DialogHeader>
            <DialogBody tabIndex={0}>
              <div className="flex flex-col gap-4">
                {withName && (
                  <label className="flex flex-col gap-1.5">
                    <span className="text-13 font-medium text-secondary">{t("research.graph.name")}</span>
                    <InputGroup size="md">
                      <Input
                        size="md"
                        type="text"
                        value={name}
                        placeholder={t("research.graph.name_placeholder")}
                        onChange={(e) => setName(e.target.value)}
                      />
                    </InputGroup>
                  </label>
                )}
                {relationChoices.length > 1 && (
                  <fieldset className="flex flex-col gap-1.5">
                    <legend className="mb-1.5 text-13 font-medium text-secondary">
                      {t("research.graph.relation")}
                    </legend>
                    <div className="flex flex-wrap gap-1.5">
                      {relationChoices.map((choice) => (
                        <ChoiceButton
                          key={choice.name}
                          active={relation?.name === choice.name}
                          onClick={() => setRelation(choice)}
                        >
                          {t(RESEARCH_RELATION_I18N_LABEL[choice.name])}
                        </ChoiceButton>
                      ))}
                    </div>
                  </fieldset>
                )}
                {relation?.weighted && (
                  <fieldset className="flex flex-col gap-1.5">
                    <legend className="mb-1.5 text-13 font-medium text-secondary">{t("research.links.weight")}</legend>
                    <div className="flex flex-wrap gap-1.5">
                      {RESEARCH_RELATION_WEIGHTS.map((value) => (
                        <ChoiceButton key={value} active={weight === value} onClick={() => setWeight(value)}>
                          {t(RESEARCH_RELATION_WEIGHT_I18N_LABEL[value])}
                        </ChoiceButton>
                      ))}
                    </div>
                  </fieldset>
                )}
              </div>
            </DialogBody>
          </DialogMain>
          <DialogActions>
            <Button variant="secondary" size="md" stretch="auto" onClick={onClose} label={t("cancel")} />
            <Button
              variant="primary"
              size="md"
              stretch="auto"
              type="submit"
              disabled={!canSubmit}
              loading={isSubmitting}
              label={submitLabel}
            />
          </DialogActions>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ChoiceButton(props: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  const { active, onClick, children } = props;
  return (
    <button
      type="button"
      aria-pressed={active}
      className={cn("rounded-md border border-subtle px-2.5 py-1 text-13 text-secondary hover:bg-layer-1-hover", {
        "border-accent-strong bg-accent-subtle text-accent-primary": active,
      })}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
