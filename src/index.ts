import * as fs from "node:fs";
import * as core from "@actions/core";
import * as exec from "@actions/exec";

const POLL_INTERVAL_MS = 2000;
const TIMEOUT_MS = 5 * 60 * 1000;

const MAINA_COMMENT_MARKER = "<!-- maina:run -->";
const MAINA_CHECK_RUN_NAME = "maina/verification";
const REPORT_BASE_URL = "https://mainahq.com";
const GITHUB_API = "https://api.github.com";
const CHECK_RUN_MAX_ANNOTATIONS = 50;

interface VerifySubmitResponse {
	data: { job_id: string } | null;
	error: string | null;
}

interface VerifyStatusResponse {
	data: { id: string; status: string; step: string } | null;
	error: string | null;
}

interface Finding {
	severity: string;
	message: string;
	file?: string;
	line?: number;
}

interface VerifyResultResponse {
	data: {
		id: string;
		status: string;
		passed: boolean;
		findings: {
			errors: number;
			warnings: number;
			items: Finding[];
		};
		proof_url: string;
		duration_ms: number;
	} | null;
	error: string | null;
}

interface PRContext {
	prNumber: number;
	headSha: string;
}

async function getDiff(base: string): Promise<string> {
	let diff = "";
	const options: exec.ExecOptions = {
		listeners: {
			stdout: (data: Buffer) => {
				diff += data.toString();
			},
		},
		silent: true,
	};

	const exitCode = await exec.exec("git", ["diff", `${base}...HEAD`], options);
	if (exitCode !== 0) {
		throw new Error(`git diff failed with exit code ${exitCode}`);
	}

	return diff;
}

async function submitVerification(
	cloudUrl: string,
	token: string,
	diff: string,
	repo: string,
	baseBranch: string,
): Promise<string> {
	const response = await fetch(`${cloudUrl}/verify`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${token}`,
		},
		body: JSON.stringify({ diff, repo, base_branch: baseBranch }),
	});

	if (!response.ok) {
		throw new Error(`Failed to submit verification: ${response.status} ${response.statusText}`);
	}

	const body = (await response.json()) as VerifySubmitResponse;
	if (body.error) {
		throw new Error(`Verification submission error: ${body.error}`);
	}
	if (!body.data?.job_id) {
		throw new Error("No job_id returned from verification submission");
	}

	return body.data.job_id;
}

async function pollStatus(cloudUrl: string, token: string, jobId: string): Promise<void> {
	const deadline = Date.now() + TIMEOUT_MS;

	while (Date.now() < deadline) {
		const response = await fetch(`${cloudUrl}/verify/${jobId}/status`, {
			headers: { Authorization: `Bearer ${token}` },
		});

		if (!response.ok) {
			throw new Error(`Failed to poll status: ${response.status} ${response.statusText}`);
		}

		const body = (await response.json()) as VerifyStatusResponse;
		if (body.error) {
			throw new Error(`Status poll error: ${body.error}`);
		}

		const status = body.data?.status;
		core.info(`Verification status: ${status} (step: ${body.data?.step})`);

		if (status === "done" || status === "failed") {
			return;
		}

		await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
	}

	throw new Error(`Verification timed out after ${TIMEOUT_MS / 1000} seconds`);
}

async function fetchResult(
	cloudUrl: string,
	token: string,
	jobId: string,
): Promise<NonNullable<VerifyResultResponse["data"]>> {
	const response = await fetch(`${cloudUrl}/verify/${jobId}`, {
		headers: { Authorization: `Bearer ${token}` },
	});

	if (!response.ok) {
		throw new Error(`Failed to fetch result: ${response.status} ${response.statusText}`);
	}

	const body = (await response.json()) as VerifyResultResponse;
	if (body.error) {
		throw new Error(`Result fetch error: ${body.error}`);
	}
	if (!body.data) {
		throw new Error("No data returned from verification result");
	}

	return body.data;
}

/**
 * Load PR context from the GitHub Actions event payload.
 * Returns `null` when the workflow wasn't triggered by a pull_request event —
 * in that case we skip posting (no PR to post to).
 */
function loadPRContext(): PRContext | null {
	const eventPath = process.env.GITHUB_EVENT_PATH;
	if (!eventPath) return null;
	try {
		const raw = fs.readFileSync(eventPath, "utf8");
		const event = JSON.parse(raw) as {
			pull_request?: { number: number; head: { sha: string } };
			number?: number;
		};
		const pr = event.pull_request;
		if (!pr) return null;
		return { prNumber: pr.number, headSha: pr.head.sha };
	} catch (err) {
		core.warning(
			`Could not parse GITHUB_EVENT_PATH: ${err instanceof Error ? err.message : String(err)}`,
		);
		return null;
	}
}

function githubHeaders(token: string, accept?: string): Record<string, string> {
	return {
		Authorization: `token ${token}`,
		Accept: accept ?? "application/vnd.github+json",
		"User-Agent": "maina-verify-action",
	};
}

function formatStickyBody(
	result: NonNullable<VerifyResultResponse["data"]>,
	jobId: string,
): string {
	const header = result.passed
		? "## Maina Verification \u2713 Passed"
		: "## Maina Verification \u2717 Failed";

	const { errors, warnings, items } = result.findings;
	const countParts: string[] = [];
	if (errors > 0) countParts.push(`${errors} error${errors > 1 ? "s" : ""}`);
	if (warnings > 0) countParts.push(`${warnings} warning${warnings > 1 ? "s" : ""}`);
	const countSuffix = countParts.length > 0 ? ` (${countParts.join(", ")})` : "";
	const findingsSummary = `**${items.length} findings**${countSuffix}`;

	const MAX_ROWS = 50;
	const shownFindings = items.slice(0, MAX_ROWS);
	const hiddenCount = items.length - shownFindings.length;

	let table = "";
	if (shownFindings.length > 0) {
		const rows = shownFindings.map((f) => {
			const file = f.file ?? "-";
			const line = f.line !== undefined ? String(f.line) : "-";
			return `| ${f.severity} | ${file} | ${line} | ${f.message} |`;
		});
		if (hiddenCount > 0) {
			rows.push(`| … | … | … | _${hiddenCount} more, see full report_ |`);
		}
		table = [
			"",
			"| Severity | File | Line | Message |",
			"|----------|------|------|---------|",
			...rows,
			"",
		].join("\n");
	}

	const reportUrl = `${REPORT_BASE_URL}/r/${jobId}`;
	const jsonUrl = `${REPORT_BASE_URL}/r/${jobId}.json`;
	const links = `\n**[Full report](${reportUrl})** · [JSON](${jsonUrl})\n`;
	const durationLine = `\n<sub>Duration: ${(result.duration_ms / 1000).toFixed(1)}s · run \`${jobId}\`</sub>\n`;

	return [MAINA_COMMENT_MARKER, "", header, "", findingsSummary + table, links, durationLine].join(
		"\n",
	);
}

async function findStickyComment(
	githubToken: string,
	repo: string,
	prNumber: number,
): Promise<{ id: number } | null> {
	let url: string | null = `${GITHUB_API}/repos/${repo}/issues/${prNumber}/comments?per_page=100`;
	for (let page = 0; page < 10 && url; page++) {
		const res: Response = await fetch(url, {
			headers: githubHeaders(githubToken),
		});
		if (!res.ok) {
			throw new Error(`GitHub API error (${res.status}): failed to list PR comments`);
		}
		const body = (await res.json()) as Array<{ id: number; body?: string }>;
		for (const c of body) {
			if ((c.body ?? "").trimStart().startsWith(MAINA_COMMENT_MARKER)) {
				return { id: c.id };
			}
		}
		const link = res.headers.get("Link") ?? "";
		const match = link.split(",").find((p) => /rel="next"/.test(p));
		url = match?.match(/<([^>]+)>/)?.[1] ?? null;
	}
	return null;
}

async function upsertStickyComment(
	githubToken: string,
	repo: string,
	prNumber: number,
	body: string,
): Promise<void> {
	const existing = await findStickyComment(githubToken, repo, prNumber);
	if (existing) {
		const res = await fetch(`${GITHUB_API}/repos/${repo}/issues/comments/${existing.id}`, {
			method: "PATCH",
			headers: {
				...githubHeaders(githubToken),
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ body }),
		});
		if (!res.ok) {
			throw new Error(`GitHub API error (${res.status}): failed to update sticky comment`);
		}
		core.info(`Sticky comment updated: ${existing.id}`);
		return;
	}
	const res = await fetch(`${GITHUB_API}/repos/${repo}/issues/${prNumber}/comments`, {
		method: "POST",
		headers: {
			...githubHeaders(githubToken),
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ body }),
	});
	if (!res.ok) {
		throw new Error(`GitHub API error (${res.status}): failed to create sticky comment`);
	}
	const created = (await res.json()) as { id: number };
	core.info(`Sticky comment created: ${created.id}`);
}

interface CheckRunAnnotation {
	path: string;
	start_line: number;
	end_line: number;
	annotation_level: "notice" | "warning" | "failure";
	message: string;
}

function findingToAnnotation(finding: Finding): CheckRunAnnotation | null {
	if (!finding.file || typeof finding.line !== "number") return null;
	const level: CheckRunAnnotation["annotation_level"] =
		finding.severity === "error"
			? "failure"
			: finding.severity === "warning"
				? "warning"
				: "notice";
	return {
		path: finding.file,
		start_line: finding.line,
		end_line: finding.line,
		annotation_level: level,
		message: finding.message,
	};
}

async function postCheckRun(
	githubToken: string,
	repo: string,
	headSha: string,
	jobId: string,
	result: NonNullable<VerifyResultResponse["data"]>,
): Promise<void> {
	const { items, errors, warnings } = result.findings;
	const passedCount = items.length - errors;
	const total = items.length;

	const parts: string[] = [`${passedCount}/${total} passed`];
	if (warnings > 0) parts.push(`${warnings} warning${warnings === 1 ? "" : "s"}`);
	if (errors > 0) parts.push(`${errors} error${errors === 1 ? "" : "s"}`);
	let summaryLine = parts.join(" · ");

	const annotations: CheckRunAnnotation[] = [];
	for (const f of items) {
		if (annotations.length >= CHECK_RUN_MAX_ANNOTATIONS) break;
		const a = findingToAnnotation(f);
		if (a) annotations.push(a);
	}
	const over = items.length - annotations.length;
	if (over > 0) summaryLine += ` · ${over} more (see full report)`;

	const reportUrl = `${REPORT_BASE_URL}/r/${jobId}`;
	const jsonUrl = `${REPORT_BASE_URL}/r/${jobId}.json`;

	const payload = {
		name: MAINA_CHECK_RUN_NAME,
		head_sha: headSha,
		status: "completed",
		conclusion: result.passed ? "success" : "failure",
		details_url: reportUrl,
		completed_at: new Date().toISOString(),
		output: {
			title: result.passed ? "Passed" : "Failed",
			summary: summaryLine,
			text:
				`**[Full report](${reportUrl})** · [JSON](${jsonUrl})\n\n` + `<sub>run \`${jobId}\`</sub>`,
			annotations,
		},
	};

	const res = await fetch(`${GITHUB_API}/repos/${repo}/check-runs`, {
		method: "POST",
		headers: {
			...githubHeaders(githubToken),
			"Content-Type": "application/json",
		},
		body: JSON.stringify(payload),
	});
	if (!res.ok) {
		throw new Error(`GitHub API error (${res.status}): failed to create Check Run`);
	}
	const created = (await res.json()) as { id: number };
	core.info(`Check Run posted: ${created.id}`);
}

async function postToPR(
	githubToken: string,
	repo: string,
	pr: PRContext,
	jobId: string,
	result: NonNullable<VerifyResultResponse["data"]>,
): Promise<void> {
	// Each post is best-effort: one failure (e.g. a missing permission) must
	// not prevent the other from succeeding.
	try {
		await upsertStickyComment(githubToken, repo, pr.prNumber, formatStickyBody(result, jobId));
	} catch (err) {
		core.warning(`Sticky comment failed: ${err instanceof Error ? err.message : String(err)}`);
	}
	try {
		await postCheckRun(githubToken, repo, pr.headSha, jobId, result);
	} catch (err) {
		core.warning(`Check Run post failed: ${err instanceof Error ? err.message : String(err)}`);
	}
}

async function run(): Promise<void> {
	const token = core.getInput("token", { required: true });
	const base = core.getInput("base") || "main";
	const cloudUrl = (core.getInput("cloud_url") || "https://api.maina.dev").replace(/\/+$/, "");
	// `github_token` is optional: when unset we skip posting. Callers who
	// want sticky comment + Check Run pass `${{ secrets.GITHUB_TOKEN }}`
	// and set `permissions: { pull-requests: write, checks: write }`.
	const githubToken = core.getInput("github_token");

	const repo = process.env.GITHUB_REPOSITORY;
	if (!repo) {
		core.setFailed(
			"GITHUB_REPOSITORY is not set. This action must run in a GitHub Actions environment.",
		);
		return;
	}

	core.info(`Verifying ${repo} against base branch '${base}'`);

	core.info("Getting diff...");
	const diff = await getDiff(base);
	if (!diff.trim()) {
		core.info("No diff found. Skipping verification.");
		core.setOutput("passed", "true");
		core.setOutput("findings_count", "0");
		core.setOutput("proof_url", "");
		return;
	}
	core.info(`Diff size: ${diff.length} characters`);

	core.info("Submitting verification...");
	const jobId = await submitVerification(cloudUrl, token, diff, repo, base);
	core.info(`Verification job started: ${jobId}`);

	core.info("Waiting for verification to complete...");
	await pollStatus(cloudUrl, token, jobId);

	core.info("Fetching results...");
	const result = await fetchResult(cloudUrl, token, jobId);

	const reportUrl = `${REPORT_BASE_URL}/r/${jobId}`;
	core.setOutput("passed", String(result.passed));
	core.setOutput("findings_count", String(result.findings.errors + result.findings.warnings));
	core.setOutput("proof_url", result.proof_url);
	core.setOutput("report_url", reportUrl);
	core.setOutput("run_id", jobId);

	core.info("--- Verification Results ---");
	core.info(`Status: ${result.passed ? "PASSED" : "FAILED"}`);
	core.info(`Errors: ${result.findings.errors}`);
	core.info(`Warnings: ${result.findings.warnings}`);
	core.info(`Duration: ${result.duration_ms}ms`);
	core.info(`Report: ${reportUrl}`);

	if (result.findings.items.length > 0) {
		core.info("");
		core.info("Findings:");
		for (const item of result.findings.items) {
			const location = item.file ? ` (${item.file}${item.line ? `:${item.line}` : ""})` : "";
			const prefix = item.severity === "error" ? "ERROR" : "WARN";
			core.info(`  [${prefix}]${location} ${item.message}`);
		}
	}

	// Sticky comment + Check Run — only when triggered by a PR and a
	// github_token is available.
	const pr = loadPRContext();
	if (pr && githubToken) {
		core.info("");
		core.info("Posting to GitHub...");
		await postToPR(githubToken, repo, pr, jobId, result);
	} else if (pr && !githubToken) {
		core.info("Skipping PR posting: `github_token` input not set (pass secrets.GITHUB_TOKEN).");
	}

	if (!result.passed) {
		core.setFailed(
			`Verification failed with ${result.findings.errors} error(s) and ${result.findings.warnings} warning(s). See ${reportUrl}`,
		);
	}
}

run().catch((error: unknown) => {
	const message = error instanceof Error ? error.message : String(error);
	core.setFailed(`Unexpected error: ${message}`);
});
