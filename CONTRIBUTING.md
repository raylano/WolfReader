# Contributing

Thanks for helping make Wolfreader better! Bug reports, ideas and pull requests are welcome.

## Setup

```bash
npm install
npm start          # build + run the app
npm test           # unit tests
npm run test:picker  # end-to-end check of the chapter/page picker (needs xvfb-run on Linux)
```

Node.js 21 or newer is required. See [README.md](README.md#development) for the full
developer guide and [TESTING.md](TESTING.md) for the verification suite.

## Pull requests

- Keep changes focused; one topic per pull request.
- Add or update a test when behaviour changes (`test/unit` for logic in `src/shared`).
- Don't commit build output (`release/`, `node_modules/`) or books you don't have the rights to share.
- Describe what you changed and how you checked it.

## Releases

Maintainers: bump `version` in `package.json` and update `CHANGELOG.md`, then merge to `main`.
