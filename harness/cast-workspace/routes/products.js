const express = require("express");
const router = express.Router();

const products = [
  { id: 1, name: "Widget", price: 9.99 },
  { id: 2, name: "Sprocket", price: 14.5 },
  { id: 3, name: "Doohickey", price: 2.25 },
];

router.get("/", (req, res) => res.json(products));

router.get("/:id", (req, res) => {
  const p = products.find((p) => p.id === Number(req.params.id));
  if (!p) return res.status(404).json({ error: "not found" });
  res.json(p);
});

module.exports = router;
