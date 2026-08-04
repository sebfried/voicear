import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const app = read("../scripts/app.ts");
const page = read("../pages/index.astro");
const storage = read("./storage.ts");
const manifest = JSON.parse(read("../../public/manifest.webmanifest"));

const startCamera = app.slice(app.indexOf("const startCameraFromButton"), app.indexOf("const setCameraVisible"));
assert.match(startCamera, /getUserMedia\(\{\s*audio: false,\s*video:/s);
assert.doesNotMatch(app.replace(startCamera, ""), /getUserMedia\(\{\s*audio: false,\s*video:/s);
assert.match(app, /cameraButton\.addEventListener\("click", \(\) => \{ void startCameraFromButton\(\); \}\)/);
assert.match(startCamera, /cameraRequestPending/);
assert.doesNotMatch(app, /name: "start_camera"/);

const takePhoto = app.slice(app.indexOf('name: "take_photo"'), app.indexOf('name: "inspect_camera"'));
assert.doesNotMatch(takePhoto, /addImage|inspectCamera/);
const inspectCamera = app.slice(app.indexOf("const inspectCamera"), app.indexOf("const photoFilename"));
const photoData = app.slice(app.indexOf("const realtimePhotoDataUrl"), app.indexOf("const sendPhotoToAgent"));
const photoSend = app.slice(app.indexOf("const sendPhotoToAgent"), app.indexOf("const inspectCamera"));
const inspectTool = app.slice(app.indexOf('name: "inspect_camera"'), app.indexOf('name: "send_latest_photo"'));
const photoSendTool = app.slice(app.indexOf('name: "send_latest_photo"'), app.indexOf('name: "current_voice"'));
assert.equal(app.match(/\.addImage\(/g)?.length, 2);
assert.match(inspectCamera, /addImage\(dataUrl, \{ triggerResponse: false \}\)/);
assert.doesNotMatch(inspectCamera, /requestResponse\(/);
assert.match(inspectTool, /needsApproval: true/);
assert.match(photoData, /resizeImageBlob/);
assert.match(photoSend, /audioOwnershipVersion === ownershipVersion/);
assert.match(photoSend, /activeChat\.id === chatId/);
assert.match(photoSend, /deletedChatIds\.has\(chatId\)/);
assert.match(photoSend, /deletingPhotoIds\.has\(photoId\)/);
assert.match(photoSend, /liveSession\.transport\.status === "connected"/);
assert.match(photoSend, /addImage\(dataUrl, \{ triggerResponse \}\)/);
assert.match(photoSend, /if \(session === liveSession && photoSendStates\.get\(photoId\) === "sending"\)/);
assert.doesNotMatch(photoSend, /startRealtime|setTimeout/);
assert.match(photoSendTool, /pendingPhotoIdsByCallId\.set\(callId, photo\.id\)/);
assert.match(photoSendTool, /details\?\.toolCall\?\.type === "function_call"/);
assert.match(photoSendTool, /sendPhotoToAgent\(photoId, false\)/);
assert.match(app, /tool_approval_requested/);
assert.match(app, /decidedImageUserItemIds/);
assert.match(app, /if \(userItem && !alreadyDecided\) decidedImageUserItemIds\.add\(userItem\.itemId\)/);
assert.match(app, /"EIN AKTUELLES KAMERABILD EINMALIG AN OPENAI SENDEN\?"/);
assert.match(app, /DAS LOKALE FOTO VOM .* EINMALIG AN OPENAI SENDEN\?/);
assert.match(app, /send\.textContent = "\[ SEND TO AGENT \]"/);
assert.match(app, /NOT SHARED THIS SESSION/);
assert.match(app, /const persistence = unsavedPhotos\.has\(photoId\) \? " · NOT SAVED · DOWNLOAD NOW"/);
assert.match(app, /PHOTO: START VOICE FIRST · NOT SENT/);

const photoDelete = app.slice(app.indexOf('const id = target.closest<HTMLButtonElement>("[data-delete-photo]")'), app.indexOf('setNotice("LOCAL PHOTO DELETED")'));
assert.ok(photoDelete.indexOf("deletingPhotoIds.add(id)") < photoDelete.indexOf("await removePhoto(id)"));
assert.ok(photoDelete.indexOf("pendingPhotoIdsByCallId.delete(callId)") < photoDelete.indexOf("await removePhoto(id)"));

const chatDelete = app.slice(app.indexOf('const id = remove?.dataset.deleteChat'), app.indexOf("olderTranscriptButton.addEventListener"));
assert.ok(chatDelete.indexOf("deletedChatIds.add(id)") < chatDelete.indexOf("await cameraFrameQueue"));
assert.match(chatDelete, /CHAT NOT DELETED[\s\S]*deletedChatIds\.delete\(id\)|deletedChatIds\.delete\(id\)[\s\S]*CHAT NOT DELETED/);

assert.match(storage, /indexedDB\.open\(DB_NAME, 4\)/);
assert.match(storage, /DELETED_CHAT_STORE/);
assert.match(storage, /database\.transaction\(\[CHAT_STORE, DELETED_CHAT_STORE\], "readwrite"\)/);

const realtimeStart = app.slice(app.indexOf("const startRealtime"), app.indexOf("const endRealtime"));
const realtimeEnd = app.slice(app.indexOf("const endRealtime"), app.indexOf("async function pauseVoice"));
assert.match(realtimeStart, /const chatId = activeChat\.id/);
assert.match(realtimeStart, /generation === realtimeGeneration/);
assert.match(realtimeStart, /activeChat\.id === chatId/);
assert.match(realtimeEnd, /realtimeGeneration\+\+/);

assert.match(page, /<video id="camera-feed" autoplay muted playsinline aria-hidden="true">/);
assert.match(page, /img-src 'self' blob:/);
assert.equal(manifest.display, "standalone");

console.log("camera policy checks passed");
