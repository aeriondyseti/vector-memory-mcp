export const resources: Array<{
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}> = [];

const RESOURCE_CONTENT: Record<string, string> = {};

export function readResource(uri: string): {
  contents: Array<{ uri: string; mimeType: string; text: string }>;
} {
  const text = RESOURCE_CONTENT[uri];
  if (!text) {
    throw new Error(`Resource not found: ${uri}`);
  }
  return {
    contents: [{ uri, mimeType: "text/markdown", text }],
  };
}
