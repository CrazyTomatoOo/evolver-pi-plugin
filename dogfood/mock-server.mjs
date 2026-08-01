// Mock OpenAI-compatible server for dogfooding the evolver pi plugin.
// Scripts a conversation: first turn -> a `write` tool call whose content
// contains an "error:" line (to trigger signal detection); second turn (after
// the tool result) -> a final assistant message. Supports both streaming (SSE)
// and non-streaming responses.
import http from "node:http";

const PORT = Number(process.env.MOCK_PORT || "18999");
let callCount = 0;

function hasToolResult(body) {
  return (
    Array.isArray(body.messages) &&
    body.messages.some((m) => m && m.role === "tool")
  );
}

function toolCallMessage() {
  return {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: "call_dogfood_1",
        type: "function",
        function: {
          name: "write",
          arguments: JSON.stringify({
            path: "dogfood.txt",
            content:
              "first line\nerror: dogfood failure to trigger a signal\nlast line\n",
          }),
        },
      },
    ],
  };
}

function finalMessage() {
  return { role: "assistant", content: "Done. I wrote the file." };
}

function completionBody(body) {
  const msg = hasToolResult(body) ? finalMessage() : toolCallMessage();
  const finish = msg.tool_calls ? "tool_calls" : "stop";
  return {
    id: "chatcmpl-dogfood",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: body.model || "mock-model",
    choices: [{ index: 0, message: msg, finish_reason: finish }],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
  };
}

function streamChunks(body) {
  const msg = hasToolResult(body) ? finalMessage() : toolCallMessage();
  const finish = msg.tool_calls ? "tool_calls" : "stop";
  const base = {
    id: "chatcmpl-dogfood",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: body.model || "mock-model",
  };
  const delta = msg.tool_calls
    ? { role: "assistant", tool_calls: msg.tool_calls }
    : { role: "assistant", content: msg.content };
  return [
    { ...base, choices: [{ index: 0, delta, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }] },
  ];
}

const server = http.createServer((req, res) => {
  let data = "";
  req.on("data", (c) => (data += c));
  req.on("end", () => {
    const url = req.url || "";
    if (req.method === "GET" && url.startsWith("/v1/models")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          object: "list",
          data: [{ id: "mock-model", object: "model", owned_by: "mock" }],
        }),
      );
      return;
    }
    if (req.method === "POST" && url.startsWith("/v1/chat/completions")) {
      let body = {};
      try {
        body = JSON.parse(data || "{}");
      } catch {
        body = {};
      }
      callCount += 1;
      console.error(
        `[mock] chat/completions #${callCount} stream=${!!body.stream} hasToolResult=${hasToolResult(body)}`,
      );
      if (body.stream) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        for (const chunk of streamChunks(body)) {
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }
        res.write("data: [DONE]\n\n");
        res.end();
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(completionBody(body)));
      }
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: `not found: ${req.method} ${url}` } }));
  });
});

server.listen(PORT, "127.0.0.1", () =>
  console.error(`[mock] listening on 127.0.0.1:${PORT}`),
);
