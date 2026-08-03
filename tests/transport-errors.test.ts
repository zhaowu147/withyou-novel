import { isTransientTransportError, transportErrorCode, transportErrorMessage } from "../src/lib/ai/transport-errors";
import assert from "node:assert/strict";
import test from "node:test";

test("recognizes a transient undici code nested below gateway wrappers", () => {
  const error = {
    message: "gateway failed",
    cause: {
      message: "fetch failed",
      cause: { message: "other side closed", code: "UND_ERR_SOCKET" },
    },
  };
  assert.equal(transportErrorCode(error), "UND_ERR_SOCKET");
  assert.match(transportErrorMessage(error), /gateway failed: fetch failed: other side closed/);
  assert.equal(isTransientTransportError(error), true);
});

test("does not retry permanent validation errors", () => {
  const error = new Error("[write] API 400: invalid request");
  assert.equal(isTransientTransportError(error), false);
});

test("stops safely on cyclic cause chains", () => {
  const error: { message: string; cause?: unknown } = { message: "terminated" };
  error.cause = error;
  assert.equal(isTransientTransportError(error), true);
});
