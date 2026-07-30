import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { store } from "@apendua.dev/signal";
import { createServer } from "./server.js";
import { todos } from "./todos.js";

/**
 * @import { Server } from "node:http";
 */

/** @type {Server} */
let server;

/** @type {string} */
let baseUrl;

describe("server", () => {
  before(async () => {
    server = await new Promise((resolve) => {
      const listening = createServer().listen(0, () => {
        resolve(listening);
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected the server to listen on a tcp port");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve(undefined)));
    });
  });

  beforeEach(() => {
    todos.set([store({ id: "1", text: "Only todo", completed: false })]);
  });

  /**
   * @param {string} path
   * @param {Record<string, string>} body
   * @returns {Promise<Response>}
   */
  function post(path, body) {
    return fetch(`${baseUrl}${path}`, {
      method: "POST",
      body: new URLSearchParams(body),
      redirect: "manual",
    });
  }

  it("should serve the rendered page", async () => {
    const response = await fetch(`${baseUrl}/`);

    assert.strictEqual(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await response.text(), /1\. Only todo/);
  });

  it("should render the filter taken from the query string", async () => {
    const html = await (await fetch(`${baseUrl}/?filter=completed`)).text();

    assert.match(html, /aria-current="page"/);
    assert.match(html, /1 of 1 remaining/);
    assert.doesNotMatch(html, /Only todo/);
  });

  it("should add a todo and redirect back, preserving the filter", async () => {
    const response = await post("/todos", { text: "Added over http", filter: "active" });

    assert.strictEqual(response.status, 302);
    assert.strictEqual(response.headers.get("location"), "/?filter=active");
    assert.match(await (await fetch(`${baseUrl}/`)).text(), /2\. Added over http/);
  });

  it("should toggle a todo", async () => {
    const response = await post("/todos/1/toggle", {});

    assert.strictEqual(response.status, 302);
    assert.match(await (await fetch(`${baseUrl}/`)).text(), /0 of 1 remaining/);
  });

  it("should delete a todo", async () => {
    const response = await post("/todos/1/delete", {});

    assert.strictEqual(response.status, 302);
    assert.match(await (await fetch(`${baseUrl}/`)).text(), /0 of 0 remaining/);
  });
});
