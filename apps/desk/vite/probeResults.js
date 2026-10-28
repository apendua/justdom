/**
 * Where `paint-order-probe.html`'s Save JSON button sends its results, so
 * that a run of the paint-order probe on the headset lands as a file in the
 * repo rather than in a download that has to be carried over by hand.
 * 10.2's depth probe had the same route, at `c860ef04` in #607.
 *
 *     POST <base>api/probe-results   the probe's JSON, as its body
 *
 * The body is written to `probe-results/<prefix>-<scene>-<time>.json`
 * beside this app's `vite.config.mts`, a directory `.gitignore` leaves out,
 * and the reply names the file. The scene is the body's own `scene`, so a
 * file's name says what is in it, cut down to what a name can safely hold
 * (`resultsFileName`); a body without one gives a name without it. It runs only while `npm run dev` (`npx vite`) does:
 * `apply: "serve"` keeps it out of the build, so nothing deployed carries a
 * route that writes to disk. Within dev it writes one directory, under a
 * name it makes itself, from a body that has to parse as JSON and is capped.
 * A request it cannot answer, a write that fails among them, is answered
 * 500 with the error, and the dev server goes on.
 *
 * JavaScript with JSDoc types, like the repo's other Vite plugins.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/** More than a run with a few pairs of eye images, a few MB each. */
const SIZE_LIMIT = 64 * 1024 * 1024;

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
 * The name a body is written under: `prefix`, then `label` cut down to
 * lowercase letters, digits and dashes, at most 40 of them, then the time,
 * so that no label reaches outside the directory or past another's file.
 *
 * @param {string} prefix
 * @param {string | null} label
 * @param {Date} time
 * @returns {string}
 */
export function resultsFileName(prefix, label, time) {
  const run = (label ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  const stamp = time.toISOString().replace(/[:.]/g, "-");
  return `${[prefix, run, stamp].filter(Boolean).join("-")}.json`;
}

/**
 * @param {{ dir: string, base: string, prefix: string }} options `dir` is
 *   where the files go; `base` is the app's Vite `base`, which the route
 *   sits under; `prefix` starts each file's name.
 * @returns {import('vite').Plugin}
 */
export default function ProbeResultsPlugin({ dir, base, prefix }) {
  const route = `${base}api/probe-results`;

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {import('vite').ViteDevServer} server
   * @returns {Promise<void>}
   */
  async function handle(req, res, server) {
    if (req.method !== "POST") {
      reply(res, 405, { error: "method", message: "POST the probe's JSON." });
      return;
    }
    const body = await readBody(req);
    if (body === null) {
      reply(res, 413, { error: "size", message: `Over ${SIZE_LIMIT} bytes.` });
      return;
    }
    /** @type {unknown} */
    let results;
    try {
      results = JSON.parse(body);
    } catch {
      reply(res, 400, { error: "json", message: "The body is not JSON." });
      return;
    }
    const name = resultsFileName(prefix, runOf(results), new Date());
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, name);
    await writeFile(file, body);
    server.config.logger.info(`probe results written to ${file}`);
    reply(res, 201, { file: path.relative(server.config.root, file) });
  }

  return {
    name: "desk-probe-results",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if ((req.url ?? "").split("?")[0] !== route) {
          next();
          return;
        }
        handle(req, res, server).catch((error) => {
          server.config.logger.error(`Could not save the probe's results: ${String(error)}`);
          if (res.headersSent) {
            res.end();
          } else {
            reply(res, 500, { error: "write", message: String(error) });
          }
        });
      });
    },
  };
}

/**
 * Which run `results` are, from their `scene`, or null if they name none.
 *
 * @param {unknown} results
 * @returns {string | null}
 */
function runOf(results) {
  if (typeof results !== "object" || results === null) {
    return null;
  }
  const { scene } = /** @type {{ scene?: unknown }} */ (results);
  return typeof scene === "string" ? scene : null;
}
