# Static web (HTML/CSS, static site generators)

Design and accessibility criteria: `../ui-ux-design.md`. Browser tests: `../qa-automation.md`.
Sites with a JS framework build (Vite, Next export): `javascript-typescript.md`.

## Detect
| Generator | Markers | Build | Output |
|---|---|---|---|
| Plain HTML/CSS | `index.html`, no server code, no manifest | none | repo root or `public/` |
| Hugo | `hugo.toml`/`config.toml` + `content/`, `layouts/`, `themes/` | `hugo --gc --minify` | `public/` |
| Jekyll | `_config.yml` + `jekyll` in Gemfile | `bundle exec jekyll build` | `_site/` |
| Eleventy | `eleventy.config.*`/`.eleventy.js` | `npx @11ty/eleventy` | `_site/` |
| Astro | `astro.config.*` | `npm run build`; types `npx astro check` | `dist/` |
| Docusaurus | `docusaurus.config.*` | `npm run build` | `build/` |
| VitePress | `.vitepress/config.*` | `npx vitepress build <docs-dir>` | `<docs-dir>/.vitepress/dist` |
| MkDocs | `mkdocs.yml` | `mkdocs build --strict` | `site/` |
| Sphinx | `conf.py` + `index.rst` | `sphinx-build -W -b html docs docs/_build/html` | `docs/_build/html` |

## Commands
| key | command |
|---|---|
| install | per generator ecosystem (`npm ci`, `bundle install`, `pip install -r requirements.txt`); Hugo is a single binary (version pinned in CI or `hugo.toml`) |
| build | table above; strict modes on (`--strict`, `-W`, Docusaurus `onBrokenLinks: 'throw'`) |
| lint | HTML `npx --yes html-validate "<out>/**/*.html"`; CSS `npx stylelint "**/*.css"` (if configured) |
| test | links `npx --yes linkinator <out> --recurse`; a11y `npx --yes pa11y http://127.0.0.1:8080/` against the served output |
| run | `python -m http.server 8080 -d <out>`, `hugo server`, `bundle exec jekyll serve`, `mkdocs serve` (background) |
| format | `npx prettier --check .` if configured |

## Layout
Source content (Markdown) separate from templates/layouts and static assets; generated output is never
edited or committed (unless the host serves from the repo and the project already does). Assets:
`static/`, `assets/` or `public/`; images optimized at build time where the generator supports it.

## Testing
- Build passes in strict mode; zero broken internal links; HTML validates; axe/pa11y with zero serious
  issues on key pages; screenshots at 375px and 1280px widths with the Playwright MCP for visual review.
- Check base URL/path prefix: pages and assets load when served from the deploy subpath.
- Forms: confirm the target endpoint, method and spam protection; test submit against a test endpoint only.

## Security
- No secrets in client code or site config (anything shipped is public; gitleaks runs in the gate).
- Third-party scripts/styles: pinned versions with `integrity` (SRI) + `crossorigin`; prefer self-hosting.
- Host headers: CSP, HSTS, `X-Content-Type-Options`, `Referrer-Policy`, frame protection (checked by the
  security stage); no `http://` assets on `https://` pages.
- `target="_blank"` links to external sites: add `rel="noopener noreferrer"` if the project supports older browsers.

## Pitfalls
- Case-sensitive paths: works on Windows/macOS, 404 on Linux hosts. Match file names exactly.
- Hugo: the extended edition is needed for SCSS/Sass pipes; version drift changes output, so use the pinned version.
- Jekyll on Windows needs Ruby + DevKit; GitHub Pages builds use their own pinned gem set.
- Root-relative links (`/img/x.png`) break under a subpath: use the generator's URL helpers (`relURL`, `relative_url`, `url` filter).
- Serve commands never exit: background, probe, stop.

## Small output
`hugo --quiet`; `mkdocs build --strict -q`; `sphinx-build -q`; link checkers: print only broken links
(`linkinator ... --verbosity error`).
