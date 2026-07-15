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
    // Login-shell startup/logout hooks (MOTD, corporate session-save
    // scripts, etc.) can print extra lines before or after `which`'s own
    // output, so the resolved path isn't reliably the last line -- scan
    // every line for one that actually names and contains this binary.
    const lines = stdout.split("\n").map((line) => line.trim());
    const resolved = lines.find((line) => line.endsWith(`/${bin}`) && existsSync(line));
    return resolved ?? null;
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

let cachedLoginShellEnv: Promise<Record<string, string>> | null = null;

/** Corporate networks often require proxy env vars (HTTPS_PROXY etc.), set
 *  by the login shell's own rc files -- Obsidian's Electron process doesn't
 *  inherit those (same root problem as the PATH lookup above), so a spawned
 *  `claude` can silently hang trying to reach Anthropic's API directly with
 *  no proxy, rather than failing fast. Resolve the login shell's real env
 *  once and merge it into the child's env at spawn time. Cached because
 *  spawning a login shell has real startup cost and this only needs to
 *  reflect the machine's config, not change per-query. */
export async function resolveLoginShellEnv(): Promise<Record<string, string>> {
  if (cachedLoginShellEnv) return cachedLoginShellEnv;
  cachedLoginShellEnv = (async () => {
    const loginShell = resolveUserShell();
    try {
      const { stdout } = await execFileAsync(loginShell, ["-lic", "env -0"], {
        timeout: 5000,
        maxBuffer: 10 * 1024 * 1024,
      });
      const env: Record<string, string> = {};
      for (const entry of stdout.split("\0")) {
        const idx = entry.indexOf("=");
        if (idx <= 0) continue;
        env[entry.slice(0, idx)] = entry.slice(idx + 1);
      }
      return env;
    } catch {
      return {};
    }
  })();
  return cachedLoginShellEnv;
}
