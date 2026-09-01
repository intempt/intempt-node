/**
 * Minimal stand-in for the Intempt ingestion API, so the sample app runs offline
 * with no credentials. It answers the four endpoints the SDK talks to and echoes
 * plausible bodies for the two read endpoints.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockApi {
  host: string;
  requestCount(): number;
  stop(): Promise<void>;
}

export async function startMockApi(): Promise<MockApi> {
  let count = 0;

  const server = http.createServer((req, res) => {
    count += 1;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = req.url ?? '';
      const auth = req.headers.authorization ?? '';

      if (!auth.startsWith('Basic ')) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end('{"error":"expected an Authorization: Basic header"}');
        return;
      }

      let body: string = '{}';
      if (url.includes('/optimization/choose-api')) {
        // The real wire shape: name / group / body, and nothing else. `ExperienceApiChoose` on
        // `audience-service` main declares exactly those three fields — there is no `reason`, and a
        // fixture that invents one is how the PREVIOUS fixture bug happened: it said `variant` and
        // `payload`, which no serving response has ever sent, so the sample looked like it worked
        // while variation() returned the caller's default every time. A fixture asserts what the
        // service sends today, never what a branch might send later.
        body = JSON.stringify({
          choices: [
            { name: 'pricing_cta', group: 'b', body: 'Start free' },
            { name: 'new_checkout', group: 'control', body: null },
          ],
        });
      } else if (url.includes('/feeds/')) {
        body = JSON.stringify({
          items: [
            { id: 'sku-42', title: 'Widget' },
            { id: 'sku-7', title: 'Gadget' },
          ],
        });
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    host: `127.0.0.1:${port}`,
    requestCount: () => count,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
