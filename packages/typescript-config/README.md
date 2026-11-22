# `@workspace/typescript-config`

Shared TypeScript configuration for the workspace. Targets **TypeScript 7**.

| Config               | Extend it from            |
| -------------------- | ------------------------- |
| `base.json`          | plain TypeScript packages |
| `nextjs.json`        | Next.js apps              |
| `react-library.json` | React component libraries |

Notes for TypeScript 7:

- `strict` is on. It is now the compiler default, but stays explicit here so the intent survives a future default change. Individual packages should not re-declare `strictNullChecks` — `strict` covers it.
- `esModuleInterop` and `allowSyntheticDefaultImports` are deliberately absent: TypeScript 7 removed the ability to disable them, so setting them is a no-op and setting them to `false` is a hard error.
- Options removed in TypeScript 7 that must not be reintroduced: `baseUrl` (use `paths`, resolved relative to the config file), `downlevelIteration`, `target: es5`, `moduleResolution: node10`/`classic`, and `module: amd`/`umd`/`systemjs`/`none`.
