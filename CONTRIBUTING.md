# Contributing

Thanks for helping improve Vellum Command.

**Vellum Command** is **solo-maintained**. The default contribution path is **issues first**, not unsolicited large pull requests.

## Good Issues

Open an issue when you can provide:

- a clear problem statement
- reproduction steps or a minimal example
- expected behavior
- actual behavior
- version / release tag, macOS version, and hardware arch (arm64 / x64)

For proposals, include the maintenance cost: what this adds, removes, or makes harder to support.

## Pull Requests

Small pull requests for clear bugs, documentation corrections, and agreed follow-ups are welcome.

Before opening a larger pull request:

1. Open an issue.
2. Wait for maintainer confirmation that the change fits the product.
3. Keep the implementation scoped to the accepted behavior.

Unsolicited large rewrites, new subsystems, broad formatting changes, generated churn, or unrelated dependency updates may be closed without review.

## Development

```bash
bun install
bun run verify          # typecheck + unit tests + vite compile
bun run app:build       # package signed macOS app + zip/dmg
```

Before submitting:

- run `bun run verify`
- keep the diff focused
- do not commit local state, secrets, scanner output, or `.groundwork/` sessions
