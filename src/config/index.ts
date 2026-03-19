import arg from "arg";
import { homedir } from "os";
import { isAbsolute, join } from "path";
import packageJson from "../../package.json" with { type: "json" };

export const VERSION = packageJson.version;

/** Debug mode: auto-enabled for pre-release versions (dev/rc), or via DEBUG env var */
export const DEBUG = process.env.VECTOR_MEMORY_DEBUG === "1"
  || VERSION.includes("-dev.")
  || VERSION.includes("-rc.");

export type TransportMode = "stdio" | "http" | "both";

export interface ConversationHistoryConfig {
  enabled: boolean;
  sessionLogPath: string | null;
  historyWeight: number;
  chunkOverlap: number;
  maxChunkMessages: number;
  indexSubagents: boolean;
}

export interface Config {
  dbPath: string;
  embeddingModel: string;
  embeddingDimension: number;
  httpPort: number;
  httpHost: string;
  enableHttp: boolean;
  transportMode: TransportMode;
  conversationHistory: ConversationHistoryConfig;
}

export interface ConfigOverrides {
  dbPath?: string;
  httpPort?: number;
  enableHttp?: boolean;
  transportMode?: TransportMode;
  enableHistory?: boolean;
  historyPath?: string;
  historyWeight?: number;
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
      enabled: overrides.enableHistory ?? false,
      sessionLogPath: overrides.historyPath ?? null,
      historyWeight: overrides.historyWeight ?? 0.75,
      chunkOverlap: 1,
      maxChunkMessages: 10,
      indexSubagents: false,
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
      "--enable-history": Boolean,
      "--history-path": String,
      "--history-weight": Number,

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
    enableHistory: args["--enable-history"] ?? undefined,
    historyPath: args["--history-path"],
    historyWeight: args["--history-weight"],
  };
}

/**
 * Resolve the session log path for conversation history indexing.
 * Returns the configured path, or auto-detects Claude Code's session directory.
 */
export function resolveSessionLogPath(config: ConversationHistoryConfig): string {
  if (config.sessionLogPath) {
    return resolvePath(config.sessionLogPath);
  }
  // Auto-detect Claude Code session log directory
  const claudeProjectsDir = join(homedir(), ".claude", "projects");
  return claudeProjectsDir;
}

// Default config for imports that don't use CLI args
export const config = loadConfig();
