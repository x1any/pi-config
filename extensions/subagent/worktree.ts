import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
    type ExtensionAPI,
    truncateHead,
} from "@earendil-works/pi-coding-agent";

const GIT_TIMEOUT_MS = 30_000;
const PATCH_PREVIEW_MAX_LINES = 500;

export class WorktreeBlockedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "WorktreeBlockedError";
    }
}

export interface PatchResult {
    changedFiles: string[];
    patchPath?: string;
    patchPreview: string;
    patchBytes: number;
    appliesCleanly: boolean;
    applyError?: string;
    artifactDir?: string;
}

interface GitResult {
    stdout: string;
    stderr: string;
    code: number;
}

function formatGitError(action: string, result: GitResult): string {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
    return `${action}: ${detail}`;
}

function isWithin(root: string, candidate: string): boolean {
    const relative = path.relative(root, candidate);
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export class WorktreeLease {
    private disposed = false;
    private keepArtifacts = false;

    get retainedArtifactDir(): string | undefined {
        return this.keepArtifacts ? this.tempRoot : undefined;
    }

    constructor(
        private readonly pi: ExtensionAPI,
        readonly repositoryRoot: string,
        readonly requestedCwd: string,
        readonly worktreeRoot: string,
        readonly cwd: string,
        readonly baseCommit: string,
        readonly tempRoot: string,
    ) {}

    private async git(
        args: string[],
        cwd: string,
        options: { signal?: AbortSignal; timeout?: number } = {},
    ): Promise<GitResult> {
        return this.pi.exec("git", args, {
            cwd,
            signal: options.signal,
            timeout: options.timeout ?? GIT_TIMEOUT_MS,
        });
    }

    async finalize(maxOutputBytes: number, signal?: AbortSignal): Promise<PatchResult> {
        const add = await this.git(["add", "-A"], this.worktreeRoot, { signal });
        if (add.code !== 0) throw new Error(formatGitError("Failed to stage worktree changes", add));

        const diff = await this.git(
            ["diff", "--cached", "--binary", "--no-ext-diff", this.baseCommit],
            this.worktreeRoot,
            { signal },
        );
        if (diff.code !== 0) throw new Error(formatGitError("Failed to generate worktree patch", diff));

        const names = await this.git(
            ["diff", "--cached", "--name-only", "-z", this.baseCommit],
            this.worktreeRoot,
            { signal },
        );
        if (names.code !== 0) throw new Error(formatGitError("Failed to list changed files", names));

        const changedFiles = names.stdout.split("\0").filter(Boolean);
        const patchBytes = Buffer.byteLength(diff.stdout, "utf8");
        if (patchBytes === 0) {
            return {
                changedFiles,
                patchPreview: "",
                patchBytes: 0,
                appliesCleanly: true,
            };
        }

        const patchPath = path.join(this.tempRoot, "changes.patch");
        await fs.promises.writeFile(patchPath, diff.stdout, {
            encoding: "utf8",
            mode: 0o600,
        });
        this.keepArtifacts = true;

        const check = await this.git(["apply", "--check", patchPath], this.repositoryRoot, {
            signal,
        });
        const appliesCleanly = check.code === 0;
        const applyError = appliesCleanly
            ? undefined
            : check.stderr.trim() || check.stdout.trim() || `git apply --check exited ${check.code}`;

        const preview = truncateHead(diff.stdout, {
            maxLines: PATCH_PREVIEW_MAX_LINES,
            maxBytes: maxOutputBytes,
        });
        let patchPreview = preview.content;
        if (preview.truncated) {
            patchPreview += `\n\n[Patch preview truncated: ${preview.outputBytes}/${preview.totalBytes} bytes. Full patch: ${patchPath}]`;
        }

        return {
            changedFiles,
            patchPath,
            patchPreview,
            patchBytes,
            appliesCleanly,
            applyError,
            artifactDir: this.tempRoot,
        };
    }

    async dispose(): Promise<void> {
        if (this.disposed) return;
        this.disposed = true;

        const remove = await this.git(
            ["worktree", "remove", "--force", this.worktreeRoot],
            this.repositoryRoot,
            { timeout: GIT_TIMEOUT_MS },
        ).catch(() => undefined);

        if (!remove || remove.code !== 0) {
            await fs.promises.rm(this.worktreeRoot, { recursive: true, force: true }).catch(() => {});
            await this.git(["worktree", "prune"], this.repositoryRoot, {
                timeout: GIT_TIMEOUT_MS,
            }).catch(() => undefined);
        }

        if (!this.keepArtifacts) {
            await fs.promises.rm(this.tempRoot, { recursive: true, force: true }).catch(() => {});
        }
    }
}

export class WorktreeManager {
    constructor(private readonly pi: ExtensionAPI) {}

    private async git(
        args: string[],
        cwd: string,
        signal?: AbortSignal,
    ): Promise<GitResult> {
        return this.pi.exec("git", args, {
            cwd,
            signal,
            timeout: GIT_TIMEOUT_MS,
        });
    }

    async create(requestedCwd: string, signal?: AbortSignal): Promise<WorktreeLease> {
        let cwd: string;
        try {
            cwd = await fs.promises.realpath(requestedCwd);
            const stat = await fs.promises.stat(cwd);
            if (!stat.isDirectory()) throw new Error("not a directory");
        } catch {
            throw new WorktreeBlockedError(`execute cwd is not an accessible directory: ${requestedCwd}`);
        }

        const rootResult = await this.git(["rev-parse", "--show-toplevel"], cwd, signal).catch(
            () => undefined,
        );
        if (!rootResult || rootResult.code !== 0 || !rootResult.stdout.trim()) {
            throw new WorktreeBlockedError("execute requires a Git repository");
        }

        const repositoryRoot = await fs.promises.realpath(rootResult.stdout.trim());
        if (!isWithin(repositoryRoot, cwd)) {
            throw new WorktreeBlockedError("execute cwd must be inside the detected Git repository");
        }

        const status = await this.git(
            ["status", "--porcelain=v1", "--untracked-files=all"],
            repositoryRoot,
            signal,
        );
        if (status.code !== 0) {
            throw new WorktreeBlockedError(formatGitError("Unable to inspect Git worktree", status));
        }
        if (status.stdout.trim()) {
            throw new WorktreeBlockedError(
                "execute requires a completely clean Git worktree (tracked and untracked changes are present)",
            );
        }

        const head = await this.git(["rev-parse", "HEAD"], repositoryRoot, signal);
        if (head.code !== 0 || !head.stdout.trim()) {
            throw new WorktreeBlockedError("execute requires a repository with a valid HEAD commit");
        }
        const baseCommit = head.stdout.trim();

        const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-worktree-"));
        const worktreeRoot = path.join(tempRoot, "worktree");
        const relativeCwd = path.relative(repositoryRoot, cwd);

        let add: GitResult;
        try {
            add = await this.git(
                ["worktree", "add", "--detach", worktreeRoot, baseCommit],
                repositoryRoot,
                signal,
            );
        } catch (error) {
            await fs.promises.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
            throw new Error(
                `Failed to create detached worktree: ${error instanceof Error ? error.message : String(error)}`,
            );
        }

        if (add.code !== 0) {
            await fs.promises.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
            throw new Error(formatGitError("Failed to create detached worktree", add));
        }

        const mappedCwd = path.join(worktreeRoot, relativeCwd);
        try {
            const stat = await fs.promises.stat(mappedCwd);
            if (!stat.isDirectory()) throw new Error("not a directory");
        } catch {
            await this.git(["worktree", "remove", "--force", worktreeRoot], repositoryRoot).catch(
                () => undefined,
            );
            await fs.promises.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
            throw new Error(`Mapped worktree cwd does not exist: ${mappedCwd}`);
        }

        return new WorktreeLease(
            this.pi,
            repositoryRoot,
            cwd,
            worktreeRoot,
            mappedCwd,
            baseCommit,
            tempRoot,
        );
    }
}
