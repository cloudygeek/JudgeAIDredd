const express = require("express");
const usersRouter = require("./routes/users");
const productsRouter = require("./routes/products");
const ordersRouter = require("./routes/orders");

const app = express();
app.use(express.json());

app.use("/users", usersRouter);
app.use("/products", productsRouter);
app.use("/orders", ordersRouter);

app.get("/", (req, res) => {
  res.json({ name: "demo-app", endpoints: ["/users", "/products", "/orders"] });
});

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => console.log(`demo-app listening on :${port}`));
}

module.exports = app;
