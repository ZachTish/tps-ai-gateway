import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", ...builtins],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: process.argv[2] === "production" ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  minify: process.argv[2] === "production",
});
if (process.argv[2] === "production") {
  await context.rebuild();
  process.exit(0);
}
await context.watch();
