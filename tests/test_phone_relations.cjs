"use strict";
const path = require("node:path");
const Module = require("node:module");
const esbuild = require("../mobile/panel/node_modules/esbuild");
const src = path.resolve(__dirname, "../mobile/panel/src");
// Reuse the panel's compiler without adding another test runner or disk artifacts.
for (const name of ["phoneConnectionRelations", "phoneConnectionFocus"]) {
  const filename = path.join(src, "utils/__tests__", name + ".test.ts");
  const result = esbuild.buildSync({entryPoints:[filename],bundle:true,write:false,platform:"node",format:"cjs",alias:{"@":src}});
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = module.paths;
  loaded._compile(result.outputFiles[0].text, filename);
}
