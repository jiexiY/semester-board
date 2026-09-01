import test from "node:test";
import assert from "node:assert/strict";

import {
  addCloudSyllabus,
  cloudSyllabusPath,
  createCloudSyllabusUrl,
  deleteCloudSyllabus,
} from "../src/lib/cloudSyllabusStorage.js";

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";

function syllabusInput() {
  return {
    courseName: "Test Course",
    file: {
      lastModified: 0,
      name: "test-course.pdf",
      size: 4,
      type: "application/pdf",
    },
  };
}

function syllabusRow(overrides = {}) {
  return {
    course_name: "Test Course",
    created_at: "2026-08-28T16:00:00.000Z",
    file_name: "test-course.pdf",
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    mime_type: "application/pdf",
    size_bytes: 4,
    source_local_id: null,
    storage_path: `${USER_A}/record_12345678/syllabus.pdf`,
    user_id: USER_A,
    ...overrides,
  };
}

test("cloudSyllabusPath creates an owner-scoped path for a valid Supabase uid", () => {
  assert.equal(
    cloudSyllabusPath(USER_A, "record_12345678", "PDF"),
    `${USER_A}/record_12345678/syllabus.pdf`,
  );
});

test("cloudSyllabusPath rejects traversal in owner, record, or extension", () => {
  assert.throws(
    () => cloudSyllabusPath(`${USER_A}/../${USER_B}`, "record_12345678", "pdf"),
    /valid local profile id/,
  );
  assert.throws(
    () => cloudSyllabusPath(USER_A, "../record_12345678", "pdf"),
    /valid syllabus id/,
  );
  assert.throws(
    () => cloudSyllabusPath(USER_A, "record_12345678/../../foreign", "pdf"),
    /valid syllabus id/,
  );
  assert.throws(
    () => cloudSyllabusPath(USER_A, "record_12345678", "pdf/../txt"),
    /supported syllabus extension/,
  );
});

test("cloudSyllabusPath rejects unsupported syllabus extensions", () => {
  for (const extension of ["exe", "html", "pages", "pdf.exe", ""]) {
    assert.throws(
      () => cloudSyllabusPath(USER_A, "record_12345678", extension),
      /supported syllabus extension/,
      extension,
    );
  }
});

test("private syllabus URL creation rejects a foreign owner before storage access", async () => {
  let storageAccessed = false;
  const client = {
    from() {
      throw new Error("database should not be accessed");
    },
    storage: {
      from() {
        storageAccessed = true;
        throw new Error("storage should not be accessed");
      },
    },
  };
  const foreignRecord = {
    storagePath: `${USER_B}/record_12345678/syllabus.pdf`,
  };

  await assert.rejects(
    createCloudSyllabusUrl(client, foreignRecord, USER_A),
    /does not belong to this account/,
  );
  assert.equal(storageAccessed, false);
});

test("ambiguous metadata save returns the recovered row without removing its object", async () => {
  let insertedMetadata = null;
  let uploadedPath = "";
  let removeCalls = 0;
  const client = {
    from(table) {
      assert.equal(table, "syllabus_files");
      return {
        insert(metadata) {
          insertedMetadata = { ...metadata };
          return {
            select() {
              return {
                async single() {
                  return { data: null, error: new Error("response was interrupted") };
                },
              };
            },
          };
        },
        select() {
          const filters = {};
          const query = {
            eq(field, value) {
              filters[field] = value;
              return query;
            },
            async maybeSingle() {
              assert.equal(filters.user_id, USER_A);
              assert.equal(filters.storage_path, uploadedPath);
              return {
                data: syllabusRow({ ...insertedMetadata, created_at: "2026-08-28T16:00:00.000Z" }),
                error: null,
              };
            },
          };
          return query;
        },
      };
    },
    storage: {
      from(bucket) {
        assert.equal(bucket, "syllabi");
        return {
          async remove() {
            removeCalls += 1;
            return { data: [], error: null };
          },
          async upload(path) {
            uploadedPath = path;
            return { data: { path }, error: null };
          },
        };
      },
    },
  };

  const record = await addCloudSyllabus(client, syllabusInput(), USER_A);

  assert.equal(record.storagePath, uploadedPath);
  assert.equal(record.cloud, true);
  assert.equal(removeCalls, 0);
});

test("ambiguous migrated save falls back to the owner and source id before cleanup", async () => {
  const sourceLocalId = "local-syllabus-123";
  let savedMetadata = null;
  let sourceLookups = 0;
  let removeCalls = 0;
  const client = {
    from() {
      return {
        select() {
          const filters = {};
          const query = {
            eq(field, value) {
              filters[field] = value;
              return query;
            },
            async maybeSingle() {
              if (filters.source_local_id === sourceLocalId) {
                sourceLookups += 1;
                if (sourceLookups === 1) return { data: null, error: null };
                return {
                  data: syllabusRow({ ...savedMetadata, created_at: "2026-08-28T16:00:00.000Z" }),
                  error: null,
                };
              }
              assert.equal(filters.storage_path, savedMetadata.storage_path);
              return { data: null, error: null };
            },
          };
          return query;
        },
        upsert(metadata, options) {
          savedMetadata = { ...metadata };
          assert.deepEqual(options, { onConflict: "user_id,source_local_id" });
          return {
            select() {
              return {
                async single() {
                  return { data: null, error: new Error("response was interrupted") };
                },
              };
            },
          };
        },
      };
    },
    storage: {
      from() {
        return {
          async remove() {
            removeCalls += 1;
            return { data: [], error: null };
          },
          async upload() {
            return { data: {}, error: null };
          },
        };
      },
    },
  };

  const record = await addCloudSyllabus(
    client,
    syllabusInput(),
    USER_A,
    { sourceLocalId },
  );

  assert.equal(record.sourceLocalId, sourceLocalId);
  assert.equal(sourceLookups, 2);
  assert.equal(removeCalls, 0);
});

test("ambiguous metadata save preserves the object when recovery cannot confirm absence", async () => {
  let removeCalls = 0;
  const client = {
    from() {
      return {
        insert() {
          return {
            select() {
              return {
                async single() {
                  return { data: null, error: new Error("response was interrupted") };
                },
              };
            },
          };
        },
        select() {
          const query = {
            eq() {
              return query;
            },
            async maybeSingle() {
              return { data: null, error: new Error("lookup unavailable") };
            },
          };
          return query;
        },
      };
    },
    storage: {
      from() {
        return {
          async remove() {
            removeCalls += 1;
            return { data: [], error: null };
          },
          async upload() {
            return { data: {}, error: null };
          },
        };
      },
    },
  };

  await assert.rejects(
    addCloudSyllabus(client, syllabusInput(), USER_A),
    /upload status could not be confirmed/,
  );
  assert.equal(removeCalls, 0);
});

test("confirmed-absent metadata is checked before an unreferenced upload is removed", async () => {
  const events = [];
  const client = {
    from() {
      return {
        insert() {
          events.push("metadata-save");
          return {
            select() {
              return {
                async single() {
                  return { data: null, error: new Error("metadata rejected") };
                },
              };
            },
          };
        },
        select() {
          const query = {
            eq() {
              return query;
            },
            async maybeSingle() {
              events.push("metadata-recheck");
              return { data: null, error: null };
            },
          };
          return query;
        },
      };
    },
    storage: {
      from() {
        return {
          async remove() {
            events.push("object-remove");
            return { data: [], error: null };
          },
          async upload() {
            events.push("object-upload");
            return { data: {}, error: null };
          },
        };
      },
    },
  };

  await assert.rejects(
    addCloudSyllabus(client, syllabusInput(), USER_A),
    /No library entry was created/,
  );
  assert.deepEqual(events, ["object-upload", "metadata-save", "metadata-recheck", "object-remove"]);
});

test("cloud syllabus deletion removes metadata before the storage object", async () => {
  const events = [];
  const row = syllabusRow();
  const client = {
    from() {
      return {
        delete() {
          events.push("metadata-delete");
          const query = {
            eq() {
              return query;
            },
            select() {
              return query;
            },
            async maybeSingle() {
              return { data: row, error: null };
            },
          };
          return query;
        },
      };
    },
    storage: {
      from() {
        return {
          async remove() {
            events.push("object-remove");
            return { data: [], error: null };
          },
        };
      },
    },
  };

  const removed = await deleteCloudSyllabus(client, {
    id: row.id,
    storagePath: row.storage_path,
  }, USER_A);

  assert.equal(removed, true);
  assert.deepEqual(events, ["metadata-delete", "object-remove"]);
});

test("failed object deletion restores the exact deleted metadata and raises a safe error", async () => {
  const events = [];
  const row = syllabusRow();
  let restoredMetadata = null;
  const client = {
    from() {
      return {
        delete() {
          events.push("metadata-delete");
          const query = {
            eq() {
              return query;
            },
            select() {
              return query;
            },
            async maybeSingle() {
              return { data: row, error: null };
            },
          };
          return query;
        },
        async upsert(metadata, options) {
          events.push("metadata-restore");
          restoredMetadata = metadata;
          assert.deepEqual(options, { onConflict: "id" });
          return { data: null, error: null };
        },
      };
    },
    storage: {
      from() {
        return {
          async remove() {
            events.push("object-remove");
            return { data: null, error: new Error("private storage timeout") };
          },
        };
      },
    },
  };

  await assert.rejects(
    deleteCloudSyllabus(client, {
      id: row.id,
      storagePath: row.storage_path,
    }, USER_A),
    (error) => {
      assert.match(error.message, /library entry was restored/);
      assert.doesNotMatch(error.message, /timeout|private storage/i);
      return true;
    },
  );

  assert.deepEqual(restoredMetadata, row);
  assert.deepEqual(events, ["metadata-delete", "object-remove", "metadata-restore"]);
});

test("metadata deletion failure leaves the storage object untouched", async () => {
  let storageAccessed = false;
  const client = {
    from() {
      return {
        delete() {
          const query = {
            eq() {
              return query;
            },
            select() {
              return query;
            },
            async maybeSingle() {
              return { data: null, error: new Error("database unavailable") };
            },
          };
          return query;
        },
      };
    },
    storage: {
      from() {
        storageAccessed = true;
        throw new Error("storage should not be accessed");
      },
    },
  };

  const row = syllabusRow();
  await assert.rejects(
    deleteCloudSyllabus(client, {
      id: row.id,
      storagePath: row.storage_path,
    }, USER_A),
    /stored file was not changed/,
  );
  assert.equal(storageAccessed, false);
});
