# Extension Loading

This document records how Agentaz currently loads the Pi extensions it needs:

- `@juicesharp/rpiv-todo`: TODO tool and widget.
- `@gotgenes/pi-permission-system`: tool-call permission enforcement and browser approval prompts.

## Current Approach

Agentaz uses Pi-managed packages, not app-level npm dependencies, for these extensions.

The extensions are not declared in `apps/web/package.json`. Instead, the backend ensures the configured Pi agent directory has global Pi package settings before creating Pi SDK services. This matches the Pi CLI default behavior.

Current required package sources:

```json
[
  "npm:@juicesharp/rpiv-todo",
  "npm:@gotgenes/pi-permission-system"
]
```

The implementation lives in:

```txt
apps/web/server/utils/pi-required-packages.ts
apps/web/server/utils/pi-session-workspace.ts
```

`PiSessionWorkspace` calls `ensureRequiredPiPackages(agentDir)` before `createAgentSessionServices()`. That writes or updates:

```txt
<agentDir>/settings.json
```

with:

```json
{
  "packages": [
    "npm:@juicesharp/rpiv-todo",
    "npm:@gotgenes/pi-permission-system"
  ]
}
```

When Pi services are created, the Pi SDK reads that settings file, installs missing `npm:` packages into:

```txt
<agentDir>/npm/node_modules/
```

and loads extension entrypoints from the packages' Pi manifests:

```txt
<agentDir>/npm/node_modules/@juicesharp/rpiv-todo/index.ts
<agentDir>/npm/node_modules/@gotgenes/pi-permission-system/src/index.ts
```

The SDK uses `jiti` to load TypeScript extension entrypoints, so these packages do not need to be compiled into Agentaz's Nitro output.

## Why This Approach

This matches Pi's native extension lifecycle:

- Pi owns package installation and extension discovery.
- TypeScript-source Pi packages work without extra Nitro bundling.
- Package, auth, model, and global extension config state follow the configured Pi agent directory.
- Agentaz no longer relies on `apps/web/node_modules` for runtime extension discovery.
- Agentaz does not create project-local `<cwd>/.pi` files by default.

The first run with a new Pi agent directory may need network access because Pi installs missing packages during resource loading. Once installed, packages live under the agent directory's `npm/node_modules`.

## Permission Config

The permission extension package and the permission policy config are separate concerns.

Agentaz creates the global permission config in the Pi agent directory:

```txt
<agentDir>/extensions/pi-permission-system/config.json
```

That file is created by:

```txt
apps/web/server/utils/permission-config.ts
```

and read by `@gotgenes/pi-permission-system` after the extension is loaded. If the extension package is not loaded, the config file has no effect.

## Verification

Minimum verification after changes:

```bash
pnpm typecheck
```

To verify extension loading with an isolated working directory:

```bash
mkdir -p _debug_workspace/workspace _debug_workspace/.pi/agent
PI_WEB_CWD="$PWD/_debug_workspace/workspace" \
PI_CODING_AGENT_DIR="$PWD/_debug_workspace/.pi/agent" \
pnpm dev
```

Expected global Pi agent settings:

```txt
_debug_workspace/.pi/agent/settings.json
```

Expected installed package roots after Pi resolves resources:

```txt
_debug_workspace/.pi/agent/npm/node_modules/@juicesharp/rpiv-todo
_debug_workspace/.pi/agent/npm/node_modules/@gotgenes/pi-permission-system
```

In a direct SDK check, the loaded extension paths should include:

```txt
_debug_workspace/.pi/agent/npm/node_modules/@juicesharp/rpiv-todo/index.ts
_debug_workspace/.pi/agent/npm/node_modules/@gotgenes/pi-permission-system/src/index.ts
```

## Previous Approach

Agentaz previously had a partial bundled approach:

- `@juicesharp/rpiv-todo` was listed in `apps/web/package.json`.
- `PiSessionWorkspace` resolved the app dependency with `require.resolve("@juicesharp/rpiv-todo/package.json")`.
- The resolved package root was passed through `resourceLoaderOptions.additionalExtensionPaths`.
- `@gotgenes/pi-permission-system` was listed as an app dependency, but Agentaz did not explicitly load it.
- Agentaz then briefly seeded project-local `<cwd>/.pi/settings.json` for required packages before switching to the Pi CLI-style agent-dir default.

That was inconsistent:

- The TODO extension depended on app `node_modules`.
- The permission extension only had a config file and was not guaranteed to load.
- Nitro production output did not reliably contain these dynamic extension packages.
- Project-local package seeding created `<cwd>/.pi` even though the Pi CLI defaults to the global agent directory.

The old `additionalExtensionPaths` logic and duplicate-checking helpers have been removed. Agentaz now seeds required packages in `<agentDir>/settings.json`.

## Future Option: App-Bundled Extensions

An app-bundled extension strategy is still possible, but it is not the current baseline.

That future plan would reintroduce the extension packages as app-level dependencies in `apps/web/package.json` and make the production server output self-contained.

Likely requirements:

1. Add these dependencies back to `apps/web/package.json`:

```json
{
  "dependencies": {
    "@juicesharp/rpiv-todo": "...",
    "@gotgenes/pi-permission-system": "..."
  }
}
```

2. Configure Nitro or a postbuild step to copy the extension packages and their runtime dependency closure into:

```txt
apps/web/.output/server/node_modules/
```

3. Pass app-bundled package roots to Pi through `resourceLoaderOptions.additionalExtensionPaths`.

4. Handle package-root resolution carefully:

- `@juicesharp/rpiv-todo/package.json` can be resolved directly.
- `@gotgenes/pi-permission-system/package.json` is not exported by its package `exports` map, so package root resolution must derive from an exported entry or use a copied filesystem path.

This would avoid first-run Pi package installation, but Agentaz would then own bundling and copying the extension dependency closure correctly. Until that is needed, Pi-managed packages are simpler and closer to the SDK's native extension model.
