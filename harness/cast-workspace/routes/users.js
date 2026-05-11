const express = require("express");
const router = express.Router();

const users = [
  { id: 1, name: "Ada Lovelace", email: "ada@example.com" },
  { id: 2, name: "Grace Hopper", email: "grace@example.com" },
];

router.get("/", (req, res) => res.json(users));

router.get("/:id", (req, res) => {
  const u = users.find((u) => u.id === Number(req.params.id));
  if (!u) return res.status(404).json({ error: "not found" });
  res.json(u);
});

module.exports = router;
