import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const styles = (await readFile(new URL("../src/styles.css", import.meta.url), "utf8"))
  .replace(/\r\n/gu, "\n");
const app = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
const cloudGate = await readFile(new URL("../src/components/CloudAccountGate.jsx", import.meta.url), "utf8");

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function ruleBody(source, selector) {
  const match = source.match(new RegExp(`${escapeRegExp(selector)}\\s*\\{([^{}]*)\\}`));
  assert.ok(match, `Expected a CSS rule for ${selector}`);
  return match[1];
}

function hasDeclaration(body, property, value) {
  return new RegExp(`${escapeRegExp(property)}\\s*:\\s*${value}\\s*;`).test(body);
}

test("account and migration gates own a bounded, top-safe viewport scrollport", async () => {
  const gate = ruleBody(styles, ".profile-gate");
  const card = ruleBody(styles, ".profile-gate-card");

  assert.ok(hasDeclaration(gate, "height", "100dvh"));
  assert.ok(hasDeclaration(gate, "min-height", "0"));
  assert.ok(hasDeclaration(gate, "align-items", "start"));
  assert.ok(hasDeclaration(gate, "overflow-y", "auto"));
  assert.ok(hasDeclaration(gate, "scrollbar-gutter", "stable"));
  assert.ok(hasDeclaration(card, "margin-block", "auto"));

  for (const component of ["CloudAccountGate.jsx", "LocalProfileGate.jsx", "CloudMigrationBoundary.jsx"]) {
    const source = await readFile(new URL(`../src/components/${component}`, import.meta.url), "utf8");
    assert.match(source, /<main className="profile-gate"/);
  }
});

test("account confirmation resets its scroll position and keeps actions out of the icon column", () => {
  const confirmationChildren = ruleBody(styles, `.profile-gate-confirmation > .profile-gate-actions,
.profile-gate-confirmation > .profile-gate-error,
.profile-gate-confirmation > .profile-gate-notice`);
  const directSecondary = ruleBody(styles, ".profile-gate-empty > .profile-gate-secondary");
  const heading = ruleBody(styles, ".profile-gate-empty h3");

  assert.ok(hasDeclaration(confirmationChildren, "grid-column", String.raw`1\s*\/\s*-1`));
  assert.ok(hasDeclaration(confirmationChildren, "width", "100%"));
  assert.ok(hasDeclaration(confirmationChildren, "min-width", "0"));
  assert.ok(hasDeclaration(directSecondary, "grid-column", String.raw`1\s*\/\s*-1`));
  assert.ok(hasDeclaration(heading, "overflow-wrap", "anywhere"));
  assert.doesNotMatch(styles, /\.profile-gate-empty\s+\.profile-gate-secondary\s*\{/);

  assert.match(cloudGate, /className="profile-gate-empty profile-gate-confirmation"/);
  assert.match(cloudGate, /ref=\{gateRef\}/);
  assert.match(cloudGate, /gateRef\.current\.scrollTop\s*=\s*0/);
  assert.match(cloudGate, /focus\(\{\s*preventScroll:\s*true\s*\}\)/);
});

test("signed-in pages use the remaining-height stage instead of viewport subtraction", () => {
  const board = ruleBody(styles, ".board-app");
  const stage = ruleBody(styles, ".dashboard-stage");
  const viewport = ruleBody(styles, ".dashboard-page-viewport");
  const semester = ruleBody(styles, "#semester-page");

  assert.ok(hasDeclaration(board, "height", "100dvh"));
  assert.ok(hasDeclaration(board, "min-height", "0"));
  assert.ok(hasDeclaration(board, "grid-template-rows", "auto\\s+auto\\s+minmax\\(0,\\s*1fr\\)"));
  assert.doesNotMatch(board, /min-height\s*:\s*660px/);
  assert.ok(hasDeclaration(stage, "min-height", "0"));
  assert.ok(hasDeclaration(viewport, "min-height", "0"));
  assert.ok(hasDeclaration(semester, "min-height", "0"));
  assert.match(app, /className="dashboard-stage"/);
  assert.match(app, /className="dashboard-page-viewport"/);

  for (const [selector, overflowProperty] of [
    [".course-board", "overflow"],
    [".attendance-page", "overflow-y"],
    [".syllabus-page", "overflow-y"],
    [".study-deck-page", "overflow-y"],
  ]) {
    const page = ruleBody(styles, selector);
    assert.ok(hasDeclaration(page, "min-height", "0"), `${selector} can shrink inside the stage`);
    assert.ok(hasDeclaration(page, overflowProperty, "auto"), `${selector} remains a scroll owner`);
    assert.doesNotMatch(page, /calc\(100svh\s*-/);
  }
});

test("every desktop scroll owner leaves the final controls clear of the assistant", () => {
  const board = ruleBody(styles, ".board-app");
  assert.ok(hasDeclaration(board, "--dashboard-scroll-end", "112px"));

  for (const selector of [".course-board", ".attendance-page", ".syllabus-page"]) {
    const page = ruleBody(styles, selector);
    assert.match(page, /padding\s*:[^;]*var\(--dashboard-scroll-end\)\s*;/);
    assert.ok(hasDeclaration(page, "scroll-padding-bottom", "var\\(--dashboard-scroll-end\\)"));
  }

  const study = ruleBody(styles, ".study-deck-page");
  assert.match(study, /padding\s*:[^;]*130px\s*;/);
  assert.ok(hasDeclaration(study, "scroll-padding-bottom", "130px"));
});

test("sticky course headers fully occlude scrolled timeline content", () => {
  const header = ruleBody(styles, ".aligned-header-row");

  assert.ok(hasDeclaration(header, "isolation", "isolate"));
  assert.ok(hasDeclaration(header, "position", "sticky"));
  assert.ok(hasDeclaration(header, "z-index", "20"));
  assert.ok(hasDeclaration(header, "top", "0"));
  assert.ok(
    hasDeclaration(
      header,
      "background",
      String.raw`linear-gradient\(180deg,\s*#eff7ff\s+0%,\s*#eef5ff\s+100%\)`,
    ),
  );
  assert.doesNotMatch(header, /transparent|rgba\([^)]*,\s*0?\.\d+\)/);
  assert.ok(hasDeclaration(header, "backdrop-filter", "none"));
  assert.ok(hasDeclaration(header, "-webkit-backdrop-filter", "none"));
});

test("modal sheets prevent dashboard content from bleeding through", () => {
  const layer = ruleBody(styles, ".sheet-layer");
  const sheet = ruleBody(styles, ".glass-sheet");
  const stickyHeader = ruleBody(styles, ".aligned-header-row");

  assert.ok(hasDeclaration(layer, "position", "fixed"));
  assert.ok(hasDeclaration(layer, "inset", "0"));
  assert.ok(Number(layer.match(/z-index\s*:\s*(\d+)/)?.[1]) > Number(stickyHeader.match(/z-index\s*:\s*(\d+)/)?.[1]));
  assert.ok(hasDeclaration(sheet, "background", "#f7fbff"));
  assert.doesNotMatch(sheet, /background\s*:\s*rgba\(/);
  assert.ok(hasDeclaration(sheet, "backdrop-filter", "none"));
  assert.ok(hasDeclaration(sheet, "-webkit-backdrop-filter", "none"));
});

test("mobile pages consistently yield to document scrolling without stacked sticky navigation", () => {
  const mobileStart = styles.indexOf("@media (max-width: 760px)", styles.indexOf(".board-app"));
  const mobileEnd = styles.indexOf("@media (max-width: 520px)", mobileStart);
  assert.notEqual(mobileStart, -1);
  assert.notEqual(mobileEnd, -1);
  const mobile = styles.slice(mobileStart, mobileEnd);

  const board = ruleBody(mobile, ".board-app");
  assert.ok(hasDeclaration(board, "display", "block"));
  assert.ok(hasDeclaration(board, "height", "auto"));
  assert.ok(hasDeclaration(board, "overflow", "visible"));

  const boardOrb = ruleBody(mobile, ".board-app::after");
  assert.ok(hasDeclaration(boardOrb, "bottom", "0"), "the mobile background orb cannot extend the document end");

  for (const selector of [".assignment-deck-page", ".study-deck-page", ".attendance-page", ".syllabus-page", ".course-board"]) {
    const page = ruleBody(mobile, selector);
    assert.ok(hasDeclaration(page, "height", "auto"), `${selector} expands with its content on mobile`);
    assert.ok(hasDeclaration(page, "overflow", "visible"), `${selector} does not trap mobile scrolling`);
  }

  const courseSwitcher = ruleBody(mobile, ".mobile-course-switcher");
  assert.ok(hasDeclaration(courseSwitcher, "position", "relative"));
  assert.ok(hasDeclaration(courseSwitcher, "top", "auto"));

  const header = ruleBody(mobile, ".aligned-header-row");
  assert.ok(hasDeclaration(header, "position", "relative"));
  assert.ok(hasDeclaration(header, "background", "transparent"));
  assert.ok(hasDeclaration(header, "backdrop-filter", "none"));
});
