import assert from "node:assert/strict";
import test from "node:test";

import {
  buildStudySourceIdentityKey,
  createStudySourceIdentityGuard,
  runStudySourceUploadBatch,
} from "../src/lib/studySourceRequests.js";

const PROFILE_A = "profile_a_12345678";
const PROFILE_B = "profile_b_12345678";
const COURSE_A = "course_space_a_12345678";
const COURSE_B = "course_space_b_12345678";

test("identity keys include storage scope, profile, and course space", () => {
  assert.notEqual(
    buildStudySourceIdentityKey({ cloudMode: false, courseSpaceId: COURSE_A, profileId: PROFILE_A }),
    buildStudySourceIdentityKey({ cloudMode: true, courseSpaceId: COURSE_A, profileId: PROFILE_A }),
  );
  assert.notEqual(
    buildStudySourceIdentityKey({ cloudMode: true, courseSpaceId: COURSE_A, profileId: PROFILE_A }),
    buildStudySourceIdentityKey({ cloudMode: true, courseSpaceId: COURSE_A, profileId: PROFILE_B }),
  );
  assert.notEqual(
    buildStudySourceIdentityKey({ cloudMode: true, courseSpaceId: COURSE_A, profileId: PROFILE_A }),
    buildStudySourceIdentityKey({ cloudMode: true, courseSpaceId: COURSE_B, profileId: PROFILE_A }),
  );
});

test("identity guard rejects stale work across profile and A-B-A switches", () => {
  const identityA = buildStudySourceIdentityKey({
    cloudMode: true,
    courseSpaceId: COURSE_A,
    profileId: PROFILE_A,
  });
  const identityB = buildStudySourceIdentityKey({
    cloudMode: true,
    courseSpaceId: COURSE_A,
    profileId: PROFILE_B,
  });
  const guard = createStudySourceIdentityGuard(identityA);
  const originalA = guard.capture();
  assert.equal(guard.isCurrent(originalA), true);

  guard.setIdentity(identityB);
  assert.equal(guard.isCurrent(originalA), false);
  const tokenB = guard.capture();
  assert.equal(guard.isCurrent(tokenB), true);

  guard.setIdentity(identityA);
  const currentA = guard.capture();
  assert.equal(guard.isCurrent(originalA), false, "an old A request cannot revive after A-B-A");
  assert.equal(guard.isCurrent(tokenB), false);
  assert.equal(guard.isCurrent(currentA), true);
  assert.equal(currentA.generation, 2);
});

test("upload queue caps batches at 20 and concurrency at four", async () => {
  const files = Array.from({ length: 25 }, (_, index) => ({ name: `source-${index}.pdf` }));
  let active = 0;
  let maximumActive = 0;
  const calls = [];
  const result = await runStudySourceUploadBatch(files, async (file, index) => {
    calls.push(file);
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active -= 1;
    if (index === 2 || index === 7) throw new Error(`rejected ${index}`);
  });

  assert.equal(calls.length, 20);
  assert.equal(maximumActive, 4);
  assert.deepEqual(result.saved, files.filter((_, index) => index < 20 && index !== 2 && index !== 7));
  assert.deepEqual(result.failed, [files[2], files[7], ...files.slice(20)]);
  assert.equal(result.errors.length, 7);
});

test("upload queue returns the original File objects after partial failure", async () => {
  const first = { name: "first.pdf" };
  const second = { name: "second.docx" };
  const result = await runStudySourceUploadBatch([first, second], async (file) => {
    if (file === second) throw new Error("upload failed");
  });
  assert.equal(result.saved[0], first);
  assert.equal(result.failed[0], second);
});
