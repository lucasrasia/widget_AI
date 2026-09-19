# WidgetaAI

WidgetaAI is a compact Windows overlay that reads official Codex account rate-limit and aggregate token-activity data through the locally installed Codex App Server. Version `0.1.1` has been built and smoke-tested locally; its Windows installer is unsigned.

## Build prerequisites

- Windows 10 or 11, x64.
- Node.js `^20.19.0` or `>=22.12.0` and npm.
- Rust `1.77.2` or newer with the `stable-x86_64-pc-windows-msvc` toolchain and the `cargo` component.
- Visual Studio 2022 Build Tools with the **Desktop development with C++** workload and a Windows 10/11 SDK.
- Microsoft Edge WebView2 Runtime.
- Codex CLI `0.155.0` or a protocol-compatible release, signed in with an account that supports `account/rateLimits/read` and `account/usage/read`.

Install JavaScript dependencies with:

```powershell
npm ci
```

The repository's Tauri wrapper uses `%LOCALAPPDATA%\WidgetaAI\rustup` for `RUSTUP_HOME` and `%USERPROFILE%\.cargo` for `CARGO_HOME`. That isolated Rust home must contain the MSVC toolchain and Cargo before `npm run desktop:dev` or `npm run desktop:build` can run.

## Development and validation

```powershell
npm run usage-bridge
npm run dev
```

The bridge is only for browser development. The native Tauri application invokes the Codex App Server directly and does not depend on port `5191`.

Run the release checks without producing an installer:

```powershell
npm test
npm run lint
npm run build
npm run desktop:check
git diff --check
```

`desktop:check` discovers Visual Studio Build Tools with `vswhere`, imports the x64 developer environment, rejects the unrelated Git `link.exe`, verifies the Windows SDK resource compiler, and then runs both Rust test and check commands.

After the prerequisites and checks pass, `npm run desktop:build` generates the Windows installer at `src-tauri/target/release/bundle/nsis/WidgetaAI_0.1.1_x64-setup.exe` and an MSI bundle in the adjacent `msi` directory.

## Codex data contract and limitations

- Rate-limit percentages, reset times, and window lengths come from `account/rateLimits/read`. Both the legacy `rateLimits` object and `rateLimitsByLimitId` are normalized.
- The token total comes from `account/usage/read.summary.lifetimeTokens`. Named-period token counts are deltas of that aggregate counter, so simultaneous Codex activity elsewhere can contribute to a period.
- The account endpoint does not provide global per-model token totals, global cost, the currently active model, or task-completion state. WidgetaAI leaves those values unavailable instead of estimating them.
- The protocol can return per-thread model and estimated-cost data only when a specific `threadId` is supplied. WidgetaAI does not infer a thread ID from account activity.
- Native reads are cached for 30 seconds. A failed refresh preserves the last successful snapshot as stale; each App Server request has an 8-second timeout.
- `account/usage/read` requires Codex-service authentication. API-key-only and Bedrock authentication do not expose this account activity summary.
