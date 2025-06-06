import { defineConfig } from "eslint/config";
import globals from "globals";
import path from "node:path";
import { fileURLToPath } from "node:url";
import js from "@eslint/js";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const compat = new FlatCompat({
    baseDirectory: __dirname,
    recommendedConfig: js.configs.recommended,
    allConfig: js.configs.all
});

export default defineConfig([{
    extends: compat.extends("eslint:recommended"),

    languageOptions: {
        globals: {
            ...globals.node,
        },

        ecmaVersion: 2020,
        sourceType: "module",
    },

    rules: {
        curly: 0,
        "eol-last": 2,
        "no-trailing-spaces": 2,
        "no-unused-vars": 2,

        "no-use-before-define": [2, {
            functions: false,
            classes: true,
        }],

        "no-underscore-dangle": 0,
        "new-cap": 0,

        yoda: [2, "never", {
            exceptRange: true,
        }],

        quotes: 0,
        "comma-dangle": 0,
        "space-infix-ops": 0,
        "no-console": 0,
        "no-alert": 2,
        "no-array-constructor": 2,
        "no-caller": 2,
        "no-catch-shadow": 2,

        "no-eval": [2, {
            allowIndirect: true,
        }],

        "no-extend-native": 2,
        "no-extra-bind": 2,
        "no-implied-eval": 2,
        "no-iterator": 2,
        "no-label-var": 2,
        "no-labels": 2,
        "no-lone-blocks": 2,
        "no-loop-func": 2,
        "no-multi-spaces": 2,
        "no-multi-str": 2,
        "no-native-reassign": 2,
        "no-new": 2,
        "no-new-func": 2,
        "no-new-object": 2,
        "no-new-wrappers": 2,
        "no-octal-escape": 2,
        "no-process-exit": 2,
        "no-proto": 2,
        "no-return-assign": 2,
        "no-script-url": 2,
        "no-sequences": 2,
        "no-shadow": 2,
        "no-shadow-restricted-names": 2,
        "no-spaced-func": 2,
        "no-undef-init": 2,
        "no-unused-expressions": 2,
        "no-var": 2,
        "no-with": 2,
        camelcase: [2, {
            properties: "never"
        }],
        "comma-spacing": 2,
        "consistent-return": 2,

        "dot-notation": [2, {
            allowKeywords: true,
        }],

        "no-extra-parens": [2, "functions"],
        eqeqeq: 2,

        "key-spacing": [2, {
            beforeColon: false,
            afterColon: true,
        }],

        "new-parens": 2,
        semi: 2,

        "semi-spacing": [2, {
            before: false,
            after: true,
        }],

        "keyword-spacing": 2,

        "space-unary-ops": [2, {
            words: true,
            nonwords: false,
        }],
    },
}]);
