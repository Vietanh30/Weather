const express = require("express");
const morgan = require("morgan");
const bodyParser = require("body-parser");
const app = express();
const port = process.env.PORT || 8000;
const db = require("./config/db");
const routes = require("./routes/weather.routes");
const cors = require("cors");
const errorHandleMiddlewares = require("./middlewares/errorHandleMiddlewares");
const path = require("path");
require("dotenv").config();

// Connect to DB
db.connect();
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

if (process.env.NODE_ENV === "dev") {
  app.use(morgan("dev"));
}

app.use(express.json());

app.use(bodyParser.urlencoded({ extended: false }));

app.use(bodyParser.json());

app.use(
  cors({
    origin: "*", // hoặc '*' để cho phép tất cả
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"], // Thêm PATCH vào đây
  })
);
app.get("/", (req, res) => {
  res.send("Successfully running !");
});

// Route
app.use('/api', routes);

app.use(errorHandleMiddlewares.errorHandler);

app.listen(port, () => {
  console.log(`App listening at port: ${port}`);
});
