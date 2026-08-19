const fs = require("fs");
const path = require("path");

const src = path.join(__dirname, "..", "src", "renderer");
const dest = path.join(__dirname, "..", "out", "renderer");
fs.mkdirSync(dest, { recursive: true });
for (const file of ["index.html", "styles.css"]) {
  fs.copyFileSync(path.join(src, file), path.join(dest, file));
}

const mainOut = path.join(__dirname, "..", "out", "main");
fs.mkdirSync(mainOut, { recursive: true });
fs.copyFileSync(
  path.join(__dirname, "..", "src", "main", "pw-bridge.js"),
  path.join(mainOut, "pw-bridge.js"),
);
