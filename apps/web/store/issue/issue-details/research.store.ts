/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { set } from "lodash-es";
import { action, makeObservable, observable, runInAction } from "mobx";
// plane imports
import type {
  TIssueRelationTypes,
  TIssueResearchDetails,
  TIssueResearchDetailsPayload,
  TResearchRelationTypes,
  TResearchRelationWeight,
} from "@plane/types";
import { isResearchRelation } from "@plane/utils";
// services
import { ResearchService } from "@/services/issue";
// types
import type { IIssueDetail } from "./root.store";

export interface IIssueResearchStore {
  // observables
  detailsMap: Record<string, TIssueResearchDetails>;
  // issueId -> related issueId -> weight of the supports / opposes relation between them
  relationWeightMap: Record<string, Record<string, TResearchRelationWeight | null>>;
  // helpers
  getDetails: (issueId: string) => TIssueResearchDetails | undefined;
  getRelationWeight: (issueId: string, relatedIssueId: string) => TResearchRelationWeight | null | undefined;
  // actions
  fetchDetails: (workspaceSlug: string, projectId: string, issueId: string) => Promise<TIssueResearchDetails>;
  updateDetails: (
    workspaceSlug: string,
    projectId: string,
    issueId: string,
    data: TIssueResearchDetailsPayload
  ) => Promise<TIssueResearchDetails>;
  fetchResearchRelations: (workspaceSlug: string, projectId: string, issueId: string) => Promise<void>;
  createResearchRelation: (
    workspaceSlug: string,
    projectId: string,
    issueId: string,
    relationType: TResearchRelationTypes,
    relatedIssueIds: string[],
    weight?: TResearchRelationWeight
  ) => Promise<void>;
  updateResearchRelation: (
    workspaceSlug: string,
    projectId: string,
    issueId: string,
    relatedIssueId: string,
    data: { relation_type?: TResearchRelationTypes; weight?: TResearchRelationWeight }
  ) => Promise<void>;
  removeResearchRelation: (
    workspaceSlug: string,
    projectId: string,
    issueId: string,
    relationType: TResearchRelationTypes,
    relatedIssueId: string
  ) => Promise<void>;
}

export class IssueResearchStore implements IIssueResearchStore {
  // observables
  detailsMap: Record<string, TIssueResearchDetails> = {};
  relationWeightMap: Record<string, Record<string, TResearchRelationWeight | null>> = {};
  // root store
  rootIssueDetailStore: IIssueDetail;
  // services
  researchService;

  constructor(rootStore: IIssueDetail) {
    makeObservable(this, {
      detailsMap: observable,
      relationWeightMap: observable,
      fetchDetails: action,
      updateDetails: action,
      fetchResearchRelations: action,
      createResearchRelation: action,
      updateResearchRelation: action,
      removeResearchRelation: action,
    });
    this.rootIssueDetailStore = rootStore;
    this.researchService = new ResearchService();
  }

  // helpers
  getDetails = (issueId: string) => this.detailsMap[issueId];

  getRelationWeight = (issueId: string, relatedIssueId: string) => this.relationWeightMap[issueId]?.[relatedIssueId];

  // The server recomputes research_status / needs_review after relation and status changes
  private syncIssueResearchFields = (details: TIssueResearchDetails) => {
    this.rootIssueDetailStore.rootIssueStore.issues.updateIssue(details.issue_id, {
      research_type: details.research_type,
      research_status: details.research_status,
      needs_review: details.needs_review,
    });
  };

  // actions
  fetchDetails = async (workspaceSlug: string, projectId: string, issueId: string) => {
    const details = await this.researchService.getResearchDetails(workspaceSlug, projectId, issueId);
    runInAction(() => {
      set(this.detailsMap, [issueId], details);
      this.syncIssueResearchFields(details);
    });
    return details;
  };

  updateDetails = async (
    workspaceSlug: string,
    projectId: string,
    issueId: string,
    data: TIssueResearchDetailsPayload
  ) => {
    const previous = this.detailsMap[issueId];
    runInAction(() => {
      if (previous) set(this.detailsMap, [issueId], { ...previous, ...data });
    });
    try {
      const details = await this.researchService.updateResearchDetails(workspaceSlug, projectId, issueId, data);
      runInAction(() => set(this.detailsMap, [issueId], details));
      return details;
    } catch (error) {
      runInAction(() => {
        if (previous) set(this.detailsMap, [issueId], previous);
      });
      throw error;
    }
  };

  fetchResearchRelations = async (workspaceSlug: string, projectId: string, issueId: string) => {
    const response = await this.rootIssueDetailStore.relation.fetchRelations(workspaceSlug, projectId, issueId);
    runInAction(() => {
      const weights: Record<string, TResearchRelationWeight | null> = {};
      (Object.keys(response) as TIssueRelationTypes[]).forEach((relationType) => {
        if (!isResearchRelation(relationType)) return;
        for (const relatedIssue of response[relationType] ?? []) {
          const weight = (relatedIssue as unknown as { weight?: TResearchRelationWeight | null }).weight;
          weights[relatedIssue.id] = weight ?? null;
        }
      });
      set(this.relationWeightMap, [issueId], weights);
    });
  };

  // refresh both ends: verdict basis and question status may have changed on the server
  private refreshAfterRelationChange = async (
    workspaceSlug: string,
    projectId: string,
    issueId: string,
    relatedIssueIds: string[]
  ) => {
    await Promise.all([
      this.fetchResearchRelations(workspaceSlug, projectId, issueId),
      this.fetchDetails(workspaceSlug, projectId, issueId),
      ...relatedIssueIds.map((relatedIssueId) => {
        const relatedProjectId = this.rootIssueDetailStore.issue.getIssueById(relatedIssueId)?.project_id;
        return relatedProjectId
          ? this.fetchDetails(workspaceSlug, relatedProjectId, relatedIssueId).catch(() => undefined)
          : undefined;
      }),
    ]);
    this.rootIssueDetailStore.activity.fetchActivities(workspaceSlug, projectId, issueId);
  };

  createResearchRelation = async (
    workspaceSlug: string,
    projectId: string,
    issueId: string,
    relationType: TResearchRelationTypes,
    relatedIssueIds: string[],
    weight?: TResearchRelationWeight
  ) => {
    await this.researchService.createResearchRelation(workspaceSlug, projectId, issueId, {
      relation_type: relationType,
      issues: relatedIssueIds,
      ...(weight ? { weight } : {}),
    });
    await this.refreshAfterRelationChange(workspaceSlug, projectId, issueId, relatedIssueIds);
  };

  updateResearchRelation = async (
    workspaceSlug: string,
    projectId: string,
    issueId: string,
    relatedIssueId: string,
    data: { relation_type?: TResearchRelationTypes; weight?: TResearchRelationWeight }
  ) => {
    await this.researchService.updateResearchRelation(workspaceSlug, projectId, issueId, relatedIssueId, data);
    await this.refreshAfterRelationChange(workspaceSlug, projectId, issueId, [relatedIssueId]);
  };

  removeResearchRelation = async (
    workspaceSlug: string,
    projectId: string,
    issueId: string,
    relationType: TResearchRelationTypes,
    relatedIssueId: string
  ) => {
    await this.rootIssueDetailStore.relation.removeRelation(
      workspaceSlug,
      projectId,
      issueId,
      relationType,
      relatedIssueId
    );
    await this.refreshAfterRelationChange(workspaceSlug, projectId, issueId, [relatedIssueId]);
  };
}
