import { spawn } from "node:child_process";
import {
  currentWorkflowCancellationSignal,
  WorkflowCancellationError,
} from "@/lib/workflow-cancellation";

export type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const signal = currentWorkflowCancellationSignal();
    if (signal?.aborted) {
      reject(new WorkflowCancellationError());
      return;
    }
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const abort = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.kill();
      reject(new WorkflowCancellationError());
    };

    const timer = options.timeoutMs
      ? setTimeout(() => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener("abort", abort);
          child.kill();
          reject(new Error(`${command} timed out after ${options.timeoutMs}ms`));
        }, options.timeoutMs)
      : null;
    signal?.addEventListener("abort", abort, { once: true });

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      const detail = [
        `Unable to start ${command}`,
        error.message,
        "code" in error && error.code ? `code=${error.code}` : null,
      ]
        .filter(Boolean)
        .join(": ");
      reject(new Error(detail, { cause: error }));
    });
    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve({ stdout, stderr, exitCode: exitCode ?? -1 });
    });
  });
}
