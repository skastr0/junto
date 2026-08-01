# Internal development

Vellum Command is **closed source, private, and solo-maintained**. This
repository is an internal engineering surface for authorized maintainers and
contractors. There is no public contribution program, public source
distribution, or supported build-from-source path for customers.

## Customer and security requests

Customers should use the [Vellum Command download page](https://vellumcommand.com/download)
for the signed application. Send security reports privately to
**support@vellumcommand.com**; do not open public issues or submit unsolicited
pull requests.

## Authorized development

```bash
bun install
bun run verify                 # security policy + brand + typecheck + tests + Vite compile
bun run app:build              # package the pinned Dodo Test beta app
bun run app:build:ship         # verify, notarize, and prepare signed macOS artifacts
```

The maintainer macOS ship loop (version bump → notarize → Cloudflare Worker/R2
feed) is documented in
[`docs/mac-release-runbook.md`](docs/mac-release-runbook.md)
(`bun run version:bump`, `bun run app:build:ship`,
`bun run mac:release:publish`). GitHub Releases are not part of the release
flow.

`app:build` and its platform/verification variants always produce the pinned
beta profile unless `--channel production` is explicit. Production packaging
requires `VELLUM_DODO_BUSINESS_ID` and `VELLUM_DODO_PRODUCT_ID`; packaged
development builds are rejected.

Before submitting an internal change:

- run `bun run verify`
- keep the diff focused
- obtain maintainer review before merging or publishing
- do not commit local state, secrets, scanner output, or `.groundwork/` sessions
