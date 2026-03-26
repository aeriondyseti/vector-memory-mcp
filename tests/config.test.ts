import { afterEach, describe, expect, test } from "bun:test";
import { parseCliArgs, loadConfig } from "../server/config/index";

describe("parseCliArgs", () => {
  test("returns empty overrides for no args", () => {
    const result = parseCliArgs([]);
    expect(result.dbPath).toBeUndefined();
    expect(result.httpPort).toBeUndefined();
    expect(result.enableHttp).toBeUndefined();
  });

  test("parses --db-file", () => {
    const result = parseCliArgs(["--db-file", "/custom/path.db"]);
    expect(result.dbPath).toBe("/custom/path.db");
  });

  test("parses -d alias", () => {
    const result = parseCliArgs(["-d", "/alias/path.db"]);
    expect(result.dbPath).toBe("/alias/path.db");
  });

  test("parses --port", () => {
    const result = parseCliArgs(["--port", "8080"]);
    expect(result.httpPort).toBe(8080);
  });

  test("parses -p alias", () => {
    const result = parseCliArgs(["-p", "9000"]);
    expect(result.httpPort).toBe(9000);
  });

  test("parses --no-http", () => {
    const result = parseCliArgs(["--no-http"]);
    expect(result.enableHttp).toBe(false);
  });

  test("parses --plugin", () => {
    const result = parseCliArgs(["--plugin"]);
    expect(result.pluginMode).toBe(true);
  });

  test("parses multiple args together", () => {
    const result = parseCliArgs([
      "--db-file", "/my/db.sqlite",
      "--port", "4000",
      "--no-http",
    ]);
    expect(result.dbPath).toBe("/my/db.sqlite");
    expect(result.httpPort).toBe(4000);
    expect(result.enableHttp).toBe(false);
  });

  test("ignores unknown args (permissive mode)", () => {
    const result = parseCliArgs(["--unknown-flag", "value", "--db-file", "/test.db"]);
    expect(result.dbPath).toBe("/test.db");
  });
});

describe("loadConfig", () => {
  test("uses defaults when no overrides", () => {
    const config = loadConfig();
    expect(config.embeddingModel).toBe("Xenova/all-MiniLM-L6-v2");
    expect(config.embeddingDimension).toBe(384);
    expect(config.httpPort).toBe(3271);
    expect(config.httpHost).toBe("127.0.0.1");
    expect(config.enableHttp).toBe(false);
    expect(config.pluginMode).toBe(false);
    expect(config.transportMode).toBe("stdio");
  });

  test("plugin mode enables HTTP by default", () => {
    const config = loadConfig({ pluginMode: true });
    expect(config.pluginMode).toBe(true);
    expect(config.enableHttp).toBe(true);
  });

  test("--port alone does not enable HTTP", () => {
    const config = loadConfig({ httpPort: 4000 });
    expect(config.enableHttp).toBe(false);
  });

  test("--no-http overrides plugin mode", () => {
    const config = loadConfig({ pluginMode: true, enableHttp: false });
    expect(config.enableHttp).toBe(false);
  });

  test("applies overrides", () => {
    const config = loadConfig({
      dbPath: "/custom/db.sqlite",
      httpPort: 5000,
      enableHttp: false,
      transportMode: "http",
    });
    expect(config.dbPath).toBe("/custom/db.sqlite");
    expect(config.httpPort).toBe(5000);
    expect(config.enableHttp).toBe(false);
    expect(config.transportMode).toBe("http");
  });

  test("resolves relative db paths to cwd", () => {
    const config = loadConfig({ dbPath: "relative/path.db" });
    expect(config.dbPath).toContain("relative/path.db");
    expect(config.dbPath.startsWith("/")).toBe(true);
  });
});

describe("environment variable fallbacks", () => {
  afterEach(() => {
    delete process.env.VECTOR_MEMORY_DB_PATH;
    delete process.env.VECTOR_MEMORY_HTTP_PORT;
  });

  test("VECTOR_MEMORY_DB_PATH is used when no CLI flag is passed", () => {
    process.env.VECTOR_MEMORY_DB_PATH = "/env/var/path.db";
    const config = loadConfig();
    expect(config.dbPath).toBe("/env/var/path.db");
  });

  test("VECTOR_MEMORY_HTTP_PORT is used when no CLI flag is passed", () => {
    process.env.VECTOR_MEMORY_HTTP_PORT = "9999";
    const config = loadConfig();
    expect(config.httpPort).toBe(9999);
  });

  test("CLI flags take precedence over env vars", () => {
    process.env.VECTOR_MEMORY_DB_PATH = "/env/var/path.db";
    process.env.VECTOR_MEMORY_HTTP_PORT = "9999";
    const config = loadConfig({
      dbPath: "/cli/flag/path.db",
      httpPort: 7777,
    });
    expect(config.dbPath).toBe("/cli/flag/path.db");
    expect(config.httpPort).toBe(7777);
  });

  test("defaults are used when neither CLI flag nor env var is set", () => {
    const config = loadConfig();
    expect(config.dbPath).toContain(".vector-memory/memories.db");
    expect(config.httpPort).toBe(3271);
  });
});
