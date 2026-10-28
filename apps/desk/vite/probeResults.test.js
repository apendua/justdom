import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import ProbeResultsPlugin, { resultsFileName } from "./probeResults.js";

const TIME = new Date("2026-10-21T19:56:17.123Z");

describe("resultsFileName", () => {
  it("names the run between the prefix and the time", () => {
    expect(resultsFileName("paint-order-probe", "hover-paint", TIME)).toBe(
      "paint-order-probe-hover-paint-2026-10-21T19-56-17-123Z.json",
    );
  });

  it("leaves the label out when there is none", () => {
    expect(resultsFileName("paint-order-probe", null, TIME)).toBe(
      "paint-order-probe-2026-10-21T19-56-17-123Z.json",
    );
    expect(resultsFileName("paint-order-probe", "", TIME)).toBe(
      "paint-order-probe-2026-10-21T19-56-17-123Z.json",
    );
  });

  it("keeps a label that names a path inside the directory", () => {
    expect(resultsFileName("p", "../../etc/passwd", TIME)).toBe(
      "p-etc-passwd-2026-10-21T19-56-17-123Z.json",
    );
    expect(resultsFileName("p", "Flip90 Paint/Order", TIME)).toBe(
      "p-flip90-paint-order-2026-10-21T19-56-17-123Z.json",
    );
  });

  it("cuts a long label to 40 characters", () => {
    const name = resultsFileName("p", "a".repeat(100), TIME);
    expect(name).toBe(`p-${"a".repeat(40)}-2026-10-21T19-56-17-123Z.json`);
  });

  it("leaves no dash before the time when the cut ends on one", () => {
    expect(resultsFileName("p", `${"a".repeat(39)}-bbbb`, TIME)).toBe(
      `p-${"a".repeat(39)}-2026-10-21T19-56-17-123Z.json`,
    );
  });
});

/**
 * The route's middleware, on a server whose logger says nothing, writing
 * to `dir`.
 *
 * @param {string} dir
 */
function route(dir) {
  /** @type {(req: object, res: object, next: () => void) => void} */
  let middleware = () => {};
  const plugin = ProbeResultsPlugin({ dir, base: "/apps/desk/", prefix: "probe" });
  const server = {
    middlewares: { use: (/** @type {typeof middleware} */ fn) => (middleware = fn) },
    config: { root: dir, logger: { info: () => {}, error: () => {} } },
  };
  /** @type {any} */ (plugin.configureServer)(server);
  return middleware;
}

/**
 * Send `body` to `middleware` as `method` at `url`, and the reply, or
 * `next` if the middleware passed the request on.
 *
 * @param {(req: object, res: object, next: () => void) => void} middleware
 * @param {string} url
 * @param {string} [method]
 * @param {string} [body]
 * @returns {Promise<{ status: number, body: any } | "next">}
 */
function send(middleware, url, method = "POST", body = "") {
  return new Promise((done) => {
    const req = {
      url,
      method,
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(body);
      },
    };
    const res = {
      statusCode: 0,
      headersSent: false,
      setHeader() {},
      end(/** @type {string} */ text) {
        done({ status: res.statusCode, body: JSON.parse(text) });
      },
    };
    middleware(req, res, () => done("next"));
  });
}

describe("the probe-results route", () => {
  /** @type {string} */
  let dir;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "probe-results-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("passes on a request whose target is no URL", async () => {
    expect(await send(route(dir), "//", "GET")).toBe("next");
  });

  it("names the file by the body's scene", async () => {
    const reply = await send(
      route(dir),
      "/apps/desk/api/probe-results",
      "POST",
      JSON.stringify({ scene: "hover", runs: [] }),
    );
    expect(reply).toMatchObject({ status: 201 });
    const files = await readdir(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^probe-hover-\d{4}-.*\.json$/);
  });

  it("answers 500 when the file cannot be written", async () => {
    // A file where the directory should be, so making it fails.
    const blocked = join(dir, "blocked");
    await writeFile(blocked, "");
    const reply = await send(route(blocked), "/apps/desk/api/probe-results", "POST", "{}");
    expect(reply).toMatchObject({ status: 500 });
  });
});
