import assert from "node:assert/strict";
import { compareTabClaims, nextTabClaim, parseTabClaim } from "./tab-ownership.ts";

const first = nextTabClaim("a", null);
const second = nextTabClaim("b", first);
assert.deepEqual(first, { tabId: "a", revision: 1 });
assert.deepEqual(second, { tabId: "b", revision: 2 });
assert(compareTabClaims(second, first) > 0);
assert(compareTabClaims({ tabId: "b", revision: 2 }, { tabId: "a", revision: 2 }) > 0);
assert.deepEqual(parseTabClaim(JSON.stringify(second)), second);
assert.equal(parseTabClaim("invalid"), null);
console.log("tab ownership checks passed");
