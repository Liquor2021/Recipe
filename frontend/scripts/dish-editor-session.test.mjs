import assert from "node:assert/strict"
import test from "node:test"
import { createDishEditorSession, dishEditorRevision } from "../src/lib/dishEditorSession.ts"

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

async function receive(session, ticket, request, apply) {
  try {
    const value = await request
    if (session.acceptsUpload(ticket)) apply(value)
  } finally {
    session.finishUpload(ticket)
  }
}

test("a slower previous main photo cannot replace a newer selection", async () => {
  const session = createDishEditorSession()
  const older = deferred(), newer = deferred()
  let image = "original.jpg"
  const first = receive(session, session.beginUpload("main"), older.promise, (url) => { image = url })
  const second = receive(session, session.beginUpload("main"), newer.promise, (url) => { image = url })
  newer.resolve("latest.jpg")
  await second
  assert.equal(image, "latest.jpg")
  assert.equal(session.beginSave(), false, "old pending uploads must still block saving")
  older.resolve("outdated.jpg")
  await first
  assert.equal(image, "latest.jpg")
  assert.equal(session.beginSave(), true)
})

test("unmount and reload isolate uploads from the next editor session", async () => {
  const oldSession = createDishEditorSession(), nextSession = createDishEditorSession()
  const request = deferred()
  let writes = 0
  const pending = receive(oldSession, oldSession.beginUpload("extra"), request.promise, () => { writes++ })
  oldSession.dispose()
  request.resolve("old-recipe-photo.jpg")
  await pending
  assert.equal(writes, 0)
  assert.equal(nextSession.isBusy(), false)
  assert.equal(oldSession.beginUpload("main"), null)
})

test("a replaced main selection stays authoritative even if it fails", async () => {
  const session = createDishEditorSession()
  const old = session.beginUpload("main"), current = session.beginUpload("main")
  session.finishUpload(current)
  assert.equal(session.acceptsUpload(old), false)
  session.finishUpload(old)
  assert.equal(session.isBusy(), false)
})

test("extra upload queues and saving cannot race or start duplicate work", () => {
  const session = createDishEditorSession()
  const ticket = session.beginUpload("extra")
  assert.equal(session.beginUpload("extra"), null)
  assert.equal(session.beginSave(), false)
  session.finishUpload(ticket)
  assert.equal(session.beginSave(), true)
  assert.equal(session.beginSave(), false)
  assert.equal(session.beginUpload("main"), null)
  session.finishSave()
  assert.notEqual(session.beginUpload("main"), null)
})

test("React cleanup and reactivation never revive an old upload ticket", () => {
  const session = createDishEditorSession()
  const ticket = session.beginUpload("main")
  session.dispose()
  session.activate()
  assert.equal(session.acceptsUpload(ticket), false)
  assert.equal(session.isBusy(), false)
})

test("server revisions detect timestamp or editable changes without treating favorite state as edits", () => {
  const dish = { id: 7, name: "番茄炒蛋", updated_at: "v1", ingredients: [{ name: "番茄", amount: "2个" }], favorite: false }
  const original = dishEditorRevision(dish)
  assert.equal(dishEditorRevision({ ...dish, favorite: true }), original)
  assert.notEqual(dishEditorRevision({ ...dish, updated_at: "v2" }), original)
  assert.notEqual(dishEditorRevision({ ...dish, ingredients: [{ name: "番茄", amount: "3个" }] }), original)
  assert.notEqual(dishEditorRevision({ ...dish, id: 8 }), original)
})
