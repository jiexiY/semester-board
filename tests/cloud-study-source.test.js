import assert from "node:assert/strict";
import test from "node:test";

import {
  STUDY_SOURCE_BUCKET,
  addCloudStudySource,
  assertOwnedStudySourceRecord,
  cloudStudySourcePath,
  deleteCloudStudySource,
  isOwnedStudySourcePath,
  listCloudStudySources,
} from "../src/lib/cloudStudySourceStorage.js";

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const COURSE_A = "course_space_a_12345678";
const COURSE_B = "course_space_b_12345678";

function sourceInput(overrides = {}) {
  return {
    courseCode: "MAT 1100",
    courseSpaceId: COURSE_A,
    file: {
      lastModified: 0,
      name: "reading.pdf",
      size: 4,
      type: "application/pdf",
    },
    ...overrides,
  };
}

function sourceRow(overrides = {}) {
  return {
    course_code: "MAT 1100",
    course_space_id: COURSE_A,
    created_at: "2026-08-30T20:00:00.000Z",
    file_name: "reading.pdf",
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    mime_type: "application/pdf",
    size_bytes: 4,
    storage_path: `${USER_A}/${COURSE_A}/record_12345678/source.pdf`,
    user_id: USER_A,
    ...overrides,
  };
}

function sourceRecord(overrides = {}) {
  return {
    cloud: true,
    courseCode: "MAT 1100",
    courseSpaceId: COURSE_A,
    fileName: "reading.pdf",
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    profileId: USER_A,
    recordKind: "study-source",
    size: 4,
    storagePath: `${USER_A}/${COURSE_A}/record_12345678/source.pdf`,
    ...overrides,
  };
}

test("cloud source paths are owner and course scoped and reject traversal", () => {
  assert.equal(
    cloudStudySourcePath(USER_A, COURSE_A, "record_12345678", "PDF"),
    `${USER_A}/${COURSE_A}/record_12345678/source.pdf`,
  );
  for (const call of [
    () => cloudStudySourcePath(`${USER_A}/../${USER_B}`, COURSE_A, "record_12345678", "pdf"),
    () => cloudStudySourcePath(USER_A, `${COURSE_A}/../${COURSE_B}`, "record_12345678", "pdf"),
    () => cloudStudySourcePath(USER_A, COURSE_A, "../record_12345678", "pdf"),
    () => cloudStudySourcePath(USER_A, COURSE_A, "record_12345678", "pdf/../txt"),
  ]) assert.throws(call);
});

test("ownership helpers require both the authenticated owner and course space", () => {
  const record = sourceRecord();
  assert.equal(isOwnedStudySourcePath(record.storagePath, USER_A, COURSE_A), true);
  assert.equal(isOwnedStudySourcePath(record.storagePath, USER_A, COURSE_B), false);
  assert.equal(isOwnedStudySourcePath(record.storagePath, USER_B, COURSE_A), false);
  assert.deepEqual(assertOwnedStudySourceRecord(record, USER_A, COURSE_A), {
    owner: USER_A,
    space: COURSE_A,
  });
  assert.throws(
    () => assertOwnedStudySourceRecord(record, USER_A, COURSE_B),
    /does not belong to this account and course space/,
  );
  assert.throws(
    () => assertOwnedStudySourceRecord(record, USER_B, COURSE_A),
    /does not belong to this account and course space/,
  );
});

test("cloud source listing filters by owner and course and ignores foreign rows", async () => {
  const filters = {};
  const client = {
    from(table) {
      assert.equal(table, "study_source_files");
      const query = {
        eq(field, value) {
          filters[field] = value;
          return query;
        },
        order(field, options) {
          assert.equal(field, "created_at");
          assert.deepEqual(options, { ascending: false });
          return Promise.resolve({
            data: [
              sourceRow(),
              sourceRow({ course_space_id: COURSE_B, id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }),
              sourceRow({ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", user_id: USER_B }),
            ],
            error: null,
          });
        },
        select() { return query; },
      };
      return query;
    },
    storage: {},
  };

  const records = await listCloudStudySources(client, USER_A, COURSE_A);
  assert.deepEqual(filters, { course_space_id: COURSE_A, user_id: USER_A });
  assert.deepEqual(records.map((record) => record.id), ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]);
});

test("cloud upload uses only the dedicated table and bucket with explicit course metadata", async () => {
  let uploadedPath = "";
  let insertedMetadata = null;
  const client = {
    from(table) {
      assert.equal(table, "study_source_files");
      return {
        insert(metadata) {
          insertedMetadata = { ...metadata };
          return {
            select() {
              return {
                async single() {
                  return {
                    data: sourceRow({
                      ...insertedMetadata,
                      created_at: "2026-08-30T20:00:00.000Z",
                    }),
                    error: null,
                  };
                },
              };
            },
          };
        },
      };
    },
    storage: {
      from(bucket) {
        assert.equal(bucket, STUDY_SOURCE_BUCKET);
        return {
          async upload(path, file, options) {
            uploadedPath = path;
            assert.equal(file.name, "reading.pdf");
            assert.equal(options.upsert, false);
            return { data: { path }, error: null };
          },
        };
      },
    },
  };

  const record = await addCloudStudySource(client, sourceInput(), USER_A);
  assert.equal(uploadedPath.startsWith(`${USER_A}/${COURSE_A}/`), true);
  assert.equal(insertedMetadata.user_id, USER_A);
  assert.equal(insertedMetadata.course_space_id, COURSE_A);
  assert.equal(insertedMetadata.course_code, "MAT 1100");
  assert.equal(insertedMetadata.storage_path, uploadedPath);
  assert.equal(record.profileId, USER_A);
  assert.equal(record.courseSpaceId, COURSE_A);
  assert.equal(record.recordKind, "study-source");
});

test("device-to-cloud source migration is idempotent across retries", async () => {
  let row = null;
  let uploads = 0;
  let upserts = 0;
  const sourceLocalId = "profile_local_12345678:record_local_12345678";
  const client = {
    from(table) {
      assert.equal(table, "study_source_files");
      const query = {
        eq() { return query; },
        async maybeSingle() { return { data: row, error: null }; },
        select() { return query; },
        upsert(metadata, options) {
          upserts += 1;
          assert.deepEqual(options, { onConflict: "user_id,source_local_id" });
          return {
            select() {
              return {
                async single() {
                  row = sourceRow({
                    ...metadata,
                    created_at: "2026-08-30T20:00:00.000Z",
                    id: metadata.id || "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
                  });
                  return { data: row, error: null };
                },
              };
            },
          };
        },
      };
      return query;
    },
    storage: {
      from(bucket) {
        assert.equal(bucket, STUDY_SOURCE_BUCKET);
        return {
          async upload(path, file, options) {
            uploads += 1;
            assert.equal(file.name, "reading.pdf");
            assert.equal(options.upsert, true);
            assert.match(path, new RegExp(`^${USER_A}/${COURSE_A}/migrated_[a-f0-9]{32}/source\\.pdf$`, "u"));
            return { data: { path }, error: null };
          },
        };
      },
    },
  };

  const first = await addCloudStudySource(client, sourceInput(), USER_A, { sourceLocalId });
  const second = await addCloudStudySource(client, sourceInput(), USER_A, { sourceLocalId });
  assert.equal(uploads, 1);
  assert.equal(upserts, 1);
  assert.equal(first.id, second.id);
  assert.equal(first.sourceLocalId, sourceLocalId);
  assert.equal(second.sourceLocalId, sourceLocalId);
});

test("cross-course deletion is rejected before database or storage access", async () => {
  let accessed = false;
  const client = {
    from() { accessed = true; throw new Error("database should not be accessed"); },
    storage: { from() { accessed = true; throw new Error("storage should not be accessed"); } },
  };
  await assert.rejects(
    deleteCloudStudySource(client, sourceRecord(), USER_A, COURSE_B),
    /does not belong to this account and course space/,
  );
  assert.equal(accessed, false);
});

test("cloud deletion removes owned course metadata before its object", async () => {
  const events = [];
  const row = sourceRow();
  const client = {
    from(table) {
      assert.equal(table, "study_source_files");
      return {
        delete() {
          events.push("metadata-delete");
          const query = {
            eq() { return query; },
            select() { return query; },
            async maybeSingle() { return { data: row, error: null }; },
          };
          return query;
        },
      };
    },
    storage: {
      from(bucket) {
        assert.equal(bucket, STUDY_SOURCE_BUCKET);
        return {
          async remove(paths) {
            events.push("object-remove");
            assert.deepEqual(paths, [row.storage_path]);
            return { data: [], error: null };
          },
        };
      },
    },
  };
  assert.equal(await deleteCloudStudySource(client, sourceRecord(), USER_A, COURSE_A), true);
  assert.deepEqual(events, ["metadata-delete", "object-remove"]);
});
