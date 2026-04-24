import { test } from "node:test";
import assert from "node:assert/strict";

// Minimal stubs for `window` + `document` + `Notification`. Each test sets
// the globals it needs, then restores them in the `finally` block. The
// helper only reads `window.Notification`, `document.visibilityState`, and
// `window.focus`, so a narrow fake is enough.

type Permission = "default" | "granted" | "denied";

type NotificationInstance = {
  title: string;
  body?: string;
  tag?: string;
  onclick: null | (() => void);
  close: () => void;
};

function installNotification(opts: {
  permission: Permission;
  requestResult?: Permission;
  requestThrows?: boolean;
  constructorThrows?: boolean;
}) {
  const created: NotificationInstance[] = [];
  const requestCalls: number[] = [];
  class FakeNotification {
    static permission: Permission = opts.permission;
    static async requestPermission(): Promise<Permission> {
      requestCalls.push(Date.now());
      if (opts.requestThrows) throw new Error("request failed");
      return opts.requestResult ?? opts.permission;
    }
    title: string;
    body?: string;
    tag?: string;
    onclick: null | (() => void) = null;
    constructor(title: string, init?: { body?: string; tag?: string }) {
      if (opts.constructorThrows) throw new Error("blocked");
      this.title = title;
      this.body = init?.body;
      this.tag = init?.tag;
      created.push(this as unknown as NotificationInstance);
    }
    close() {}
  }
  (globalThis as any).Notification = FakeNotification;
  return { created, requestCalls, FakeNotification };
}

function installWindow(visibility: "visible" | "hidden") {
  let focused = 0;
  (globalThis as any).window = globalThis;
  (globalThis as any).document = { visibilityState: visibility };
  (globalThis as any).focus = () => { focused++; };
  return { getFocusCount: () => focused };
}

function teardown() {
  delete (globalThis as any).Notification;
  delete (globalThis as any).window;
  delete (globalThis as any).document;
  delete (globalThis as any).focus;
}

async function loadFresh() {
  // Bust the module cache so each test sees fresh bindings against the
  // current globals. Node's ESM loader caches by URL; appending a query
  // yields a fresh module instance.
  const url = new URL("../notifications.ts", import.meta.url);
  url.searchParams.set("t", String(Date.now()) + Math.random());
  return await import(url.href);
}

test("isSupported returns false when Notification is absent", async () => {
  try {
    (globalThis as any).window = globalThis;
    (globalThis as any).document = { visibilityState: "visible" };
    // no Notification
    const mod = await loadFresh();
    assert.equal(mod.isSupported(), false);
  } finally { teardown(); }
});

test("notify is a no-op when unsupported", async () => {
  try {
    (globalThis as any).window = globalThis;
    (globalThis as any).document = { visibilityState: "hidden" };
    const mod = await loadFresh();
    const result = mod.notify({ title: "x", body: "y" });
    assert.equal(result, false);
  } finally { teardown(); }
});

test("notify is a no-op when permission is denied", async () => {
  try {
    installWindow("hidden");
    const { created } = installNotification({ permission: "denied" });
    const mod = await loadFresh();
    const result = mod.notify({ title: "x", body: "y" });
    assert.equal(result, false);
    assert.equal(created.length, 0);
  } finally { teardown(); }
});

test("notify is a no-op when tab is visible", async () => {
  try {
    installWindow("visible");
    const { created } = installNotification({ permission: "granted" });
    const mod = await loadFresh();
    const result = mod.notify({ title: "x", body: "y" });
    assert.equal(result, false);
    assert.equal(created.length, 0);
  } finally { teardown(); }
});

test("notify dispatches when granted + hidden, wires onclick with window.focus + close", async () => {
  try {
    const { getFocusCount } = installWindow("hidden");
    const { created } = installNotification({ permission: "granted" });
    const mod = await loadFresh();
    let customClicked = 0;
    const result = mod.notify({
      title: "Done",
      body: "Partner + customer created",
      onClick: () => { customClicked++; },
    });
    assert.equal(result, true);
    assert.equal(created.length, 1);
    assert.equal(created[0].title, "Done");
    assert.equal(created[0].body, "Partner + customer created");
    assert.equal(created[0].tag, "hsselfservice-create");
    assert.ok(typeof created[0].onclick === "function");
    // Simulate the user clicking the notification.
    created[0].onclick!();
    assert.equal(getFocusCount(), 1);
    assert.equal(customClicked, 1);
  } finally { teardown(); }
});

test("notify swallows constructor errors and returns false", async () => {
  try {
    installWindow("hidden");
    installNotification({ permission: "granted", constructorThrows: true });
    const mod = await loadFresh();
    const result = mod.notify({ title: "x" });
    assert.equal(result, false);
  } finally { teardown(); }
});

test("ensurePermission skips the prompt when permission is granted", async () => {
  try {
    installWindow("hidden");
    const { requestCalls } = installNotification({ permission: "granted" });
    const mod = await loadFresh();
    const result = await mod.ensurePermission();
    assert.equal(result, "granted");
    assert.equal(requestCalls.length, 0);
  } finally { teardown(); }
});

test("ensurePermission skips the prompt when permission is denied", async () => {
  try {
    installWindow("hidden");
    const { requestCalls } = installNotification({ permission: "denied" });
    const mod = await loadFresh();
    const result = await mod.ensurePermission();
    assert.equal(result, "denied");
    assert.equal(requestCalls.length, 0);
  } finally { teardown(); }
});

test("ensurePermission prompts when default and returns the result", async () => {
  try {
    installWindow("hidden");
    const { requestCalls } = installNotification({ permission: "default", requestResult: "granted" });
    const mod = await loadFresh();
    const result = await mod.ensurePermission();
    assert.equal(result, "granted");
    assert.equal(requestCalls.length, 1);
  } finally { teardown(); }
});

test("ensurePermission swallows thrown requestPermission errors", async () => {
  try {
    installWindow("hidden");
    installNotification({ permission: "default", requestThrows: true });
    const mod = await loadFresh();
    const result = await mod.ensurePermission();
    // Falls back to the current value ("default") rather than throwing.
    assert.equal(result, "default");
  } finally { teardown(); }
});

test("ensurePermission returns null when unsupported", async () => {
  try {
    (globalThis as any).window = globalThis;
    (globalThis as any).document = { visibilityState: "visible" };
    const mod = await loadFresh();
    const result = await mod.ensurePermission();
    assert.equal(result, null);
  } finally { teardown(); }
});
