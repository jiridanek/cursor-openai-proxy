export type SessionMode = "sticky" | "prefix";
export type AgentMode = "ask" | "plan" | "agent";

export type AuthConfig =
  | { mode: "hosted"; cursorApiKey: string }
  | { mode: "passthrough" };

export type ProxyConfig = {
  host: string;
  port: number;
  workspace: string;
  sessionMode: SessionMode;
  agentMode: AgentMode;
  auth: AuthConfig;
};

export type CliOptions = {
  host: string;
  port: number;
  workspace: string;
  sessionMode: SessionMode;
  agentMode: AgentMode;
  cursorApiKey: string | undefined;
};

const SESSION_MODES = new Set<SessionMode>(["sticky", "prefix"]);
const AGENT_MODES = new Set<AgentMode>(["ask", "plan", "agent"]);

export function parseArgs(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): CliOptions {
  const opts: CliOptions = {
    host: "127.0.0.1",
    port: 11434,
    workspace: process.cwd(),
    sessionMode: "sticky",
    agentMode: "ask",
    cursorApiKey: env.CURSOR_API_KEY?.trim() || undefined,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`Missing value for ${arg}`);
      }
      i += 1;
      return value;
    };

    switch (arg) {
      case "--port":
        opts.port = Number(next());
        if (!Number.isInteger(opts.port) || opts.port <= 0) {
          throw new Error(`Invalid --port: ${opts.port}`);
        }
        break;
      case "--host":
        opts.host = next();
        break;
      case "--workspace":
        opts.workspace = next();
        break;
      case "--cursor-api-key":
        opts.cursorApiKey = next().trim();
        break;
      case "--session-mode": {
        const value = next();
        if (!SESSION_MODES.has(value as SessionMode)) {
          throw new Error(`Invalid --session-mode: ${value}`);
        }
        opts.sessionMode = value as SessionMode;
        break;
      }
      case "--agent-mode": {
        const value = next();
        if (!AGENT_MODES.has(value as AgentMode)) {
          throw new Error(`Invalid --agent-mode: ${value}`);
        }
        opts.agentMode = value as AgentMode;
        break;
      }
      case "--help":
      case "-h":
        opts.port = -1;
        break;
      default:
        if (arg.startsWith("-")) {
          throw new Error(`Unknown flag: ${arg}`);
        }
    }
  }

  return opts;
}

export function toProxyConfig(opts: CliOptions): ProxyConfig {
  const key = opts.cursorApiKey?.trim();
  return {
    host: opts.host,
    port: opts.port,
    workspace: opts.workspace,
    sessionMode: opts.sessionMode,
    agentMode: opts.agentMode,
    auth: key ? { mode: "hosted", cursorApiKey: key } : { mode: "passthrough" },
  };
}

export const USAGE = `Usage: cursor-openai-proxy [options]

  --port <n>              Listen port (default 11434)
  --host <addr>           Bind address (default 127.0.0.1)
  --workspace <path>      Local agent cwd (default process cwd)
  --cursor-api-key <key>  Hosted Cursor API key (else $CURSOR_API_KEY, else passthrough)
  --session-mode <mode>   sticky | prefix (default sticky)
  --agent-mode <mode>     ask | plan | agent (default ask)
`;
