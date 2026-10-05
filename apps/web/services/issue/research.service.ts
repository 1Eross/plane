/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { API_BASE_URL } from "@plane/constants";
import type {
  TIssue,
  TIssueResearchDetails,
  TIssueResearchDetailsPayload,
  TResearchGraph,
  TResearchGraphLayout,
  TResearchGraphLayoutNode,
  TResearchGraphScopeType,
  TResearchMatrix,
  TResearchMergePayload,
  TResearchMergeResponse,
  TResearchRelationTypes,
  TResearchRelationWeight,
} from "@plane/types";
// services
import { APIService } from "@/services/api.service";

export class ResearchService extends APIService {
  constructor() {
    super(API_BASE_URL);
  }

  private projectUrl(workspaceSlug: string, projectId: string) {
    return `/api/workspaces/${workspaceSlug}/projects/${projectId}`;
  }

  async getResearchDetails(workspaceSlug: string, projectId: string, issueId: string): Promise<TIssueResearchDetails> {
    return this.get(`${this.projectUrl(workspaceSlug, projectId)}/issues/${issueId}/research/`)
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  async updateResearchDetails(
    workspaceSlug: string,
    projectId: string,
    issueId: string,
    data: TIssueResearchDetailsPayload
  ): Promise<TIssueResearchDetails> {
    return this.patch(`${this.projectUrl(workspaceSlug, projectId)}/issues/${issueId}/research/`, data)
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  /** Research relations go through the regular relation endpoint, which enforces the research grammar. */
  async createResearchRelation(
    workspaceSlug: string,
    projectId: string,
    issueId: string,
    data: { relation_type: TResearchRelationTypes; issues: string[]; weight?: TResearchRelationWeight }
  ): Promise<TIssue[]> {
    return this.post(`${this.projectUrl(workspaceSlug, projectId)}/issues/${issueId}/issue-relation/`, data)
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  /** Change the weight of a supports / opposes relation or switch between the two. */
  async updateResearchRelation(
    workspaceSlug: string,
    projectId: string,
    issueId: string,
    relatedIssueId: string,
    data: { relation_type?: TResearchRelationTypes; weight?: TResearchRelationWeight }
  ): Promise<TIssue> {
    return this.patch(
      `${this.projectUrl(workspaceSlug, projectId)}/issues/${issueId}/issue-relation/${relatedIssueId}/`,
      data
    )
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  async removeResearchRelation(
    workspaceSlug: string,
    projectId: string,
    issueId: string,
    data: { related_issue: string; relation_type?: TResearchRelationTypes }
  ): Promise<void> {
    return this.post(`${this.projectUrl(workspaceSlug, projectId)}/issues/${issueId}/remove-relation/`, data)
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  async mergeHypotheses(
    workspaceSlug: string,
    projectId: string,
    data: TResearchMergePayload
  ): Promise<TResearchMergeResponse> {
    return this.post(`${this.projectUrl(workspaceSlug, projectId)}/research/merge/`, data)
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  /** queries carry the same filters as the issue list (rich `filters` and legacy params). */
  async getResearchGraph(
    workspaceSlug: string,
    projectId: string,
    scope: { scope_type: TResearchGraphScopeType; scope_id: string },
    queries: Record<string, string> = {}
  ): Promise<TResearchGraph> {
    return this.get(`${this.projectUrl(workspaceSlug, projectId)}/research-graph/`, {
      params: { ...queries, ...scope },
    })
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  async getResearchGraphLayout(
    workspaceSlug: string,
    projectId: string,
    scopeType: TResearchGraphScopeType,
    scopeId: string
  ): Promise<TResearchGraphLayout> {
    return this.get(`${this.projectUrl(workspaceSlug, projectId)}/research-graph/layouts/${scopeType}/${scopeId}/`)
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  async saveResearchGraphLayout(
    workspaceSlug: string,
    projectId: string,
    scopeType: TResearchGraphScopeType,
    scopeId: string,
    nodes: Record<string, TResearchGraphLayoutNode>
  ): Promise<TResearchGraphLayout> {
    return this.put(`${this.projectUrl(workspaceSlug, projectId)}/research-graph/layouts/${scopeType}/${scopeId}/`, {
      nodes,
    })
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  async getResearchMatrix(workspaceSlug: string, projectId: string, questionId: string): Promise<TResearchMatrix> {
    return this.get(`${this.projectUrl(workspaceSlug, projectId)}/issues/${questionId}/research-matrix/`)
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }
}
