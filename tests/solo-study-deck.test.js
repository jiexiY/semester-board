import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appSource = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
const studyDeckSource = await readFile(new URL("../src/components/StudyDeckPage.jsx", import.meta.url), "utf8");
const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

test("Study Deck is a standalone route instead of a Semester Board tab", () => {
  assert.match(appSource, /window\.location\.pathname\.replace[\s\S]*=== "\/study-deck"/u);
  const pagesStart = appSource.indexOf("const DASHBOARD_PAGES");
  const pagesEnd = appSource.indexOf("function PageSwitcher", pagesStart);
  const dashboardPages = appSource.slice(pagesStart, pagesEnd);
  assert.doesNotMatch(dashboardPages, /id:\s*"study"/u);
  assert.doesNotMatch(appSource, /activePage\s*===\s*"study"/u);
  assert.match(appSource, /function SoloStudyDeck/u);
  assert.match(appSource, /className="solo-study-deck-app"/u);
});

test("standalone Study Deck keeps private profile, sources, and generation wiring", () => {
  assert.match(appSource, /useStudySourceLibrary\(/u);
  assert.match(appSource, /useStudyGenerator\(/u);
  assert.match(appSource, /onStudyDeckState=\{dashboard\.saveStudyDeck\}/u);
  assert.match(appSource, /onAddSourceFiles=\{studySources\.addFiles\}/u);
  assert.match(appSource, /onGenerateStudyDeck=\{studyGenerator\.generate\}/u);
  assert.match(appSource, /Enable AI generation/u);
});

test("course creation appears before generation controls in the standalone working surface", () => {
  const renderStart = studyDeckSource.indexOf('<main aria-labelledby="study-deck-title"');
  const courseManager = studyDeckSource.indexOf("<CourseSpaceManager", renderStart);
  const generationSetup = studyDeckSource.indexOf("<GenerationSetup", renderStart);
  assert.ok(renderStart >= 0);
  assert.ok(courseManager > renderStart);
  assert.ok(generationSetup > courseManager);
});

test("standalone shell owns a bounded desktop viewport and yields to mobile scrolling", () => {
  assert.match(styles, /\.solo-study-deck-app\s*\{[^}]*height:\s*100dvh[^}]*overflow:\s*hidden/su);
  assert.match(styles, /@media \(max-width: 760px\)[\s\S]*\.solo-study-deck-app\s*\{[^}]*height:\s*auto[^}]*overflow:\s*visible/su);
});
