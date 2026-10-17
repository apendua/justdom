/**
 * Temporary, for item 10.2 of docs/freedom-architecture-plan.md, and to go
 * with the depth probe: where `depth-probe.html`'s Upload JSON button sends
 * its results, so that a run on the headset lands as a file in the repo
 * rather than in a clipboard that has to be carried over by hand.
 *
 *     POST <base>api/probe-results   the probe's JSON, as its body
 *
 * The body is written to `probe-results/depth-probe-<time>.json` beside this
 * app's `vite.config.mts`, a directory `.gitignore` leaves out, and the reply
 * names the file. It runs only while `npm run dev` (`npx vite`) does:
 * `apply: "serve"` keeps it out of the build, so nothing deployed carries a
 * route that writes to disk. Within dev it writes one directory, under a name
 * it makes itself, from a body that has to parse as JSON and is capped.
 *
 * JavaScript with JSDoc types, like the repo's other Vite plugins.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/** More than a sweep's JSON at 1024 px, which is a few hundred kB. */
const SIZE_LIMIT = 16 * 1024 * 1024;

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {Record<string, unknown>} body
 * @returns {void}
 */
function reply(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<string | null>} The body, or null past the cap.
 */
async function readBody(req) {
  /** @type {Buffer[]} */
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > SIZE_LIMIT) {
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * @param {{ dir: string, base: string }} options `dir` is where the files
 *   go; `base` is the app's Vite `base`, which the route sits under.
 * @returns {import('vite').Plugin}
 */
export default function ProbeResultsPlugin({ dir, base }) {
  const route = `${base}api/probe-results`;
  return {
    name: "desk-probe-results",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if ((req.url ?? "").split("?")[0] !== route) {
          next();
          return;
        }
        if (req.method !== "POST") {
          reply(res, 405, { error: "method", message: "POST the probe's JSON." });
          return;
        }
        const body = await readBody(req);
        if (body === null) {
          reply(res, 413, { error: "size", message: `Over ${SIZE_LIMIT} bytes.` });
          return;
        }
        try {
          JSON.parse(body);
        } catch {
          reply(res, 400, { error: "json", message: "The body is not JSON." });
          return;
        }
        const name = `depth-probe-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
        await mkdir(dir, { recursive: true });
        const file = path.join(dir, name);
        await writeFile(file, body);
        server.config.logger.info(`depth probe results written to ${file}`);
        reply(res, 201, { file: path.relative(server.config.root, file) });
      });
    },
  };
}
