# Next steps — manual one-time setup

The registry's automatic service detection found **no required external service** wired
into the current CI (`.github/workflows/ci.yml` runs `npm ci → build → test` only, no
publish step). The build is self-contained and runs locally today.

The steps below are **optional distribution setup** — do them when you're ready to ship
`npx agentguard` publicly. They are not required for local use (`npm install && npm run
build && node dist/cli.js scan .`).

## npm (to enable `npx agentguard`)

The product's headline UX is `npx agentguard scan .`, which requires the package
published to the npm registry.

1. Create an npm account + an automation access token: <https://www.npmjs.com/settings/~/tokens>
2. Confirm the package name `agentguard` is available (`npm view agentguard`). If taken,
   rename in `package.json` (e.g. a scoped name `@<you>/agentguard`).
3. Local first publish: `npm login && npm publish --access public`.
4. (Optional) Add a release job to `ci.yml` using `JS-DevTools/npm-publish` with an
   `NPM_TOKEN` repo secret so tagged releases publish automatically.

## GitHub repo + release

1. `gh repo create agentguard --public --source . --remote origin --push`
2. Tag the release: `git tag v0.1.0 && git push origin v0.1.0`
3. `gh release create v0.1.0 --generate-notes`

## Demo asset (assets/demo.cast)

`assets/demo.tape` is the recording script. To produce the `.cast` for the README's
asciinema slot, run (locally, interactively):

```bash
asciinema rec assets/demo.cast -c "node dist/cli.js scan test/fixtures"
# or with vhs: vhs assets/demo.tape
```

A headless build can't record a terminal session, so the `.cast` currently ships as a
placeholder — re-record before the launch post.

## Commercial tier (per go_to_market.md §8)

The README documents a paid team/CI tier (hosted scan history + org-wide badge registry +
maintained signature feed). No backend exists in v0.1 — that's the post-launch build.
The free CLI + `badge` command seed the registry's viral loop first.
