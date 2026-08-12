// SPDX-License-Identifier: MIT

export interface Outcome {
	status?: string;
	score?: number;
	note?: string;
}

/** Base graph record shape shared with local EvoMap consumers. */
export interface OutcomeEntry {
	timestamp?: string;
	gene_id?: string;
	signals?: string[];
	outcome?: Outcome;
	cwd?: string;
	workspace_id?: string | null;
	session_id?: string | null;
	diff_hash?: string;
	diff_scope?: string;
	source?: string;
	[key: string]: unknown;
}
