// Mock provider extension for dogfooding: registers a "mock" provider that
// points pi's openai-completions client at the local mock server.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerProvider("mock", {
    baseUrl: `http://127.0.0.1:${process.env.MOCK_PORT || "18999"}/v1`,
    apiKey: "mock-key",
    api: "openai-completions",
    models: [
      {
        id: "mock-model",
        name: "Mock Model",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096,
      },
    ],
  });
}
