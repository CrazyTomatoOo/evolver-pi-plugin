// SPDX-License-Identifier: MIT

import type { RecallContext } from "./core-coordinator";
import { gatherWorkspaceEntries } from "./memory";
import { findMemoryGraph, isGitWorkspace, resolveWorkspaceId } from "./paths";

/** Load workspace-scoped Recall inputs. Domain selection and formatting belong to
 * the Core Coordinator. Never throws. */
export function loadRecall(projectDir: string): RecallContext {
	try {
		if (!isGitWorkspace(projectDir)) {
			return { eligible: false, workspaceId: null, entries: [] };
		}
		const workspaceId = resolveWorkspaceId(projectDir);
		if (!workspaceId) {
			return { eligible: false, workspaceId: null, entries: [] };
		}
		return {
			eligible: true,
			workspaceId,
			entries: gatherWorkspaceEntries(
				findMemoryGraph(projectDir),
				workspaceId,
				projectDir,
			),
		};
	} catch {
		return { eligible: false, workspaceId: null, entries: [] };
	}
}
