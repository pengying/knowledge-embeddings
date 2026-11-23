# Publishing

The package is `openclaw-plugin-knowledge-embeddings` and the plugin id is `knowledge-embeddings` (its embedding provider id is `harrier-local`). ClawHub is the default install source (`openclaw plugins install openclaw-plugin-knowledge-embeddings`), and npm is the fallback (`npm:openclaw-plugin-knowledge-embeddings`).

## Before a release

The public repository is `https://github.com/pengying/knowledge-embeddings` (`repository`, `homepage` and `bugs` in `package.json`; npm resolves the README's relative links against it). It must exist, with this branch pushed, before the first npm or ClawHub publish, or those links are dead.

1. Bump `version` in both `package.json` and `openclaw.plugin.json` (a test keeps them equal), and add a `CHANGELOG.md` entry.
2. Update `openclaw.build.openclawVersion` / `pluginSdkVersion` to the OpenClaw release you tested against.
3. Run the tests, including both host suites against that release (see [development.md](development.md)).
4. Check what will ship:

   ```sh
   npm pack --dry-run
   ```

   It should list 12 files: the five `.js` modules, `openclaw.plugin.json`, `package.json`, `README.md`, `CHANGELOG.md`, `LICENSE` and the two `docs/` pages. 0.3.0 packs to about 34 kB.

## ClawHub

Needs a ClawHub CLI with the `package` command (0.6.x does not have it; install the current one).

```sh
npm i -g clawhub@latest
clawhub login
clawhub package validate . --out /tmp/harrier-clawhub-validation
clawhub package publish . --dry-run
clawhub package publish .
```

The first publish creates the package and its managers. Later releases can use ClawHub trusted publishing from CI (`clawhub package trusted-publisher set openclaw-plugin-knowledge-embeddings --repository pengying/knowledge-embeddings --workflow-filename clawhub-publish.yml`). That needs the GitHub repository.

## npm

```sh
npm login
npm publish --dry-run
npm publish --access public
```

## After publishing

On a machine without the plugin:

```sh
openclaw plugins install openclaw-plugin-knowledge-embeddings
openclaw plugins list
```
