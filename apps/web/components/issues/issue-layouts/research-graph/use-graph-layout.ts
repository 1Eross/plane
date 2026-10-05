/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { debounce } from "lodash-es";
import useSWR from "swr";
// plane imports
import type { TResearchGraphLayoutNode, TResearchGraphScopeType } from "@plane/types";
// components
import { useResearchErrorToast } from "@/components/issues/research/use-research";
// services
import { ResearchService } from "@/services/issue";

const researchService = new ResearchService();
const SAVE_DELAY_MS = 800;

type TLayoutNodes = Record<string, TResearchGraphLayoutNode>;

/**
 * Shared node positions and collapsed branches of one graph scope.
 * Members save changes (debounced); guests keep them locally for the session.
 */
export const useResearchGraphLayout = (
  workspaceSlug: string | undefined,
  projectId: string | undefined,
  scopeType: TResearchGraphScopeType,
  scopeId: string,
  canEdit: boolean
) => {
  const showError = useResearchErrorToast();
  const [nodes, setNodes] = useState<TLayoutNodes>({});
  const isDirty = useRef(false);

  const { data } = useSWR(
    workspaceSlug && projectId ? ["RESEARCH_GRAPH_LAYOUT", workspaceSlug, projectId, scopeType, scopeId] : null,
    () => researchService.getResearchGraphLayout(workspaceSlug!, projectId!, scopeType, scopeId),
    { revalidateOnFocus: false }
  );

  // adopt the stored layout until the user changes something locally
  useEffect(() => {
    if (data && !isDirty.current) setNodes(data.nodes ?? {});
  }, [data]);

  const save = useMemo(
    () =>
      debounce((next: TLayoutNodes) => {
        if (!workspaceSlug || !projectId) return;
        researchService.saveResearchGraphLayout(workspaceSlug, projectId, scopeType, scopeId, next).catch(showError);
      }, SAVE_DELAY_MS),
    [projectId, scopeId, scopeType, showError, workspaceSlug]
  );

  useEffect(() => {
    if (isDirty.current && canEdit) save(nodes);
  }, [canEdit, nodes, save]);

  // do not lose the last change when leaving the page
  useEffect(() => () => save.flush(), [save]);

  const update = useCallback((updater: (current: TLayoutNodes) => TLayoutNodes) => {
    isDirty.current = true;
    setNodes(updater);
  }, []);

  const collapsedIds = useMemo(
    () => new Set(Object.entries(nodes).flatMap(([id, node]) => (node.collapsed ? [id] : []))),
    [nodes]
  );

  const toggleCollapsed = useCallback(
    (issueId: string) =>
      update((current) => ({
        ...current,
        [issueId]: { ...current[issueId], collapsed: !current[issueId]?.collapsed },
      })),
    [update]
  );

  const setCollapsed = useCallback(
    (issueIds: Iterable<string>) => {
      const collapse = new Set(issueIds);
      update((current) => {
        const next: TLayoutNodes = {};
        for (const id of new Set([...Object.keys(current), ...collapse])) {
          next[id] = { ...current[id], collapsed: collapse.has(id) };
        }
        return next;
      });
    },
    [update]
  );

  const setPosition = useCallback(
    (issueId: string, position: { x: number; y: number }) =>
      update((current) => ({ ...current, [issueId]: { ...current[issueId], x: position.x, y: position.y } })),
    [update]
  );

  const resetPositions = useCallback(
    () =>
      update((current) =>
        Object.fromEntries(Object.entries(current).map(([id, node]) => [id, { collapsed: node.collapsed }]))
      ),
    [update]
  );

  const getSavedPosition = useCallback(
    (issueId: string) => {
      const node = nodes[issueId];
      return node?.x !== undefined && node?.y !== undefined ? { x: node.x, y: node.y } : undefined;
    },
    [nodes]
  );

  return { collapsedIds, toggleCollapsed, setCollapsed, setPosition, resetPositions, getSavedPosition };
};
