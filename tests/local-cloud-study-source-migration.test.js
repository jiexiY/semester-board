import assert from "node:assert/strict";
import test from "node:test";

import {
  buildLocalMigrationManifest,
  migrateLocalProfileToCloud,
} from "../src/lib/localCloudMigration.js";

const PROFILE_ID = "profile_local_12345678";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const COURSE_ID = "course_space_a_12345678";

function localSource(id = "source_local_12345678") {
  const blob = new Blob(["source"], { type: "text/plain" });
  return {
    blob,
    courseCode: "MAT 1100",
    courseSpaceId: COURSE_ID,
    fileName: "source.txt",
    id,
    lastModified: 1,
    mimeType: "text/plain",
    size: blob.size,
  };
}

function localSyllabus() {
  const blob = new Blob(["syllabus"], { type: "application/pdf" });
  return {
    blob,
    courseName: "MAT 1100",
    fileName: "syllabus.pdf",
    id: "syllabus_local_12345678",
    lastModified: 1,
    mimeType: "application/pdf",
    size: blob.size,
  };
}

test("migration manifest inventories dedicated Study Deck source files", async () => {
  const source = localSource();
  const syllabus = localSyllabus();
  const storage = {
    getItem() { return null; },
  };
  const manifest = await buildLocalMigrationManifest({
    listStudySourcesForProfile: async (profileId) => {
      assert.equal(profileId, PROFILE_ID);
      return [source];
    },
    listSyllabiForProfile: async (profileId) => {
      assert.equal(profileId, PROFILE_ID);
      return [syllabus];
    },
    profileId: PROFILE_ID,
    storage,
  });
  assert.equal(manifest.studySourceCount, 1);
  assert.equal(manifest.studySourceBytes, source.size);
  assert.deepEqual(manifest.studySources, [source]);
  assert.equal(manifest.syllabusCount, 1);
});

test("migration uploads source files with stable local identities before account state", async () => {
  const calls = [];
  const progress = [];
  const manifest = {
    resourceCount: 1,
    resources: { "dashboard:v1": { schemaVersion: 1 } },
    studySourceCount: 1,
    studySources: [localSource()],
    syllabusCount: 1,
    syllabi: [localSyllabus()],
  };
  const result = await migrateLocalProfileToCloud({
    addStudySource: async (_client, input, userId, options) => {
      calls.push(["source", input, userId, options]);
    },
    addSyllabus: async (_client, input, userId, options) => {
      calls.push(["syllabus", input, userId, options]);
    },
    client: {},
    cloudSync: {
      hasRemoteData: false,
      async importResources(resources) { calls.push(["resources", resources]); },
    },
    manifest,
    onProgress: (value) => progress.push(value),
    profileId: PROFILE_ID,
    userId: USER_ID,
  });

  assert.deepEqual(calls.map(([kind]) => kind), ["syllabus", "source", "resources"]);
  assert.equal(calls[0][3].sourceLocalId, `${PROFILE_ID}:syllabus_local_12345678`);
  assert.equal(calls[1][3].sourceLocalId, `${PROFILE_ID}:source_local_12345678`);
  assert.equal(calls[1][1].courseSpaceId, COURSE_ID);
  assert.deepEqual(progress, [
    { completedFiles: 0, currentKind: "syllabus", totalFiles: 2 },
    { completedFiles: 1, currentKind: "study-source", totalFiles: 2 },
  ]);
  assert.deepEqual(result, { resourceCount: 1, studySourceCount: 1, syllabusCount: 1 });
});

test("migration preflights every blob before making a remote write", async () => {
  let writes = 0;
  await assert.rejects(migrateLocalProfileToCloud({
    addStudySource: async () => { writes += 1; },
    addSyllabus: async () => { writes += 1; },
    client: {},
    cloudSync: { hasRemoteData: false, async importResources() { writes += 1; } },
    manifest: {
      resources: {},
      studySources: [{ ...localSource(), blob: null }],
      syllabi: [localSyllabus()],
    },
    profileId: PROFILE_ID,
    userId: USER_ID,
  }), /Study Deck source file is unavailable/);
  assert.equal(writes, 0);
});

test("a partial source migration retry reuses the same stable identities", async () => {
  const completed = new Set();
  const attempts = [];
  let failSecondOnce = true;
  const sources = [
    localSource("source_one_12345678"),
    localSource("source_two_12345678"),
  ];
  const addStudySource = async (_client, _input, _userId, { sourceLocalId }) => {
    attempts.push(sourceLocalId);
    if (sourceLocalId.endsWith("source_two_12345678") && failSecondOnce) {
      failSecondOnce = false;
      throw new Error("transient upload failure");
    }
    completed.add(sourceLocalId);
  };
  const manifest = { resourceCount: 0, resources: {}, studySources: sources, syllabi: [] };
  const base = {
    addStudySource,
    addSyllabus: async () => {},
    client: {},
    cloudSync: { hasRemoteData: false, async importResources() {} },
    manifest,
    profileId: PROFILE_ID,
    userId: USER_ID,
  };

  await assert.rejects(migrateLocalProfileToCloud(base), /transient upload failure/);
  await migrateLocalProfileToCloud(base);

  const firstId = `${PROFILE_ID}:source_one_12345678`;
  const secondId = `${PROFILE_ID}:source_two_12345678`;
  assert.deepEqual(attempts, [firstId, secondId, firstId, secondId]);
  assert.deepEqual([...completed].sort(), [firstId, secondId].sort());
});
