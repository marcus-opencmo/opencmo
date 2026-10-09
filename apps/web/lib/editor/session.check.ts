import assert from "node:assert/strict";

import type { ClipDocument } from "@opencmo/clip-doc";

import { DocumentSession, SaveConflict, type SaveTransport } from "./session";

const doc = (width: number): ClipDocument =>
  ({ version: 1, stage: { children: [{ kind: "scene", id: "s", width, height: 1920, children: [] }] } }) as never;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Call = { version: number; width: number };

function transport(behave: (call: Call) => Promise<void> | void = () => {}) {
  const calls: Call[] = [];
  let version = 1;
  const save: SaveTransport["save"] = async (expected, document) => {
    const call = { version: expected, width: (document.stage.children[0] as { width: number }).width };
    calls.push(call);
    await behave(call);
    version = expected + 1;
    return { version, document_hash: `h${version}` };
  };
  return { calls, save };
}

async function main(): Promise<void> {
  // Lưu gộp: ba lượt sửa sát nhau → một lượt lưu, bản cuối, đúng version.
  {
    const t = transport();
    const session = new DocumentSession({ document: doc(1080), version: 1, documentHash: "h1" }, t, 20);
    session.commit(doc(1000));
    session.commit(doc(1001));
    session.commit(doc(1002));
    assert.equal(session.getState().status, "pending");
    assert.equal(session.getState().documentHash, null, "chưa lưu thì không có hash để Export");
    await wait(60);
    assert.deepEqual(t.calls, [{ version: 1, width: 1002 }]);
    assert.equal(session.getState().status, "saved");
    assert.equal(session.getState().version, 2);
    assert.equal(session.getState().documentHash, "h2");
  }

  // Sửa trong lúc đang lưu → lưu tiếp với version mới, không chen hai lượt.
  {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const t = transport((call) => (call.version === 1 ? gate : undefined));
    const session = new DocumentSession({ document: doc(1080), version: 1, documentHash: null }, t, 5);
    session.commit(doc(1));
    await wait(20);
    assert.equal(session.getState().status, "saving");
    session.commit(doc(2));
    await wait(20);
    assert.equal(t.calls.length, 1, "không có lượt thứ hai khi lượt đầu chưa về");
    release();
    await session.flush();
    assert.deepEqual(t.calls, [{ version: 1, width: 1 }, { version: 2, width: 2 }]);
    assert.equal(session.getState().status, "saved");
  }

  // Undo/Redo: mỗi commit một bước; undo về đúng bản đã lưu thì không lưu gì.
  {
    const t = transport();
    const session = new DocumentSession({ document: doc(1080), version: 1, documentHash: "h1" }, t, 5);
    session.commit(doc(1));
    session.commit(doc(1)); // y hệt → không thành bước
    session.commit(doc(2));
    session.undo();
    assert.equal((session.current.stage.children[0] as { width: number }).width, 1);
    session.undo();
    assert.equal(session.getState().canUndo, false);
    assert.equal(session.getState().status, "saved");
    await wait(20);
    assert.equal(t.calls.length, 0);
    session.redo();
    session.redo();
    assert.equal(session.getState().canRedo, false);
    await session.flush();
    assert.deepEqual(t.calls, [{ version: 1, width: 2 }]);
    session.undo();
    session.commit(doc(3));
    assert.equal(session.getState().canRedo, false, "sửa mới xoá nhánh Redo");
  }

  // history: false — lưu, nhưng không thành bước Undo và không xoá nhánh Redo.
  {
    const t = transport();
    const session = new DocumentSession({ document: doc(1080), version: 1, documentHash: "h1" }, t, 5);
    session.commit(doc(1));
    session.undo();
    session.commit(doc(7), { history: false });
    assert.equal(session.getState().canUndo, false);
    assert.equal(session.getState().canRedo, true);
    await session.flush();
    assert.deepEqual(t.calls, [{ version: 1, width: 7 }]);
  }

  // Manifest lưu cùng lượt với document, nhưng Undo không lùi nó.
  {
    const sent: unknown[] = [];
    const t: SaveTransport = {
      save: async (expected, _document, manifest) => {
        sent.push(manifest);
        return { version: expected + 1, document_hash: "h" };
      },
    };
    const session = new DocumentSession({ document: doc(1080), version: 1, documentHash: "h1", manifest: { assets: [] } }, t, 5);
    session.commit(session.current, { manifest: { assets: [{ id: "a" }] }, history: false });
    assert.equal(session.getState().canUndo, false, "đổi thư viện không là bước Undo");
    await session.flush();
    assert.deepEqual(sent, [{ assets: [{ id: "a" }] }]);
    session.commit(doc(9));
    session.commit(session.current, { manifest: { assets: [{ id: "b" }] }, history: false });
    session.undo();
    assert.deepEqual(session.currentManifest, { assets: [{ id: "b" }] }, "Undo không xoá file vừa nhập");
    assert.equal((session.current.stage.children[0] as { width: number }).width, 1080);
    await session.flush();
    assert.equal(session.getState().status, "saved");
  }

  // 409: dừng lưu, giữ bản trong tab, adopt mới nhận bản server.
  {
    const t = transport(() => {
      throw new SaveConflict({ version: 7, document: doc(640) });
    });
    const session = new DocumentSession({ document: doc(1080), version: 1, documentHash: "h1" }, t, 5);
    session.commit(doc(1));
    await wait(20);
    assert.equal(session.getState().status, "conflict");
    assert.equal((session.current.stage.children[0] as { width: number }).width, 1);
    session.commit(doc(2));
    await wait(20);
    assert.equal(t.calls.length, 1, "xung đột thì không thử lưu lại");
    await assert.rejects(session.flush(), SaveConflict);
    session.adopt(session.conflictWith!.document, session.conflictWith!.version, "h7");
    assert.equal(session.getState().status, "saved");
    assert.equal(session.getState().version, 7);
    assert.equal(session.getState().canUndo, false);
  }

  // Lỗi mạng: giữ bản trong tab, lượt sửa sau thử lại.
  {
    let fail = true;
    const t = transport(() => {
      if (fail) throw new Error("Connection lost. Check your internet and try again.");
    });
    const session = new DocumentSession({ document: doc(1080), version: 1, documentHash: "h1" }, t, 5);
    session.commit(doc(1));
    await wait(20);
    assert.equal(session.getState().status, "error");
    assert.match(session.getState().error ?? "", /Connection lost/);
    fail = false;
    await session.flush();
    assert.equal(session.getState().status, "saved");
    assert.equal(t.calls.length, 2);
  }

  console.log("session.check: ok");
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
