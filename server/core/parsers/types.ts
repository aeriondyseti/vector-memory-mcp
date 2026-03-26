import type { ParsedMessage, SessionFileInfo } from "../conversation.js";

/** Interface for parsing session log files into structured messages */
export interface SessionLogParser {
  /** Parse a session log file into ordered messages */
  parse(filePath: string, indexSubagents?: boolean): Promise<ParsedMessage[]>;

  /** Discover session log files in a directory */
  findSessionFiles(
    dirPath: string,
    since?: Date,
    indexSubagents?: boolean
  ): Promise<SessionFileInfo[]>;
}
