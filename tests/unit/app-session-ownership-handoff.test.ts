/**
 * Controller-level WEBLOCKS-RACE regression (resume-brief item 6): the
 * cross-tab ownership handoff that projects-lifecycle.spec.ts:269 exercises
 * end-to-end, reproduced deterministically on the UA-faithful FakeWebLocks
 * and the asynchronous bus.
 *
 * Covers: takeover handoff via probe ADOPTION (the previously racy path),
 * duplicate/forged release notifications never double-promoting, the
 * former owner re-arming as a waiter and regaining ownership (cooperative
 * handback AND silent crash of the new owner), serialized identity-checked
 * transitions, and full reclamation on dispose (no leaked parked requests).
 */
import { describe, expect, it } from "vitest";
import { AppSessionController } from "../../src/app/session-controller";
import { MemoryBackend, WebLocksOwnershipLock } from "../../src/storage";
import { FakeScheduler } from "./storage-fixtures.test";
import { AsyncBusHub, FakeWebLocks, settle } from "./storage-ownership-fakes.test";

type World = {
  backend: MemoryBackend;
  locks: FakeWebLocks;
  hub: AsyncBusHub;
  scheduler: FakeScheduler;
};

function makeWorld(): World {
  return {
    backend: new MemoryBackend(),
    locks: new FakeWebLocks(),
    hub: new AsyncBusHub(),
    scheduler: new FakeScheduler(),
  };
}

function makeController(world: World): AppSessionController {
  return new AppSessionController({
    backend: world.backend,
    backendKind: "memory",
    ownership: {
      lock: new WebLocksOwnershipLock(world.locks as unknown as LockManager),
      bus: world.hub.connect(),
    },
    timer: world.scheduler.timer,
    now: world.scheduler.clock,
  });
}

const cyan = (value: number) =>
  ({ type: "separation/set-angle", plate: "cyan", angle: value }) as const;

const lockName = (id: string) => `dr-glitch:project:${id}`;

async function openPair(world: World) {
  const tabA = makeController(world);
  const tabB = makeController(world);
  const id = await tabA.createProject();
  await tabA.openProject(id);
  await tabA.performSave("Crosstab");
  const b = await tabB.openProject(id);
  expect(b.readOnly).toBe(true);
  await settle(); // b's crash-release probe parks (FIFO slot 1)
  expect(world.locks.pendingCount(lockName(id))).toBe(1);
  return { tabA, tabB, id };
}

describe("cross-tab takeover on Web Locks + async bus", () => {
  it("a second tab opens read-only and can take ownership (adoption, not re-race)", async () => {
    const world = makeWorld();
    const { tabA, tabB, id } = await openPair(world);

    tabB.requestOwnership();
    await settle(800);

    expect(tabB.getOpenProject()!.readOnly).toBe(false);
    expect(tabA.getOpenProject()!.readOnly).toBe(true);
    // Exactly one holder — the adopted grant; the former owner re-armed as
    // ONE parked waiter for later recovery.
    expect(world.locks.heldCount).toBe(1);
    expect(world.locks.pendingCount(lockName(id))).toBe(1);
    // The new owner edits; the old owner cannot.
    expect(tabB.getOpenProject()!.doc.apply(cyan(66))).toBe(true);
    expect(tabA.getOpenProject()!.doc.apply(cyan(1))).toBe(false);

    await tabB.dispose();
    await tabA.dispose();
    await settle(400);
    expect(world.locks.heldCount).toBe(0);
    expect(world.locks.pendingCount()).toBe(0);
  });

  it("duplicate and forged release notifications never double-promote or steal the lock", async () => {
    const world = makeWorld();
    const { tabA, tabB, id } = await openPair(world);

    // Forged duplicates while tab A still owns: nobody may be promoted and
    // every transient retry probe must be reclaimed.
    const attacker = world.hub.connect();
    attacker.publish({ type: "ownership-released", projectId: id });
    attacker.publish({ type: "ownership-released", projectId: id });
    await settle(800);
    expect(tabA.getOpenProject()!.readOnly).toBe(false);
    expect(tabB.getOpenProject()!.readOnly).toBe(true);
    expect(world.locks.heldCount).toBe(1);
    expect(world.locks.pendingCount(lockName(id))).toBe(1); // only b's probe

    // A real takeover afterwards still lands exactly once, with more
    // duplicates raining around it.
    tabB.requestOwnership();
    attacker.publish({ type: "ownership-released", projectId: id });
    await settle(800);
    attacker.publish({ type: "ownership-released", projectId: id });
    await settle(800);
    expect(tabB.getOpenProject()!.readOnly).toBe(false);
    expect(tabA.getOpenProject()!.readOnly).toBe(true);
    expect(world.locks.heldCount).toBe(1);
    expect(world.locks.pendingCount(lockName(id))).toBe(1);

    await tabB.dispose();
    await tabA.dispose();
    await settle(400);
    expect(world.locks.heldCount).toBe(0);
    expect(world.locks.pendingCount()).toBe(0);
  });

  it("a former owner can request ownership back and sees the new owner's saved work", async () => {
    const world = makeWorld();
    const { tabA, tabB } = await openPair(world);

    tabB.requestOwnership();
    await settle(800);
    expect(tabB.getOpenProject()!.readOnly).toBe(false);

    // The new owner edits and saves before handing back.
    expect(tabB.getOpenProject()!.doc.apply(cyan(72))).toBe(true);
    await tabB.performSave();

    // Former owner requests back: cooperative handback through the bus plus
    // its re-armed parked probe (FIFO: tab A is the only waiter).
    tabA.requestOwnership();
    await settle(800);
    expect(tabA.getOpenProject()!.readOnly).toBe(false);
    expect(tabB.getOpenProject()!.readOnly).toBe(true);
    // Promotion reloaded the envelope: tab A sees tab B's saved edit.
    expect(tabA.getOpenProject()!.store.getEnvelope().core.separation.angles.cyan).toBe(72);
    expect(tabA.getOpenProject()!.casToken).toBe(tabB.getOpenProject()!.casToken);
    expect(world.locks.heldCount).toBe(1);

    await tabA.dispose();
    await tabB.dispose();
    await settle(400);
    expect(world.locks.heldCount).toBe(0);
    expect(world.locks.pendingCount()).toBe(0);
  });

  it("silent crash of the new owner: the re-armed former owner converges back to writer", async () => {
    const world = makeWorld();
    const { tabA, tabB, id } = await openPair(world);

    tabB.requestOwnership();
    await settle(800);
    expect(tabB.getOpenProject()!.readOnly).toBe(false);
    expect(tabA.getOpenProject()!.readOnly).toBe(true);

    // Tab B dies silently: the user agent frees the lock, no bus message
    // is ever sent. Tab A's re-armed probe must adopt the freed lock.
    world.locks.crash(lockName(id));
    await settle(800);
    expect(tabA.getOpenProject()!.readOnly).toBe(false);
    expect(tabA.getOpenProject()!.doc.apply(cyan(9))).toBe(true);
    expect(world.locks.heldCount).toBe(1);

    // The crashed tab is never disposed (it is gone); the survivor cleans up.
    await tabA.dispose();
    await settle(400);
    expect(world.locks.heldCount).toBe(0);
    expect(world.locks.pendingCount()).toBe(0);
  });
});
