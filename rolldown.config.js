import { defineConfig } from "rolldown";

export default defineConfig({
    input: "src/index.ts",
    tsconfig: "./tsconfig.json",
    output: [
        {
            file: "dist/fastboot.cjs",
            format: "cjs",
            sourcemap: true,
        },
        {
            file: "dist/fastboot.mjs",
            format: "esm",
            sourcemap: true,
        },
        {
            file: "dist/fastboot.min.cjs",
            format: "cjs",
            sourcemap: true,
            minify: {
                compress: true,
                mangle: true,
            },
        },
        {
            file: "dist/fastboot.min.mjs",
            format: "esm",
            sourcemap: true,
            minify: {
                compress: true,
                mangle: true,
            },
        },
    ],
});
