module.exports = {
  parser: "eslint-plugin-typescript/parser",
  parserOptions: { sourceType: "module" },
  extends: "pureprofile",
  env: { es6: true, node: true },
  plugins: ["typescript"],
  rules: {
    "indent": "off",
    "typescript/indent": ["error", 4, { "SwitchCase": 1 }],
    "quotes": ["error", "double"],
    "no-const-assign": 0, // conflicts with ts
    "no-extra-parens": 0, // conflicts with ts
    "no-param-reassign": 0, // remove later
    "no-undef": 0, // conflicts with ts
    "no-undefined": 0, // conflicts with ts
    "no-unused-expressions": 0, // conflicts with ts
    "no-unused-vars": 0, // conflicts with ts
    "no-use-before-define": 0, // conflicts with ts
    "require-await": 0, // this doesn"t work well with our express async middleware
    "sort-imports": 0, // this is too much effort to fix
    "space-infix-ops": 0, // conflicts with ts
    "linebreak-style": 0 // too many warnings
  },
  globals: {
    ___dirname: false
  }
};
