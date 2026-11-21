import { spawn, type ChildProcess } from "node:child_process";

/** Terminate an owned subprocess and its descendants, never a pre-existing external process. */
export function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) {
    child.kill("SIGTERM");
    return;
  }

  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      shell: false, windowsHide: true, stdio: "ignore",
    });
    killer.once("error", () => { child.kill("SIGTERM"); });
    killer.once("close", code => {
      if (code !== 0 && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    });
    return;
  }

  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  const force = setTimeout(() => {
    try { process.kill(-pid, "SIGKILL"); } catch { /* Already terminated. */ }
  }, 1_000);
  force.unref();
}
