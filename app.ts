import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { restRouter } from './rest.ts';
import { gitRouter } from './git.ts';
import { graphqlRouter } from './graphql.ts';
import { mcpRouter } from './mcp.ts';

type RequestRouter = (request: IncomingMessage, response: ServerResponse, pathname: string, url?: URL) => boolean;

const contentType = 'application/json; charset=utf-8';
const routers: readonly RequestRouter[] = [gitRouter, restRouter, graphqlRouter, mcpRouter];

function replyJson(response: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  const body = Buffer.from(`${JSON.stringify(value)}\n`);
  response.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    ...headers,
  });
  response.end(body);
}

function requestUrl(request: IncomingMessage): URL {
  try {
    return new URL(request.url ?? '/', 'http://forge.local');
  } catch {
    return new URL('http://forge.local/');
  }
}

export function createApp(): Server {
  return createServer((request, response) => {
    const url = requestUrl(request), path = url.pathname;
    const method = request.method ?? 'GET';

    if (method === 'GET' && path === '/healthz') {
      replyJson(response, 200, { ok: true });
      return;
    }

    for (const route of routers) {
      if (route(request, response, path, url)) return;
    }

    replyJson(response, 404, { message: 'Not Found' });
  });
}
