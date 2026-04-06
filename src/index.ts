import * as core from "@actions/core";
import * as exec from "@actions/exec";

const POLL_INTERVAL_MS = 2000;
const TIMEOUT_MS = 5 * 60 * 1000;

interface VerifySubmitResponse {
	data: { job_id: string } | null;
	error: string | null;
}

interface VerifyStatusResponse {
	data: { id: string; status: string; step: string } | null;
	error: string | null;
}

interface VerifyResultResponse {
	data: {
		id: string;
		status: string;
		passed: boolean;
		findings: {
			errors: number;
			warnings: number;
			items: Array<{
				severity: string;
				message: string;
				file?: string;
				line?: number;
			}>;
		};
		proof_url: string;
		duration_ms: number;
	} | null;
	error: string | null;
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

	const exitCode = await exec.exec("git", ["diff", `origin/${base}...HEAD`], options);
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

async function run(): Promise<void> {
	const token = core.getInput("token", { required: true });
	const base = core.getInput("base") || "main";
	const cloudUrl = (core.getInput("cloud_url") || "https://api.mainahq.com").replace(/\/+$/, "");

	const repo = process.env.GITHUB_REPOSITORY;
	if (!repo) {
		core.setFailed(
			"GITHUB_REPOSITORY is not set. This action must run in a GitHub Actions environment.",
		);
		return;
	}

	core.info(`Verifying ${repo} against base branch '${base}'`);

	// 1. Get diff
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

	// 2. Submit verification
	core.info("Submitting verification...");
	const jobId = await submitVerification(cloudUrl, token, diff, repo, base);
	core.info(`Verification job started: ${jobId}`);

	// 3. Poll until done
	core.info("Waiting for verification to complete...");
	await pollStatus(cloudUrl, token, jobId);

	// 4. Fetch result
	core.info("Fetching results...");
	const result = await fetchResult(cloudUrl, token, jobId);

	// 5. Set outputs
	core.setOutput("passed", String(result.passed));
	core.setOutput("findings_count", String(result.findings.errors + result.findings.warnings));
	core.setOutput("proof_url", result.proof_url);

	// 6. Log summary
	core.info("--- Verification Results ---");
	core.info(`Status: ${result.passed ? "PASSED" : "FAILED"}`);
	core.info(`Errors: ${result.findings.errors}`);
	core.info(`Warnings: ${result.findings.warnings}`);
	core.info(`Duration: ${result.duration_ms}ms`);
	core.info(`Proof: ${result.proof_url}`);

	if (result.findings.items.length > 0) {
		core.info("");
		core.info("Findings:");
		for (const item of result.findings.items) {
			const location = item.file ? ` (${item.file}${item.line ? `:${item.line}` : ""})` : "";
			const prefix = item.severity === "error" ? "ERROR" : "WARN";
			core.info(`  [${prefix}]${location} ${item.message}`);
		}
	}

	// 7. Fail if not passed
	if (!result.passed) {
		core.setFailed(
			`Verification failed with ${result.findings.errors} error(s) and ${result.findings.warnings} warning(s). See ${result.proof_url}`,
		);
	}
}

run().catch((error: unknown) => {
	const message = error instanceof Error ? error.message : String(error);
	core.setFailed(`Unexpected error: ${message}`);
});
