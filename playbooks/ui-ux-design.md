# UI/UX design playbook

Owner: frontend-engineer. `<engine>` = the directory of the hades CLI in your handover (`CLI: node <engine>/bin/hades.mjs`);
`<vault>` = the vault root (the Team folder path up to `/organizations/`); `hades` = that CLI line.
Output: `04-ux-design.md` with the skeleton in your agent prompt - design before code, `## UX review`
after code, before QA. Depth by size as your agent prompt states (S: a `## UX` section in
`05-impl-frontend.md`); the browser review is required for every visible change.

## 1. Inputs

- `CONTEXT.md`, your team notes, `01-business-solution.md` (Summary + `AC-n`),
  `02-technical-solution.md` (UI parts, API contracts, error codes), your items in `03-work-plan.md`.
- The project's UI layer: design tokens (CSS custom properties, Tailwind/theme config), component
  library, layout and page patterns, breakpoints, i18n setup, existing copy. Locate by symbol
  (`<engine>/playbooks/code-navigation.md`); open only what the screens need.

## 2. What each section of `04-ux-design.md` holds

- **Flows**: entry -> steps -> exit per flow, with back/cancel, error recovery and re-entry; every AC
  with a UI surface maps to a step or a state.
- **Screens**: route, purpose, layout pattern, components, data shown, AC refs.
- **States**: per screen empty, loading, error (recoverable + fatal), success, plus partial,
  disabled, offline and no-permission when the product has them; each with its copy and the user's
  next action.
- **Components**: reused first, new ones with props, variants, states; the tokens used. No
  design system: the minimal token set below, defined once (record it under DECISIONS). Never a
  new UI library for one screen.
- **Accessibility**: the WCAG 2.2 AA checklist (section 3), noting per screen what needs care.
- **Responsive**: the project's breakpoints (default 360 / 768 / 1024 / 1440 px), mobile first,
  what changes at each.
- **Copy**: exact strings per state (section 4); i18n keys and RTL notes (section 5) when localised.
- Assumptions go to DECISIONS in your return, not into a new section.

Minimal token set (only when the project has none), as CSS custom properties or the framework's
theme: colours `bg`, `surface`, `text`, `text-muted`, `border`, `primary`, `on-primary`, `focus`,
`success`, `warning`, `danger` (text pairs >= 4.5:1, UI parts and focus ring >= 3:1, checked by
calculation); spacing 4, 8, 12, 16, 24, 32, 48; radius 4, 8; type 12, 14, 16, 20, 24, 32 with body
line height 1.5; system font stack; two shadow levels; motion 150 / 250 ms, off under
`prefers-reduced-motion`; dark mode through the same token names when the product has it.

## 3. WCAG 2.2 AA checklist (the floor)

- **Perceivable**: text alternatives (1.1.1); semantic structure, landmarks, heading order, labelled
  fields (1.3.1); `autocomplete` on personal-data fields (1.3.5); not colour alone (1.4.1); text
  contrast >= 4.5:1, large text >= 3:1 (1.4.3); UI components and focus indicator >= 3:1 (1.4.11);
  usable at 200% zoom (1.4.4) and at 320 CSS px without horizontal scroll (1.4.10); text-spacing
  overrides do not break layout (1.4.12); hover/focus content dismissible and persistent (1.4.13).
- **Operable**: everything by keyboard, no traps (2.1.1, 2.1.2); skip link or landmarks (2.4.1);
  page titles (2.4.2); logical focus order (2.4.3); link purpose (2.4.4); descriptive headings and
  labels (2.4.6); visible focus (2.4.7) not hidden by sticky headers or overlays (2.4.11); no
  path-only gestures (2.5.1); pointer cancellation (2.5.2); visible label inside the accessible name
  (2.5.3); single-pointer alternative to dragging (2.5.7); targets >= 24x24 CSS px (2.5.8);
  adjustable time limits (2.2.1); pause for moving content (2.2.2); no flashing (2.3.1).
- **Understandable**: page `lang` (3.1.1) and language of parts (3.1.2); no context change on focus
  or input (3.2.1, 3.2.2); consistent navigation, naming and help location (3.2.3, 3.2.4, 3.2.6);
  errors identified in text with a fix suggestion (3.3.1, 3.3.3); labels and instructions (3.3.2);
  confirm or undo for legal, financial and data-deleting actions (3.3.4); no re-entering data already
  given (3.3.7); authentication without cognitive tests - allow paste and password managers (3.3.8).
- **Robust**: name, role, value for every control (4.1.2) - native elements first, ARIA only to
  fill gaps; status messages announced through live regions (4.1.3).

## 4. Copy

- Short, specific, sentence case; buttons are verbs naming the result ("Save changes", not "OK").
- Errors: what happened + how to fix, no blame, never a bare code; the user's input is kept.
- One term per concept (team `knowledge/glossary.md`); numbers, dates and currency via locale
  formatting; labels are never placeholders; no placeholder or lorem text ships.

## 5. i18n and RTL (when present)

- Every string through i18n keys with plural rules (ICU or the project's library); layouts allow
  30-40% text expansion.
- CSS logical properties (`margin-inline-start`, `padding-inline`, `inset-inline`, `text-align: start`),
  `dir` and `lang` on the root; mirror directional icons (arrows, chevrons), not logos or media
  controls; `Intl` for numbers and dates.
- Review at least one RTL locale in the browser (section 7).

## 6. Implementation checklist

- Tokens only; no raw colour or spacing values outside the token definitions.
- Native `button`, `a`, `input`, `label`, `dialog`, `details`; one `h1` per page; visible labels
  linked to inputs; inline errors linked by `aria-describedby`; focus moves to the first error on
  submit; double submit prevented.
- Dialogs trap focus, close on Esc and return focus to the opener; route changes update the title
  and move focus to the main heading.
- Mobile-first CSS, fluid widths, images with `width`/`height` (no layout shift) and responsive
  sources; motion behind `prefers-reduced-motion`.
- `data-testid` on interactive elements QA will automate (Playwright's default test-id attribute).
- No secrets in client code; no unsanitised HTML from data (`dangerouslySetInnerHTML`, `v-html`,
  `innerHTML`); external links `rel="noopener noreferrer"`.
- Component tests for each designed state and the key interactions, then the build gate.

## 7. Browser self-review (Playwright MCP)

Server `playwright` (`node <engine>/bin/hades.mjs mcp playwright`: headless, isolated profile).
Local or test origins only; test accounts from the project's seed or fixture files only; never
`browser_run_code_unsafe`.

1. Start the app with `team.json` `commands.run` in the background, then wait:
   `curl -fsS -m 5 --retry 20 --retry-delay 3 --retry-all-errors -o /dev/null http://localhost:<port>`.
2. Per screen and state: `browser_navigate`, trigger the state (empty data, failing or slow API
   through the app's mocks, invalid input via `browser_fill_form`), confirm with `browser_find`
   (text or regex) or `browser_verify_text_visible` rather than a full `browser_snapshot`; scope
   `browser_snapshot` with `depth` or `target` when structure matters.
3. Viewports: `browser_resize` 390x844 and 1440x900 (plus 768x1024 when the layout changes there);
   `browser_take_screenshot` without `filename` (saved in the server's output folder; cite the
   returned path). Look at one screenshot per screen per viewport for alignment, overflow,
   truncation, spacing and contrast; when the server omits images, Read the saved file.
4. Semantics and reflow, one `browser_evaluate` per screen (`function`):

   ```js
   () => { const q = s => [...document.querySelectorAll(s)];
     const named = e => (e.getAttribute('aria-label') || e.getAttribute('aria-labelledby') || e.textContent || e.title || '').trim() || e.querySelector('img[alt]:not([alt=""])');
     return { lang: document.documentElement.lang, title: document.title, h1: q('h1').length,
       headings: q('h1,h2,h3,h4,h5,h6').map(h => h.tagName[1]).join(''),
       imgNoAlt: q('img:not([alt])').length,
       unnamedControls: q('button,a[href],[role=button]').filter(e => !named(e)).length,
       unlabelledFields: q('input:not([type=hidden]),select,textarea').filter(e => !(e.labels && e.labels.length) && !e.getAttribute('aria-label') && !e.getAttribute('aria-labelledby')).length,
       horizontalScroll: document.documentElement.scrollWidth > window.innerWidth }; }
   ```

   Repeat at `browser_resize` 320x640: `horizontalScroll` must be false.
5. Keyboard: `browser_press_key` `Tab` through the first ~10 stops and any dialog; after each,
   `browser_evaluate` `() => { const e = document.activeElement; return e.tagName + ' ' + (e.getAttribute('aria-label') || e.textContent.trim().slice(0, 30)); }`.
   Order is logical, focus visible (one screenshot), Enter/Space activate, Esc closes, no trap.
6. `browser_emulate_media` `reducedMotion: 'reduce'` (and `colorScheme: 'dark'` when supported):
   nothing depends on motion, tokens hold.
7. `browser_console_messages` level `error`: zero. `browser_network_requests` with `filter` on the
   API path: no unexpected 4xx/5xx.
8. RTL locale (when present): steps 2-3 once at the mobile size.
9. Fix what you find in your own work and repeat the affected checks; issues in other roles' work
   go under `NEXT` (QA records defects). `browser_close`; stop the app.

`## UX review` rows: states per screen; mobile, desktop and 320 px reflow; keyboard order, focus,
Esc, no trap; semantics (lang, title, headings, names, labels, alt); contrast (token pairs);
reduced motion and dark mode; console errors and failed requests; copy matches 04, no placeholders;
RTL when present. Evidence = screenshot path or the evaluate result.
