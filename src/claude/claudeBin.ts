import { execFile } from "child_process";
import { existsSync } from "fs";
import { homedir } from "os";
import { promisify } from "util";
import * as path from "path";

const execFileAsync = promisify(execFile);

// ~/.local/bin/claude is where Claude Code's own official standalone
// installer (the curl | sh method) puts it for a user-level, non-sudo
// install -- confirmed missing here by a real ENOENT report where `which
// claude` in a real terminal resolved to exactly this path.
const CLAUDE_BIN_CANDIDATES = [
  "/usr/local/bin/claude",
  "/opt/homebrew/bin/claude",
  path.join(homedir(), ".local/bin/claude"),
];

function resolveUserShell(): string {
  const shell: unknown = process.env.SHELL;
  return typeof shell === "string" && shell ? shell : "/bin/zsh";
}

/** Electron apps launched from Finder/Dock often inherit a minimal PATH that
 *  doesn't include where `claude` actually is -- ask the user's own login
 *  shell to resolve it (picks up whatever their normal terminal would find)
 *  before falling back to fixed install locations. Ported from Terminus's
 *  pty/shellDetect.ts + claude/headlessAssist.ts (same problem, same fix). */
async function tryLoginShellWhich(bin: string): Promise<string | null> {
  const loginShell = resolveUserShell();
  try {
    const { stdout } = await execFileAsync(loginShell, ["-lic", `which ${bin}`], { timeout: 5000 });
    const resolved = stdout.trim().split("\n").pop()?.trim();
    return resolved && existsSync(resolved) ? resolved : null;
  } catch {
    return null;
  }
}

export async function resolveClaudeBin(): Promise<string> {
  const loginShellPath = await tryLoginShellWhich("claude");
  if (loginShellPath) return loginShellPath;

  for (const candidate of CLAUDE_BIN_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }

  return "claude";
}
