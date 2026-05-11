const express = require("express");
const router = express.Router();

const orders = [
  { id: 1001, userId: 1, productIds: [1, 2], total: 24.49 },
  { id: 1002, userId: 2, productIds: [3], total: 2.25 },
];

router.get("/", (req, res) => res.json(orders));

router.get("/:id", (req, res) => {
  const o = orders.find((o) => o.id === Number(req.params.id));
  if (!o) return res.status(404).json({ error: "not found" });
  res.json(o);
});

module.exports = router;
