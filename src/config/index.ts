import arg from "arg";
import { isAbsolute, join } from "path";
import packageJson from "../../package.json" with { type: "json" };

export const VERSION = packageJson.version;

export type TransportMode = "stdio" | "http" | "both";

export interface Config {
  dbPath: string;
  embeddingModel: string;
  embeddingDimension: number;
  httpPort: number;
  httpHost: string;
  enableHttp: boolean;
  transportMode: TransportMode;
  conversationHistory: {
    enabled: boolean;
    sessionPath: string | null; // null = auto-detect Claude Code session dir
    historyWeight: number; // 0.0-1.0, applied to history scores when merging with memories
  };
}

export interface ConfigOverrides {
  dbPath?: string;
  httpPort?: number;
  enableHttp?: boolean;
  transportMode?: TransportMode;
  conversationHistory?: {
    enabled?: boolean;
    sessionPath?: string;
    historyWeight?: number;
  };
}

// Defaults - always use repo-local .vector-memory folder
const DEFAULT_DB_PATH = join(process.cwd(), ".vector-memory", "memories.db");
const DEFAULT_EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";
const DEFAULT_EMBEDDING_DIMENSION = 384;
const DEFAULT_HTTP_PORT = 3271;
const DEFAULT_HTTP_HOST = "127.0.0.1";

function resolvePath(path: string): string {
  return isAbsolute(path) ? path : join(process.cwd(), path);
}

export function loadConfig(overrides: ConfigOverrides = {}): Config {
  const transportMode = overrides.transportMode ?? "stdio";
  // HTTP enabled by default (needed for hooks), can disable with --no-http
  const enableHttp = overrides.enableHttp ?? true;

  return {
    dbPath: resolvePath(overrides.dbPath ?? DEFAULT_DB_PATH),
    embeddingModel: DEFAULT_EMBEDDING_MODEL,
    embeddingDimension: DEFAULT_EMBEDDING_DIMENSION,
    httpPort: overrides.httpPort ?? DEFAULT_HTTP_PORT,
    httpHost: DEFAULT_HTTP_HOST,
    enableHttp,
    transportMode,
    conversationHistory: {
      enabled: overrides.conversationHistory?.enabled ?? false,
      sessionPath: overrides.conversationHistory?.sessionPath ?? null,
      historyWeight: overrides.conversationHistory?.historyWeight ?? 0.5,
    },
  };
}

/**
 * Parse CLI arguments into config overrides.
 */
export function parseCliArgs(argv: string[]): ConfigOverrides {
  const args = arg(
    {
      "--db-file": String,
      "--port": Number,
      "--no-http": Boolean,
      "--conversation-history": Boolean,
      "--session-path": String,

      // Aliases
      "-d": "--db-file",
      "-p": "--port",
    },
    { argv, permissive: true }
  );

  return {
    dbPath: args["--db-file"],
    httpPort: args["--port"],
    enableHttp: args["--no-http"] ? false : undefined,
    conversationHistory: args["--conversation-history"] || args["--session-path"]
      ? {
          enabled: args["--conversation-history"],
          sessionPath: args["--session-path"],
        }
      : undefined,
  };
}

// Default config for imports that don't use CLI args
export const config = loadConfig();
