import http from "node:http";
import { handleRequest } from "../../cloudflare/position-geo-proxy/src/index.js";

const port = Number(process.env.PORT) || 10000;

const server = http.createServer(async (incoming, outgoing) => {
  try {
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
      for (const item of Array.isArray(value) ? value : [value]) {
        if (item !== undefined) headers.append(name, item);
      }
    }

    const origin = `https://${incoming.headers.host || "localhost"}`;
    const request = new Request(new URL(incoming.url || "/", origin), {
      method: incoming.method || "GET",
      headers
    });
    const response = await handleRequest(request, process.env);

    outgoing.statusCode = response.status;
    response.headers.forEach((value, name) => outgoing.setHeader(name, value));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    outgoing.statusCode = 500;
    outgoing.setHeader("cache-control", "no-store");
    outgoing.setHeader("content-type", "application/json; charset=utf-8");
    outgoing.end(JSON.stringify({ ok: false }));
  }
});

server.on("clientError", (_error, socket) => {
  socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Position relay listening on port ${port}.`);
});
