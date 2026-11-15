import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

type RequestRouter = (request: IncomingMessage, response: ServerResponse, pathname: string) => boolean;

const contentType = 'application/json; charset=utf-8';
const routers: readonly RequestRouter[] = [
  // Future surfaces can claim their path prefixes here: REST, git, GraphQL, and MCP.
];

function replyJson(response: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(body),
    ...headers,
  });
  response.end(body);
}

function requestPath(request: IncomingMessage): string {
  try {
    return new URL(request.url ?? '/', 'http://forge.local').pathname;
  } catch {
    return '/';
  }
}

export function createApp(): Server {
  return createServer((request, response) => {
    const path = requestPath(request);
    const method = request.method ?? 'GET';

    if (method === 'GET' && path === '/healthz') {
      replyJson(response, 200, { ok: true });
      return;
    }

    if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
      replyJson(response, 200, { current_user_url: '/api/v3/user' }, { 'x-oauth-scopes': 'repo, read:org' });
      return;
    }

    for (const route of routers) {
      if (route(request, response, path)) return;
    }

    replyJson(response, 404, { message: 'Not Found' });
  });
}
