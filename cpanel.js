"use strict";

const {createServer} = require("./server");

const port = Number.parseInt(process.env.PORT, 10) || 3000;
createServer().listen(port, () => console.log(`Sandboxed listening on port ${port}`));
