const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const app = require("../server");

function get(server, path) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port: server.address().port, path, method: "GET" },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(body || "null") }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

test("GET /users returns the seeded list", async () => {
  const server = app.listen(0);
  try {
    const r = await get(server, "/users");
    assert.strictEqual(r.status, 200);
    assert.ok(Array.isArray(r.body));
    assert.strictEqual(r.body.length, 2);
  } finally {
    server.close();
  }
});

test("GET /users/:id returns the right user", async () => {
  const server = app.listen(0);
  try {
    const r = await get(server, "/users/1");
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.name, "Ada Lovelace");
  } finally {
    server.close();
  }
});

test("GET /users/999 returns 404", async () => {
  const server = app.listen(0);
  try {
    const r = await get(server, "/users/999");
    assert.strictEqual(r.status, 404);
  } finally {
    server.close();
  }
});
