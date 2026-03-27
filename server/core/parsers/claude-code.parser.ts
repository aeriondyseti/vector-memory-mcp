import { readFile, readdir, stat } from "fs/promises";
import { basename, dirname, join } from "path";
import type { ParsedMessage, SessionFileInfo } from "../conversation";
import type { SessionLogParser } from "./types";

// UUID pattern for session IDs
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Extract text content from an assistant message's content array */
function extractAssistantText(
  content: Array<{ type: string; text?: string }>
): string {
  return content
    .filter((block) => block.type === "text" && block.text)
    .map((block) => block.text!)
    .join("\n");
}

/**
 * Extract project name from path-encoded directory name.
 * Claude Code encodes paths by replacing `/` with `-`, e.g. `/home/user/project` → `-home-user-project`.
 * This is a lossy encoding: directory names containing literal dashes (e.g. `my-project`)
 * cannot be distinguished from path separators, so `my-project` decodes as `my/project`.
 * This is a known limitation of Claude Code's encoding scheme.
 */
function extractProjectFromDir(dirName: string): string {
  return dirName.startsWith("-")
    ? dirName.slice(1).replace(/-/g, "/")
    : dirName;
}

export class ClaudeCodeSessionParser implements SessionLogParser {
  async parse(
    filePath: string,
    indexSubagents: boolean = false
  ): Promise<ParsedMessage[]> {
    const fileContent = await readFile(filePath, "utf-8");
    const lines = fileContent.split("\n").filter((line) => line.trim());

    const messages: ParsedMessage[] = [];
    let messageIndex = 0;

    // Derive session ID and project from file path
    const fileName = basename(filePath, ".jsonl");
    const parentDir = basename(dirname(filePath));
    // Check if this is inside a subagents directory
    const isSubagentFile = /[/\\]subagents[/\\]/.test(filePath);

    // For subagent files, project dir is 3 levels up: <project>/<session>/subagents/<file>
    // For main files, project dir is direct parent
    const projectDir = isSubagentFile
      ? basename(dirname(dirname(dirname(filePath))))
      : parentDir;

    const project = extractProjectFromDir(projectDir);

    for (const line of lines) {
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line);
      } catch {
        // Skip malformed lines
        continue;
      }

      const type = entry.type as string;

      // Skip non-message entries
      if (type === "progress" || type === "file-history-snapshot") {
        continue;
      }

      // Skip subagent messages unless configured to include them
      if (!indexSubagents && (entry.isSidechain === true || isSubagentFile)) {
        continue;
      }

      if (type !== "user" && type !== "assistant") {
        continue;
      }

      const message = entry.message as Record<string, unknown> | undefined;
      if (!message) continue;

      const role = message.role as string;
      if (role !== "user" && role !== "assistant") continue;

      let content: string | null = null;

      if (role === "user") {
        const msgContent = message.content;
        if (typeof msgContent === "string") {
          content = msgContent;
        } else if (Array.isArray(msgContent)) {
          // Array content in user messages = tool_result entries, skip
          continue;
        }
      } else if (role === "assistant") {
        const msgContent = message.content;
        if (Array.isArray(msgContent)) {
          content = extractAssistantText(
            msgContent as Array<{ type: string; text?: string }>
          );
        }
      }

      // Skip empty content
      if (!content || content.trim().length === 0) {
        continue;
      }

      const sessionId =
        (entry.sessionId as string) ?? fileName;

      messages.push({
        uuid: (entry.uuid as string) ?? `${sessionId}-${messageIndex}`,
        role: role as "user" | "assistant",
        content: content.trim(),
        timestamp: entry.timestamp
          ? new Date(entry.timestamp as string)
          : new Date(),
        messageIndex,
        sessionId,
        project,
        gitBranch: entry.gitBranch as string | undefined,
        isSubagent: (entry.isSidechain as boolean) ?? isSubagentFile,
        agentId: entry.agentId as string | undefined,
      });

      messageIndex++;
    }

    return messages;
  }

  async findSessionFiles(
    dirPath: string,
    since?: Date,
    indexSubagents: boolean = false
  ): Promise<SessionFileInfo[]> {
    const files: SessionFileInfo[] = [];

    let dirents: import("fs").Dirent[];
    try {
      dirents = await readdir(dirPath, { withFileTypes: true });
    } catch {
      return files;
    }

    for (const dirent of dirents) {
      const entryPath = join(dirPath, dirent.name);

      if (dirent.isDirectory()) {
        if (dirent.name === "subagents") {
          if (indexSubagents) {
            const subFiles = await this.findSubagentFiles(
              entryPath,
              since,
              basename(dirname(dirname(entryPath)))
            );
            files.push(...subFiles);
          }
          continue;
        }

        const subFiles = await this.findSessionFiles(
          entryPath,
          since,
          indexSubagents
        );
        files.push(...subFiles);
      } else if (dirent.name.endsWith(".jsonl")) {
        const sessionId = basename(dirent.name, ".jsonl");
        if (!UUID_PATTERN.test(sessionId)) continue;

        let entryStat;
        try {
          entryStat = await stat(entryPath);
        } catch {
          continue;
        }

        const lastModified = entryStat.mtime;
        if (since && lastModified <= since) continue;

        const projectDir = basename(dirPath);
        const project = extractProjectFromDir(projectDir);

        files.push({
          filePath: entryPath,
          sessionId,
          project,
          lastModified,
        });
      }
    }

    return files;
  }

  private async findSubagentFiles(
    subagentsDir: string,
    since: Date | undefined,
    projectDir: string
  ): Promise<SessionFileInfo[]> {
    const files: SessionFileInfo[] = [];
    let entries: string[];
    try {
      entries = await readdir(subagentsDir);
    } catch {
      return files;
    }

    for (const entry of entries) {
      if (!entry.endsWith(".jsonl")) continue;

      const entryPath = join(subagentsDir, entry);
      let entryStat;
      try {
        entryStat = await stat(entryPath);
      } catch {
        continue;
      }

      const lastModified = entryStat.mtime;
      if (since && lastModified <= since) continue;

      const sessionId = basename(entry, ".jsonl");
      if (!UUID_PATTERN.test(sessionId)) continue;
      const project = extractProjectFromDir(projectDir);

      files.push({
        filePath: entryPath,
        sessionId,
        project,
        lastModified,
      });
    }

    return files;
  }
}
